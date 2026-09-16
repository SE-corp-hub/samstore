// Checkout orchestration — the slice's core transaction path.
// Pure of HTTP; depends only on repository interfaces + domain functions.
// Invariants enforced here (per AGENTS.md):
//   • server-side validation only  • re-price before order creation
//   • no orders on empty cart      • canonical idempotency key → no duplicates
//   • claim token signed, single-use

import type { CheckoutRequest, CheckoutResponse, ApiError } from "@sam-store/contracts";
import { validateCheckoutInput } from "../domain/checkout-validation.js";
import { revalidateCartLines, CartRevalidationError } from "../domain/cart.js";
import { computeOrderTotals, InvalidPriceInputError } from "../domain/pricing.js";
import { taxColumnsFor } from "../domain/tax-store.js";
import { normalizeIdempotencyKey, InvalidIdempotencyKeyError } from "../domain/idempotency.js";
import { formatOrderNumber } from "../domain/order-number.js";
import { InsufficientStockError } from "../domain/movements.js";
import { signClaimToken } from "../domain/claim-token.js";
import type {
  CartRepository,
  CatalogRepository,
  OrderRepository,
  OrderSequenceRepository,
  StoreRepository,
  OrderRecord,
} from "../persistence/repositories.js";
import { randomId } from "../persistence/repositories.js";

export type CheckoutResult = { ok: true; value: CheckoutResponse } | { ok: false; error: ApiError };

/** Optional voucher integration (injected; null in tests that don't need it). */
export interface VoucherGateway {
  validate(storeId: string, code: string, orderTotalMinor: number): Promise<
    { ok: true; discountMinor: number; voucherId: string } | { ok: false; message: string }
  >;
  redeem(orderId: string, storeId: string, voucherId: string): Promise<void>;
}

/** Optional loyalty integration. */
export interface LoyaltyGateway {
  ensureProfile(storeId: string, customerId: string): Promise<{ storeCustomerId: string }>;
  redeem(storeId: string, customerId: string, points: number, orderTotalMinor: number): Promise<
    { ok: true; discountMinor: number; storeCustomerId: string } | { ok: false; message: string }
  >;
  recordRedemption(orderId: string, storeId: string, customerId: string, storeCustomerId: string, points: number): Promise<void>;
}

/** Optional credit (utang) integration — approved customers pay on credit up to limit. */
export interface CreditGateway {
  check(storeId: string, storeCustomerId: string, amountMinor: number): Promise<
    { ok: true } | { ok: false; message: string }
  >;
  record(orderId: string, storeId: string, storeCustomerId: string, amountMinor: number): Promise<void>;
}

/** DI token — explicit, so dependency resolution doesn't rely on emitDecoratorMetadata. */
export const CHECKOUT_SERVICE = Symbol("CHECKOUT_SERVICE");

export class CheckoutService {
  constructor(
    private readonly stores: StoreRepository,
    private readonly catalog: CatalogRepository,
    private readonly carts: CartRepository,
    private readonly orders: OrderRepository,
    private readonly sequences: OrderSequenceRepository,
    private readonly claimSecret: string,
    private readonly onOrderPlaced?: (order: OrderRecord) => Promise<void>,
    private readonly voucher?: VoucherGateway,
    private readonly loyalty?: LoyaltyGateway,
    private readonly resolveCustomer?: (customerToken: string) => Promise<string | null>,
    private readonly credit?: CreditGateway,
  ) {}

  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    // 1. Server-side validation (never trust the client)
    const validation = validateCheckoutInput(request);
    if (!validation.ok) {
      return { ok: false, error: { type: "validation", errors: validation.errors } };
    }

    // 2. Canonical idempotency key — checked BEFORE cart/order state so a retry
    //    after a successful checkout returns the SAME order instead of an error.
    let canonicalKey: string;
    try {
      canonicalKey = normalizeIdempotencyKey(request.idempotencyKey);
    } catch (e) {
      if (e instanceof InvalidIdempotencyKeyError) {
        return { ok: false, error: { type: "validation", errors: [e.message] } };
      }
      throw e;
    }
    const existing = await this.orders.findByIdempotencyKey(canonicalKey);
    if (existing) {
      // Idempotent retry must be bound to the same cart, or the claim token would leak
      // to whoever reuses a key. Mismatch → hard conflict, never a response.
      if (existing.cartToken !== request.cartToken) {
        return {
          ok: false,
          error: { type: "conflict", message: "idempotencyKey was already used for a different cart" },
        };
      }
      return { ok: true, value: this.toResponse(existing) };
    }

    // 3. Load the guest cart
    const cart = await this.carts.findByToken(request.cartToken);
    if (!cart) {
      return { ok: false, error: { type: "not_found", message: "Cart not found" } };
    }
    if (cart.status !== "OPEN") {
      return { ok: false, error: { type: "conflict", message: "Cart is no longer open" } };
    }

    // 4. Store must accept guest orders right now
    const store = await this.stores.findById(cart.storeId);
    if (!store) {
      return { ok: false, error: { type: "not_found", message: "Store not found" } };
    }
    if (store.status !== "ACTIVE") {
      return { ok: false, error: { type: "conflict", message: "This store is not accepting orders right now" } };
    }
    if (store.orderingPaused || !store.guestOrderingEnabled) {
      return {
        ok: false,
        error: {
          type: "conflict",
          message: store.closedStoreMessage ?? "Store is not accepting orders right now",
        },
      };
    }

    // 4b. Optional customer account: resolve token → customer, ensure per-store profile.
    let customerId: string | null = null;
    let storeCustomerId: string | null = null;
    if (request.customerToken) {
      if (!this.resolveCustomer) {
        return { ok: false, error: { type: "unauthorized", message: "Customer accounts are unavailable" } };
      }
      customerId = await this.resolveCustomer(request.customerToken);
      if (!customerId) {
        return { ok: false, error: { type: "unauthorized", message: "Invalid customer token" } };
      }
      if (!this.loyalty) {
        return { ok: false, error: { type: "conflict", message: "Loyalty is unavailable" } };
      }
      const profile = await this.loyalty.ensureProfile(store.id, customerId);
      storeCustomerId = profile.storeCustomerId;
    }

    // 5. Re-price against live catalog (inventory + price changes)
    const freshProducts = await this.catalog.getProductsByIds(
      cart.storeId,
      cart.lines.map((l) => l.productId),
    );
    let revalidated;
    try {
      revalidated = revalidateCartLines(
        cart.lines,
        new Map(
          freshProducts.map((p) => [p.id, { id: p.id, priceMinor: p.priceMinor, isActive: p.isActive }]),
        ),
      );
    } catch (e) {
      if (e instanceof CartRevalidationError) {
        return { ok: false, error: { type: "validation", errors: ["Cart is empty"] } };
      }
      throw e;
    }

    if (revalidated.lines.length === 0) {
      return { ok: false, error: { type: "conflict", message: "All cart items are unavailable" } };
    }
    if (revalidated.priceChanges.length > 0) {
      // Prices were updated; totals below are computed on the NEW prices. The storefront
      // surfaces revalidated.priceChanges to the customer (AGENTS.md: explain changes).
    }

    // 5b. Delivery type (U5): pickup = no fee + no address required.
    const deliveryType = request.deliveryType ?? "delivery";
    const deliveryFee = deliveryType === "pickup" ? 0 : store.deliveryFeeMinor;

    // 6. Server-authoritative totals
    let totals;
    try {
      totals = computeOrderTotals({
        lines: revalidated.lines,
        deliveryFeeMinor: deliveryFee,
      });
    } catch (e) {
      if (e instanceof InvalidPriceInputError) {
        return { ok: false, error: { type: "conflict", message: e.message } };
      }
      throw e;
    }

    if (store.minOrderAmountMinor > 0 && totals.totalMinor < store.minOrderAmountMinor) {
      return {
        ok: false,
        error: { type: "conflict", message: "Total is below the store's minimum order amount" },
      };
    }

    // 6b. Voucher (optional): validate against the pre-discount total, then apply.
    let discountMinor = 0;
    let voucherId: string | null = null;
    if (request.voucherCode && this.voucher) {
      const voucherResult = await this.voucher.validate(store.id, request.voucherCode, totals.totalMinor);
      if (!voucherResult.ok) {
        return { ok: false, error: { type: "conflict", message: voucherResult.message } };
      }
      discountMinor = Math.min(voucherResult.discountMinor, totals.totalMinor);
      voucherId = voucherResult.voucherId;
    }

    // 6c. Loyalty redemption (optional): points → discount.
    let loyaltyPoints = 0;
    if (request.loyaltyPoints && customerId && this.loyalty) {
      const remaining = totals.totalMinor - discountMinor;
      const redeemResult = await this.loyalty.redeem(store.id, customerId, request.loyaltyPoints, remaining);
      if (!redeemResult.ok) {
        return { ok: false, error: { type: "conflict", message: redeemResult.message } };
      }
      loyaltyPoints = request.loyaltyPoints;
      discountMinor += redeemResult.discountMinor;
    }
    const finalTotal = totals.totalMinor - discountMinor;

    // 6d. Payment method: credit requires an approved customer within limit.
    const paymentMethod = request.paymentMethod ?? "cod";
    if (paymentMethod === "credit") {
      if (!storeCustomerId) {
        return { ok: false, error: { type: "validation", errors: ["Credit checkout requires a customer account"] } };
      }
      if (!this.credit) {
        return { ok: false, error: { type: "conflict", message: "Credit is unavailable" } };
      }
      const creditCheck = await this.credit.check(store.id, storeCustomerId, finalTotal);
      if (!creditCheck.ok) {
        return { ok: false, error: { type: "conflict", message: creditCheck.message } };
      }
    }

    // 7. Order number from store-scoped sequence
    const seq = await this.sequences.nextOrderSequence(store.id);
    const orderNumber = formatOrderNumber(store.slug, seq);

    // 8. Immutable line items (names/SKUs snapshot at purchase time)
    const items = revalidated.lines.map((line) => {
      const product = freshProducts.find((p) => p.id === line.productId);
      return {
        productId: product?.id ?? null,
        productName: product?.name ?? "Unknown product",
        sku: product?.sku ?? "UNKNOWN",
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        lineTotalMinor: line.unitPriceMinor * line.quantity,
      };
    });

    // 9. Persist order with immutable snapshot + claim token (persisted so an
    //    idempotent retry after a lost response can return the SAME token).
    const id = randomId();
    const claimToken = signClaimToken(id, this.claimSecret);
    const order: OrderRecord = {
      id,
      orderNumber,
      storeId: store.id,
      status: "RECEIVED",
      currencyCode: store.currencyCode,
      deliveryType,
      subtotalMinor: totals.subtotalMinor,
      deliveryFeeMinor: totals.deliveryFeeMinor,
      discountMinor: discountMinor, // voucher discount (0 when none)
      totalMinor: finalTotal,
      // M4: VAT frozen with the sale — the discount already came off the VATable base, and the
      // delivery fee is excluded from it (decision 2).
      ...(await taxColumnsFor(
        store.id,
        revalidated.lines.map((l: any) => ({ productId: l.productId ?? null, lineTotalMinor: l.lineTotalMinor ?? l.unitPriceMinor * l.quantity })),
        { discountMinor, deliveryFeeMinor: totals.deliveryFeeMinor, settingsOverride: store },
      )),
      snapshot: {
        lines: revalidated.lines,
        items,
        priceChanges: revalidated.priceChanges,
        store: { slug: store.slug, name: store.name },
        paymentMethod,
        deliveryType,
        ...(request.voucherCode ? { voucherCode: request.voucherCode.toUpperCase(), discountMinor } : {}),
        ...(loyaltyPoints > 0 ? { loyaltyPointsRedeemed: loyaltyPoints } : {}),
      },
      paymentMethod,
      paymentStatus: "PENDING",
      idempotencyKey: canonicalKey,
      cartToken: cart.token,
      customerName: request.customerName.trim(),
      customerPhone: request.customerPhone.trim(),
      deliveryAddressLine1: request.deliveryAddressLine1?.trim() ?? "",
      deliveryAddressLine2: request.deliveryAddressLine2?.trim() ?? null,
      landmark: request.landmark?.trim() ?? null,
      deliverySchedule: request.deliverySchedule?.trim() ?? null,
      notes: request.notes?.trim() ?? null,
      claimToken,
      items,
      storeCustomerId,
      createdAt: new Date(),
    };
    let created: OrderRecord;
    if (this.orders.createAtomic) {
      // Module 5: order + stock reserve + cart conversion + voucher/loyalty/credit
      // writes all commit in ONE database transaction — no partial outcomes.
      try {
        created = await this.orders.createAtomic(order, {
          cart: { token: cart.token, storeId: cart.storeId },
          stockReservations: items.map((i) => ({ productId: i.productId ?? "", quantity: i.quantity })),
          ...(voucherId ? { voucherRedemption: { voucherId } } : {}),
          ...(loyaltyPoints > 0 && customerId && storeCustomerId
            ? { loyalty: { customerId, storeCustomerId, points: loyaltyPoints } }
            : {}),
          ...(paymentMethod === "credit" && storeCustomerId
            ? { credit: { storeCustomerId, amountMinor: finalTotal } }
            : {}),
        });
      } catch (e) {
        // P2002 = unique violation on idempotencyKey from a CONCURRENT same-key
        // request. The other request already committed — return its order.
        if ((e as { code?: string }).code === "P2002") {
          const existing = await this.orders.findByIdempotencyKey(canonicalKey);
          if (existing && existing.cartToken === request.cartToken) {
            return { ok: true, value: this.toResponse(existing) };
          }
        }
        // M6: the atomic tx throws these when a row-lock re-check fails under
        // concurrency — surface as a clean conflict, never a 500.
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("Voucher redemption limit") || msg.includes("Insufficient loyalty") || msg.includes("Credit limit") || msg.includes("Credit customer not found")) {
          return { ok: false, error: { type: "conflict", message: msg } };
        }
        // Module 4 fix: the guarded reservation write rejected because availability
        // (onHand - reserved) dropped below the requested quantity mid-flight.
        // This is the "two buyers, one last unit" loser path — a clean conflict.
        if (e instanceof InsufficientStockError) {
          const line = items.find((i) => i.productId === e.productId);
          const label = line?.productName ?? "An item";
          return {
            ok: false,
            error: {
              type: "conflict",
              message: `${label} just went out of stock — please review your cart and try again.`,
            },
          };
        }
        throw e;
      }
    } else {
      // Legacy path (kept for repositories without the atomic primitive).
      created = await this.orders.create(order);
      await this.carts.save({ ...cart, status: "CONVERTED" });
      if (voucherId) {
        await this.voucher!.redeem(created.id, store.id, voucherId);
      }
      if (loyaltyPoints > 0 && customerId && storeCustomerId && this.loyalty) {
        await this.loyalty.recordRedemption(created.id, store.id, customerId, storeCustomerId, loyaltyPoints);
      }
      if (paymentMethod === "credit" && storeCustomerId && this.credit) {
        await this.credit.record(created.id, store.id, storeCustomerId, finalTotal);
      }
    }

    // 10. Notification outbox: the event row is written INSIDE createAtomic's
    //     transaction (see PrismaOrderRepository.createAtomic step 6), so a
    //     committed order always has its event and there is no post-commit
    //     enqueue that could be lost. Nothing to do here.
    if (this.onOrderPlaced) {
      await this.onOrderPlaced(created);
    }

    return {
      ok: true,
      value: {
        orderId: created.id,
        orderNumber: created.orderNumber,
        status: "RECEIVED",
        totalMinor: created.totalMinor,
        currencyCode: created.currencyCode,
        claimToken: created.claimToken!,
      },
    };
  }

  private toResponse(order: OrderRecord): CheckoutResponse {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status as CheckoutResponse["status"],
      totalMinor: order.totalMinor,
      currencyCode: order.currencyCode,
      claimToken: order.claimToken ?? "",
    };
  }
}
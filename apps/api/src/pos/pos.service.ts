// POS (point of sale) — counter sales, V1 staged flow.
// Creates Orders with source="pos". Paths:
//   sell            : immediate cash/utang sale → status COMPLETED (cash: Payment row + change; utang: CreditEntry)
//   hold / complete : staged flow — hold decrements stock (ON_HOLD), complete transitions to COMPLETED
//                     with optional line replacement (resume-edit), void restores stock.
// Totals are always server-computed; stock mutations are atomic.

import { isTracked } from "../domain/stock-tracking.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { deductStock, restoreStock as restoreStockLedger } from "../domain/movements.js";
import { pickDeductionLevel } from "../domain/stock-location.js";
import { RegisterService } from "../registers/register.service.js";
import { PrismaOrderSequenceRepository } from "../persistence/prisma-repositories.js";
import { computeOrderTotals } from "../domain/pricing.js";
import { resolveLinePrice } from "../domain/price-override.js";
import { taxColumnsFor } from "../domain/tax-store.js";
import { saleKey, SellingError } from "../domain/selling.js";
import { Prisma } from "@prisma/client";
import { formatOrderNumber } from "../domain/order-number.js";
import { randomId } from "../persistence/repositories.js";
import { CreditService } from "../credit/credit.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { ensureMethods, prepareTenders, writeTenders } from "../payments/tenders.js";
import type { ApiError, PosSellRequest, PosSellResponse, PosHoldRequest, PosHoldItemsRequest, PosHoldCompleteRequest, PosSellItem, PosTender, PreOrderCreateRequest, PreOrderFinalizeRequest, PreOrderFinalizeResponse } from "@sam-store/contracts";
import { txOptions } from "../persistence/tx-options.js";

export type PosResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const POS_SERVICE = Symbol("POS_SERVICE");

/** The stock identity of a line — all the ledger writers need, and nothing more. */
export interface StockLine { productId: string; variantId: string | null; quantity: number }

export interface LoadedLine {
  productId: string; variantId: string | null; variantName: string | null; quantity: number; unitPriceMinor: number;
  name: string; sku: string;
  /** The catalog/variant price the line was measured against (audit). */
  catalogUnitPriceMinor: number;
  /** True only when staff deliberately sold this line at a different price. */
  priceOverridden: boolean;
  priceOverrideReason: string | null;
  /** Rice Ops M3: served from another location (null = this store's own stock). */
  sourceLocationId?: string | null;
}

export class PosService {
  private readonly sequences = new PrismaOrderSequenceRepository();
  private readonly credit = new CreditService();

  constructor(private readonly loyalty: LoyaltyService, private readonly registers: RegisterService = new RegisterService()) {}

  // ─── shared helpers ───────────────────────────────────────────────────────────────

  private validateItems(items: unknown): items is PosSellItem[] {
    if (!Array.isArray(items) || items.length === 0) return false;
    return items.every((it) => Number.isInteger((it as PosSellItem).quantity) && (it as PosSellItem).quantity > 0 && (it as PosSellItem).quantity <= 99 && typeof (it as PosSellItem).productId === "string");
  }

  /** v4: signature validation for utang sales (data-URL PNG, ≤ 2M chars). */
  private static readonly SIGNATURE_MAX_LENGTH = 2_000_000;
  private isValidSignature(sig: unknown): boolean {
    return typeof sig === "string" && sig.trim().length > 0 && sig.startsWith("data:image/") && sig.trim().length <= PosService.SIGNATURE_MAX_LENGTH;
  }

  /** Load fresh products for a store (active) + validate availability. P2b: variant lines
 *  resolve their own price + stock (variant must belong to the product and be active). */
  private async loadProducts(storeId: string, items: PosSellItem[], opts: { allowRemote?: boolean; allowShort?: boolean } = {}): Promise<PosResult<{ products: any[]; lines: LoadedLine[]; totals: any }>> {
    const ids = items.map((i) => i.productId);
    // Rice Ops M3: a line may be served from another location — immediate sales only.
    const remoteIds = [...new Set(items.map((i) => i.sourceLocationId).filter((x): x is string => typeof x === "string" && x.length > 0))];
    if (remoteIds.length > 0 && !opts.allowRemote) {
      return { ok: false, error: { type: "validation", errors: ["Take from another store is for immediate sales only"] } };
    }
    if (items.some((i) => i.sourceLocationId && i.variantId)) {
      return { ok: false, error: { type: "validation", errors: ["Variant lines cannot be served from another location"] } };
    }
    const remoteLocations = remoteIds.length
      ? await prisma.warehouse.findMany({ where: { storeId, id: { in: remoteIds }, isActive: true }, select: { id: true, name: true } })
      : [];
    if (remoteLocations.length !== remoteIds.length) {
      return { ok: false, error: { type: "validation", errors: ["Unknown or inactive source location"] } };
    }
    const products = await prisma.product.findMany({
      where: { storeId, id: { in: ids }, isActive: true },
      include: { stockLevels: true },
    });
    if (products.length !== new Set(ids).size) {
      return { ok: false, error: { type: "not_found", message: "One or more products not found or inactive" } };
    }
    // Load every referenced variant (tenant-scoped) once.
    const variantIds = [...new Set(items.map((i) => i.variantId).filter((v): v is string => !!v))];
    const variants = variantIds.length > 0
      ? await prisma.productVariant.findMany({ where: { storeId, id: { in: variantIds }, isActive: true } })
      : [];
    const variantMap = new Map(variants.map((v) => [v.id, v]));
    // Rice Ops M1: a counter sale takes stock from THIS store's location (the
    // default), never silently from another store — the same rule deductStock uses.
    const defaultLocation = await prisma.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } });

    for (const it of items) {
      const p = products.find((x) => x.id === it.productId)!;
      if (it.variantId) {
        const v = variantMap.get(it.variantId);
        if (!v || v.productId !== it.productId) {
          return { ok: false, error: { type: "validation", errors: [v ? "Variant does not belong to this product" : "Variant not found or inactive"] } };
        }
        const available = v.quantityOnHand - v.quantityReserved;
        if (available < it.quantity) {
          return { ok: false, error: { type: "conflict", message: `Only ${available} in stock for ${p.name} (${v.name})` } };
        }
      } else if (!isTracked(p)) {
        continue; // Track stock off — sells at any time, nothing to check
      } else if (opts.allowShort && !it.sourceLocationId) {
        continue; // Pre-order / hold: may be taken even when the count is short (it goes below zero)
      } else {
        const remote = it.sourceLocationId && it.sourceLocationId !== defaultLocation?.id ? it.sourceLocationId : null;
        const pick = pickDeductionLevel(p.stockLevels, it.quantity, remote ? { warehouseId: remote, defaultWarehouseId: defaultLocation?.id ?? null } : { defaultWarehouseId: defaultLocation?.id ?? null });
        if (!pick.ok && remote) {
          const where = remoteLocations.find((l) => l.id === remote)?.name ?? "that location";
          const available = pick.reason === "short" ? pick.available : 0;
          return { ok: false, error: { type: "conflict", message: `Only ${available} of ${p.name} at ${where}` } };
        }
        if (!pick.ok) {
          const available = pick.reason === "short" ? pick.available : 0;
          const elsewhere = pick.reason === "untracked" ? 0 : pick.elsewhere;
          return {
            ok: false,
            error: {
              type: "conflict",
              message: `Only ${available} in stock for ${p.name}${elsewhere > 0 ? ` here (${elsewhere} at other locations)` : ""}`,
            },
          };
        }
      }
    }
    // Effective line prices FIRST: the catalog price wins unless staff overrode it,
    // and an override must be bounded + reasoned (domain/price-override). Totals are
    // then derived from the EFFECTIVE prices so a price change is never lost.
    const lines: LoadedLine[] = [];
    for (const it of items) {
      const p = products.find((x) => x.id === it.productId)!;
      const v = it.variantId ? variantMap.get(it.variantId) : null;
      const catalogUnitPriceMinor = v?.priceMinor ?? p.priceMinor;
      let price;
      try {
        price = resolveLinePrice({
          catalogUnitPriceMinor,
          override: it.unitPriceMinorOverride,
          reason: it.priceOverrideReason,
        });
      } catch (e) {
        return { ok: false, error: { type: "validation", errors: [e instanceof Error ? e.message : "Invalid price"] } };
      }
      lines.push({
        productId: p.id,
        variantId: v?.id ?? null,
        variantName: v?.name ?? null,
        quantity: it.quantity,
        unitPriceMinor: price.unitPriceMinor,
        catalogUnitPriceMinor: price.catalogUnitPriceMinor,
        priceOverridden: price.overridden,
        priceOverrideReason: price.reason,
        name: p.name,
        sku: v?.sku ?? p.sku,
        sourceLocationId: !v && it.sourceLocationId && it.sourceLocationId !== defaultLocation?.id ? it.sourceLocationId : null,
      });
    }

    let totals;
    try {
      totals = computeOrderTotals({
        lines: lines.map((l) => ({ unitPriceMinor: l.unitPriceMinor, quantity: l.quantity })),
      });
    } catch (e) {
      return { ok: false, error: { type: "conflict", message: e instanceof Error ? e.message : "Invalid pricing" } };
    }
    return { ok: true, value: { products, lines, totals } };
  }

  /** Decrement stock for a set of lines (prefer default warehouse, then any level) + ledger. */
  private async decrementStock(tx: any, storeId: string, lines: StockLine[], opts: { orderId?: string | null; createdBy?: string | null; allowBelowZero?: boolean } = {}) {
    await deductStock(tx, storeId, lines, { type: "CONSUME", orderId: opts.orderId, createdBy: opts.createdBy, allowBelowZero: opts.allowBelowZero });
  }

  /** Increment stock back for a set of lines (void / cancel) + ledger. */
  private async restoreStock(tx: any, storeId: string, lines: StockLine[], opts: { orderId?: string | null; createdBy?: string | null } = {}) {
    await restoreStockLedger(tx, storeId, lines, { type: "RELEASE", orderId: opts.orderId, createdBy: opts.createdBy });
  }

  private async resolveCustomer(storeId: string, input: { customerId?: string; customerName?: string; customerPhone?: string }): Promise<{ storeCustomerId: string | null; displayName: string }> {
    if (input.customerId) {
      const sc = await prisma.storeCustomer.findFirst({ where: { storeId, id: input.customerId } });
      if (!sc) return { storeCustomerId: null, displayName: "Walk-in" };
      const cust = await prisma.customer.findUnique({ where: { id: sc.customerId } });
      return { storeCustomerId: sc.id, displayName: cust?.name ?? input.customerName ?? "Customer" };
    }
    if (input.customerName) {
      const sc = await this.quickCustomer(storeId, input.customerName, input.customerPhone);
      return { storeCustomerId: sc, displayName: input.customerName };
    }
    return { storeCustomerId: null, displayName: "Walk-in" };
  }

  /** V1: create (or reuse by phone) a store customer without a login account. */
  async quickCustomer(storeId: string, name: string, phone?: string): Promise<string | null> {
    const cleanName = name?.trim();
    if (!cleanName) return null;
    let customer: any = null;
    if (phone?.trim()) {
      customer = await prisma.customer.findFirst({ where: { phone: phone.trim() } });
    }
    if (!customer) {
      customer = await prisma.customer.create({ data: { name: cleanName, phone: phone?.trim() ?? null, email: null, passwordHash: null } });
    }
    const sc = await prisma.storeCustomer.upsert({
      where: { storeId_customerId: { storeId, customerId: customer.id } },
      update: {},
      create: { storeId, customerId: customer.id },
    });
    await cacheBust(cacheKey("customers", storeId));
    return sc.id;
  }

  private async makeOrder(tx: any, storeId: string, actorId: string, data: {
    id: string; orderNumber: string; status: string; paymentMethod: string; paymentStatus: string;
    currencyCode: string; totals: any; storeCustomerId: string | null; customerName: string; lines: LoadedLine[];
    source?: string; discountMinor?: number; totalMinor?: number;
    signatureData?: string | null; signatureAt?: Date | null;
    preorder?: { startAt: string; dueAt: string | null } | null;
    registerSessionId?: string | null; // N1: cash drawer shift this counter sale belongs to
    idempotencyKey?: string | null; // Rice Ops M5: the caller's real key (hashed); default pos_<id>
    sellingLocationId?: string | null; // Rice Ops M5
  }) {
    const discountMinor = data.discountMinor ?? 0;
    const finalTotal = data.totalMinor ?? Math.max(0, data.totals.totalMinor - discountMinor);
    const signatureAt = data.signatureData ? (data.signatureAt ?? new Date()) : null;
    const source = data.source ?? "pos";
    const items = data.lines.map((l) => ({
      productId: l.productId, productName: l.name, sku: l.sku, unitPriceMinor: l.unitPriceMinor,
      variantId: l.variantId, variantName: l.variantName, // P2b
      quantity: l.quantity, lineTotalMinor: l.unitPriceMinor * l.quantity,
      // Counter price override audit — the reason a receipt can explain this price.
      priceOverridden: l.priceOverridden, priceOverrideReason: l.priceOverrideReason,
      catalogUnitPriceMinor: l.catalogUnitPriceMinor,
    }));
    // M4: freeze the VAT breakdown with the sale. POS orders carry no delivery fee, and the
    // discount (voucher/loyalty) is applied to the VATable base before tax.
    const taxCols = await taxColumnsFor(
      storeId,
      items.map((i) => ({ productId: i.productId, lineTotalMinor: i.lineTotalMinor })),
      { discountMinor, deliveryFeeMinor: 0 },
    );
    await tx.order.create({
      data: {
        id: data.id, orderNumber: data.orderNumber, storeId, status: data.status, source,
        currencyCode: data.currencyCode, subtotalMinor: data.totals.subtotalMinor, deliveryFeeMinor: 0,
        discountMinor, totalMinor: finalTotal,
        ...taxCols,
        snapshot: {
          lines: items, source: source.toLowerCase(), paymentMethod: data.paymentMethod,
          ...(discountMinor > 0 ? { discountMinor } : {}),
          ...(data.preorder ? { preorder: { startAt: data.preorder.startAt, dueAt: data.preorder.dueAt } } : {}),
          ...(data.signatureData ? { signature: { capturedAt: signatureAt!.toISOString() } } : {}),
        },
        paymentMethod: data.paymentMethod, paymentStatus: data.paymentStatus,
        idempotencyKey: data.idempotencyKey ?? `pos_${data.id}`, cartToken: "", customerName: data.customerName, customerPhone: "",
        deliveryAddressLine1: "", storeCustomerId: data.storeCustomerId,
        fulfillmentType: "PICKUP", // M3: POS orders are counter/pickup at creation (delivery conversion flips it)
        signatureData: data.signatureData ?? null, signatureAt,
        registerSessionId: data.registerSessionId ?? null, // N1
        sellingLocationId: data.sellingLocationId ?? null,
        occurredAt: new Date(),
      },
    });
    const overriddenAt = new Date();
    await tx.orderItem.createMany({
      data: items.map((i) => ({
        orderId: data.id, storeId, productId: i.productId, productName: i.productName, sku: i.sku,
        variantId: i.variantId ?? null, variantName: i.variantName ?? null, unitPriceMinor: i.unitPriceMinor,
        quantity: i.quantity, lineTotalMinor: i.lineTotalMinor,
        // The audit columns are written ONLY for a deliberate deviation, so a plain
        // sale keeps every column null/false and reports nothing unusual.
        priceOverridden: i.priceOverridden,
        priceOverrideReason: i.priceOverrideReason,
        priceOverriddenById: i.priceOverridden ? actorId : null,
        priceOverriddenAt: i.priceOverridden ? overriddenAt : null,
        catalogUnitPriceMinor: i.priceOverridden ? i.catalogUnitPriceMinor : null,
      })),
    });
    await tx.orderStatusHistory.create({ data: { orderId: data.id, storeId, toStatus: data.status, actorType: "pos", actorId: actorId } });
  }

  // ─── immediate sale ───────────────────────────────────────────────────────────────

  /**
   * M1: the tenders that settle this sale. When the caller sends an explicit list it wins;
   * otherwise the legacy single-method input becomes a one-row tender list, so existing
   * clients (and the UI until M1.3) behave exactly as before.
   */
  private tenderList(
    input: { paymentMethod: "cash" | "credit"; tenderedMinor?: number; tenders?: PosTender[] },
    totalMinor: number,
  ): PosTender[] {
    if (Array.isArray(input.tenders) && input.tenders.length > 0) return input.tenders;
    return input.paymentMethod === "cash"
      ? [{ methodCode: "cash", amountMinor: totalMinor, tenderedMinor: input.tenderedMinor ?? totalMinor }]
      : [{ methodCode: "credit", amountMinor: totalMinor }];
  }

  /** Which kinds of money this sale involves — drives the drawer gate and signature rule. */
  private async tenderKinds(
    storeId: string,
    input: { paymentMethod: "cash" | "credit"; tenders?: PosTender[] },
    tenders: PosTender[],
  ): Promise<{ hasCash: boolean; hasCredit: boolean }> {
    const explicit = Array.isArray(input.tenders) && input.tenders.length > 0;
    if (!explicit) {
      return { hasCash: input.paymentMethod === "cash", hasCredit: input.paymentMethod === "credit" };
    }
    const methods = await ensureMethods(storeId);
    const kindOf = new Map(methods.map((m) => [m.code, m.kind as string]));
    const codes = tenders.map((t) => (t.methodCode ?? "").trim().toLowerCase());
    return { hasCash: codes.some((c) => kindOf.get(c) === "CASH"), hasCredit: codes.some((c) => kindOf.get(c) === "CREDIT") };
  }

  /**
   * M1: validate the tender list for a counter sale (which must settle in full) and return
   * the plan the transaction writes. Throws nothing — callers map the error.
   */
  private async prepareCounterTenders(
    storeId: string,
    orderId: string,
    input: { paymentMethod: "cash" | "credit"; tenderedMinor?: number; tenders?: PosTender[] },
    totalMinor: number,
    storeCustomerId: string | null,
  ) {
    return prepareTenders({
      storeId,
      orderId,
      targetMinor: totalMinor,
      storeCustomerId,
      tenders: this.tenderList(input, totalMinor),
      requireFullCoverage: true, // a counter sale is settled on the spot
    });
  }

  /** Rice Ops M5: the sale already made with this key (a double-tap or a retry), as the same response. */
  private async replaySale(storeId: string, key: string): Promise<PosSellResponse | null> {
    const o = await prisma.order.findFirst({
      where: { storeId, idempotencyKey: key },
      include: { payments: { select: { changeMinor: true } }, stockTransfers: { select: { id: true, docNumber: true } } },
    });
    if (!o) return null;
    const releases = o.stockTransfers.map((t) => ({ id: t.id, docNumber: t.docNumber ?? "" }));
    return {
      orderId: o.id, orderNumber: o.orderNumber, status: "COMPLETED", totalMinor: o.totalMinor, currencyCode: o.currencyCode,
      paymentMethod: (o.paymentMethod === "credit" ? "credit" : "cash"), changeMinor: o.payments.reduce((s, p) => s + (p.changeMinor ?? 0), 0),
      ...(releases.length ? { releases } : {}),
    };
  }

  async sell(storeId: string, actorId: string, input: PosSellRequest): Promise<PosResult<PosSellResponse>> {
    // Rice Ops M5: a real idempotency key — the same key never makes a second sale.
    let key: string | null = null;
    if (input.idempotencyKey !== undefined) {
      try {
        key = saleKey(storeId, input.idempotencyKey);
      } catch (e) {
        return { ok: false, error: { type: "validation", errors: [e instanceof SellingError ? e.message : "invalid idempotencyKey"] } };
      }
      const earlier = await this.replaySale(storeId, key);
      if (earlier) return { ok: true, value: earlier };
    }
    try {
      return await this.sellOnce(storeId, actorId, input, key);
    } catch (e) {
      // Two taps raced past the check: the unique key let exactly one commit — return it.
      if (key && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && JSON.stringify(e.meta?.target ?? "").includes("idempotencyKey")) {
        const won = await this.replaySale(storeId, key);
        if (won) return { ok: true, value: won };
      }
      throw e;
    }
  }

  private async sellOnce(storeId: string, actorId: string, input: PosSellRequest, key: string | null): Promise<PosResult<PosSellResponse>> {
    if (!this.validateItems(input.items)) {
      return { ok: false, error: { type: "validation", errors: ["At least one item with positive quantity is required"] } };
    }
    if (!["cash", "credit"].includes(input.paymentMethod)) {
      return { ok: false, error: { type: "validation", errors: ["paymentMethod must be cash or credit"] } };
    }
    if (input.paymentMethod === "cash" && input.tenderedMinor !== undefined && !Number.isInteger(input.tenderedMinor)) {
      return { ok: false, error: { type: "validation", errors: ["tenderedMinor must be an integer"] } };
    }

    const loaded = await this.loadProducts(storeId, input.items, { allowRemote: true });
    if (!loaded.ok) return loaded;
    const { products, lines, totals } = loaded.value;
    const localLines = lines.filter((l) => !l.sourceLocationId);
    const remoteLines = lines.filter((l) => l.sourceLocationId);
    const sellingLocation = remoteLines.length ? await prisma.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } }) : null;
    if (remoteLines.length && !sellingLocation) {
      return { ok: false, error: { type: "conflict", message: "Set a default location before selling from another location" } };
    }

    const { storeCustomerId: custId, displayName } = await this.resolveCustomer(storeId, input);
    if (input.paymentMethod === "credit" && !custId) {
      return { ok: false, error: { type: "validation", errors: ["Credit sales require a linked customer"] } };
    }

    // M1: the tender list decides what this sale touches — cash money needs an open
    // drawer shift; a credit tender needs the customer's signature.
    const orderedTenders = this.tenderList(input, 0); // amounts are recomputed once the total is known
    const kinds = await this.tenderKinds(storeId, input, orderedTenders);
    let registerSessionId: string | null = null;
    if (kinds.hasCash) {
      const session = await this.registers.requireOpenSession(storeId);
      if (!session.ok) return { ok: false, error: { type: "conflict", message: session.error.message } };
      registerSessionId = session.value;
    }

    // v4: utang sales require a captured signature (data-URL PNG).
    if (kinds.hasCredit && !this.isValidSignature(input.signatureData)) {
      return { ok: false, error: { type: "validation", errors: ["Signature is required for credit sales"] } };
    }

    // v4: loyalty redemption — credit sales with a linked customer only (checkout pattern).
    let discountMinor = 0;
    let loyaltyRedeemed = 0;
    let loyaltyCustomerId: string | null = null;
    if (input.loyaltyPoints) {
      if (input.paymentMethod !== "credit" || !custId) {
        return { ok: false, error: { type: "validation", errors: ["Loyalty redemption requires a credit sale with a linked customer"] } };
      }
      const sc = await prisma.storeCustomer.findUnique({ where: { id: custId } });
      if (!sc) return { ok: false, error: { type: "conflict", message: "Customer not found in this store" } };
      loyaltyCustomerId = sc.customerId;
      const redeemResult = await this.loyalty.redeem(storeId, sc.customerId, input.loyaltyPoints, totals.totalMinor);
      if (!redeemResult.ok) {
        return { ok: false, error: { type: "conflict", message: redeemResult.message } };
      }
      loyaltyRedeemed = input.loyaltyPoints;
      discountMinor += redeemResult.discountMinor;
    }
    const finalTotal = Math.max(0, totals.totalMinor - discountMinor);

    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    const seq = await this.sequences.nextOrderSequence(storeId);
    const orderNumber = formatOrderNumber(store.slug, seq, { prefix: store.settings?.orderNumberPrefix ?? undefined });
    const id = randomId();

    // M1: validate the tender list before opening the transaction (a counter sale settles in full).
    const prepared = await this.prepareCounterTenders(storeId, id, input, finalTotal, custId);
    if (!prepared.ok) return prepared;
    const plan = prepared.value;

    let changeMinor = 0;
    const releases: { id: string; docNumber: string }[] = [];
    const defaultLocationId = sellingLocation?.id ?? (await prisma.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } }))?.id ?? null;
    await prisma.$transaction(async (tx) => {
      await this.makeOrder(tx, storeId, actorId, {
        id, orderNumber, status: "COMPLETED", paymentMethod: input.paymentMethod,
        paymentStatus: kinds.hasCredit ? "PENDING" : "COLLECTED",
        currencyCode: store.currencyCode, totals, storeCustomerId: custId, customerName: displayName, lines,
        discountMinor, totalMinor: finalTotal,
        signatureData: kinds.hasCredit ? input.signatureData : null,
        registerSessionId,
        idempotencyKey: key,
        sellingLocationId: defaultLocationId,
      });
      if (plan.hasCash) changeMinor = plan.changeMinor;
      await writeTenders(tx, {
        storeId, orderId: id, actorId, plan,
        note: plan.prepared.length > 1 ? `POS sale (${plan.prepared.length} tenders)` : "POS cash sale",
        registerSessionId,
        creditTerms: { startAt: input.startAt, dueAt: input.dueAt },
      });
      if (localLines.length) await this.decrementStock(tx, storeId, localLines, { orderId: id, createdBy: actorId });
      // Lines served from another location leave that location at once (no release step).
      for (const l of remoteLines) {
        await deductStock(tx, storeId, [{ productId: l.productId, quantity: l.quantity }], { type: "CONSUME", orderId: id, createdBy: actorId, warehouseId: l.sourceLocationId!, documentType: "SALE", documentId: id });
      }
    }, txOptions());

    // v4: record the redemption only after the order exists (checkout pattern).
    if (loyaltyRedeemed > 0 && loyaltyCustomerId && custId) {
      await this.loyalty.recordRedemption(id, storeId, loyaltyCustomerId, custId, loyaltyRedeemed);
    }
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("orders", storeId));

    return {
      ok: true,
      value: {
        orderId: id, orderNumber, status: "COMPLETED", totalMinor: finalTotal,
        currencyCode: store.currencyCode, paymentMethod: input.paymentMethod, changeMinor,
        ...(loyaltyRedeemed > 0 ? { loyaltyPointsRedeemed: loyaltyRedeemed } : {}),
        ...(releases.length ? { releases } : {}),
      },
    };
  }

  // ─── hold / staged flow ───────────────────────────────────────────────────────────

  async hold(storeId: string, actorId: string, input: PosHoldRequest): Promise<PosResult<{ orderId: string; orderNumber: string; totalMinor: number }>> {
    if (!this.validateItems(input.items)) {
      return { ok: false, error: { type: "validation", errors: ["At least one item with positive quantity is required"] } };
    }
    const loaded = await this.loadProducts(storeId, input.items);
    if (!loaded.ok) return loaded;
    const { storeCustomerId: custId, displayName } = await this.resolveCustomer(storeId, input);
    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    const seq = await this.sequences.nextOrderSequence(storeId);
    const orderNumber = formatOrderNumber(store.slug, seq, { prefix: store.settings?.orderNumberPrefix ?? undefined });
    const id = randomId();
    const { lines, totals } = loaded.value;

    await prisma.$transaction(async (tx) => {
      await this.makeOrder(tx, storeId, actorId, {
        id, orderNumber, status: "ON_HOLD", paymentMethod: "cash", paymentStatus: "PENDING",
        currencyCode: store.currencyCode, totals, storeCustomerId: custId, customerName: displayName, lines,
      });
      await this.decrementStock(tx, storeId, lines, { orderId: id, createdBy: actorId });
    }, txOptions());
    return { ok: true, value: { orderId: id, orderNumber, totalMinor: totals.totalMinor } };
  }

  /** W2: convert a completed POS sale into a delivery order (address required).
      Payment was already captured at the counter: cash → COLLECTED (paid), credit → PENDING (utang). */
  async markForDelivery(
    storeId: string,
    actorId: string,
    orderId: string,
    input: { addressLine1?: string; landmark?: string },
  ): Promise<PosResult<{ id: string; status: string; orderNumber: string }>> {
    const address = input.addressLine1?.trim() ?? "";
    if (address.length < 3) {
      return { ok: false, error: { type: "validation", errors: ["Delivery address (min 3 chars) is required"] } };
    }
    const order = await prisma.order.findFirst({ where: { storeId, id: orderId, source: "pos" } });
    if (!order) return { ok: false, error: { type: "not_found", message: "POS sale not found" } };
    if (order.status !== "COMPLETED") {
      return { ok: false, error: { type: "conflict", message: `Only completed POS sales can be marked for delivery (status: ${order.status})` } };
    }
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "OUT_FOR_DELIVERY",
          deliveryType: "delivery",
          fulfillmentType: "DELIVERY", // M3: POS sale converted to delivery
          deliveryAddressLine1: address,
          ...(input.landmark?.trim() ? { landmark: input.landmark.trim() } : {}),
        },
      });
      await tx.orderStatusHistory.create({
        data: { orderId, storeId, fromStatus: "COMPLETED", toStatus: "OUT_FOR_DELIVERY", reason: "POS sale marked for delivery", actorType: "pos", actorId },
      });
    }, txOptions());
    await cacheBust(cacheKey("orders", storeId));
    return { ok: true, value: { id: orderId, status: "OUT_FOR_DELIVERY", orderNumber: order.orderNumber } };
  }

  async listHolds(storeId: string) {
    return prisma.order.findMany({
      where: { storeId, status: "ON_HOLD", source: "pos" },
      orderBy: { createdAt: "desc" },
      include: {
        items: { select: { productId: true, productName: true, sku: true, unitPriceMinor: true, quantity: true, lineTotalMinor: true } },
        storeCustomer: { include: { customer: { select: { name: true } } } },
      },
    }).then((rows) => rows.map((o) => ({
      id: o.id, orderNumber: o.orderNumber, totalMinor: o.totalMinor, customerName: o.customerName,
      storeCustomerId: o.storeCustomerId, createdAt: o.createdAt, items: o.items,
    })));
  }

  // ─── pre-orders (v4) ──────────────────────────────────────────────────────────────

  /** v4: create a pre-order draft — customer REQUIRED, stock reserved (ON_HOLD + source=PRE_ORDER). */
  async createPreOrder(storeId: string, actorId: string, input: PreOrderCreateRequest): Promise<PosResult<{ orderId: string; orderNumber: string; status: string; totalMinor: number; currencyCode: string }>> {
    if (!this.validateItems(input.items)) {
      return { ok: false, error: { type: "validation", errors: ["At least one item with positive quantity is required"] } };
    }
    const loaded = await this.loadProducts(storeId, input.items, { allowShort: true });
    if (!loaded.ok) return loaded;
    const { storeCustomerId: custId, displayName } = await this.resolveCustomer(storeId, input);
    if (!custId) {
      return { ok: false, error: { type: "validation", errors: ["Pre-orders require a linked customer"] } };
    }
    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    const seq = await this.sequences.nextOrderSequence(storeId);
    const orderNumber = formatOrderNumber(store.slug, seq, { prefix: store.settings?.orderNumberPrefix ?? undefined });
    const id = randomId();
    const { lines, totals } = loaded.value;

    await prisma.$transaction(async (tx) => {
      await this.makeOrder(tx, storeId, actorId, {
        id, orderNumber, status: "ON_HOLD", source: "PRE_ORDER", paymentMethod: "credit", paymentStatus: "PENDING",
        currencyCode: store.currencyCode, totals, storeCustomerId: custId, customerName: displayName, lines,
        preorder: { startAt: input.startAt ?? new Date().toISOString(), dueAt: input.dueAt ?? null },
      });
      await this.decrementStock(tx, storeId, lines, { orderId: id, createdBy: actorId, allowBelowZero: true });
    }, txOptions());
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("orders", storeId));
    return { ok: true, value: { orderId: id, orderNumber, status: "ON_HOLD", totalMinor: totals.totalMinor, currencyCode: store.currencyCode } };
  }

  /** v4: list pre-order drafts (optional createdAt from/to ISO filters). */
  async listPreorders(storeId: string, from?: string, to?: string) {
    return prisma.order.findMany({
      where: {
        storeId, source: "PRE_ORDER",
        ...(from || to ? { createdAt: { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        // variantId/variantName + the override audit travel back so the Edit modal
        // can re-send the exact same lines (and show why a price was changed).
        items: { select: { productId: true, productName: true, sku: true, variantId: true, variantName: true, unitPriceMinor: true, quantity: true, lineTotalMinor: true, priceOverridden: true, priceOverrideReason: true } },
        storeCustomer: { include: { customer: { select: { name: true } } } },
      },
    }).then((rows) => rows.map((o) => ({
      id: o.id, orderNumber: o.orderNumber, customerName: o.customerName, storeCustomerId: o.storeCustomerId,
      status: o.status, totalMinor: o.totalMinor, createdAt: o.createdAt,
      dueAt: (o.snapshot as any)?.preorder?.dueAt ?? null,
      items: o.items,
    })));
  }

  /** v4: finalize a pre-order — utang only, signature REQUIRED → COMPLETED + CreditEntry. */
  async finalizePreorder(storeId: string, actorId: string, id: string, input: PreOrderFinalizeRequest): Promise<PosResult<PreOrderFinalizeResponse>> {
    const order = await prisma.order.findFirst({ where: { storeId, id, source: "PRE_ORDER", status: "ON_HOLD" } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Pre-order not found" } };
    const method = input.paymentMethod === "cash" ? "cash" : "credit";
    const hasSig = typeof input.signatureData === "string" && input.signatureData.trim().length > 0;
    if (method === "credit" && !hasSig) {
      return { ok: false, error: { type: "validation", errors: ["Signature is required"] } };
    }
    const signatureData = hasSig ? input.signatureData!.trim() : null;
    if (signatureData && (!signatureData.startsWith("data:image/") || signatureData.length > PosService.SIGNATURE_MAX_LENGTH)) {
      return { ok: false, error: { type: "validation", errors: ["Invalid signature"] } };
    }
    if (!order.storeCustomerId) {
      return { ok: false, error: { type: "validation", errors: ["Pre-orders require a linked customer"] } };
    }
    const finalTotal = order.totalMinor;
    const signatureAt = new Date();
    // Fall back to the pre-order's agreed dates when the finalize request omits them.
    const pre = (order.snapshot as any)?.preorder ?? null;
    const startAt = input.startAt ?? pre?.startAt;
    const dueAt = input.dueAt ?? pre?.dueAt;
    let creditEntryId = "";
    if (method === "cash") {
      // Paid in cash at finalize: the money goes in the drawer (needs an open shift only when the store requires one).
      const session = await this.registers.requireOpenSession(storeId);
      if (!session.ok) return { ok: false, error: { type: "conflict", message: session.error.message } };
      const prepared = await this.prepareCounterTenders(storeId, id, { paymentMethod: "cash", tenderedMinor: input.tenderedMinor }, finalTotal, order.storeCustomerId);
      if (!prepared.ok) return prepared;
      const plan = prepared.value;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.order.update({ where: { id }, data: { status: "COMPLETED", paymentStatus: "COLLECTED", paymentMethod: "cash", signatureData, signatureAt: signatureData ? signatureAt : null, registerSessionId: session.value } });
          await writeTenders(tx, { storeId, orderId: id, actorId, plan, note: "Pre-order paid in cash", registerSessionId: session.value });
          await tx.orderStatusHistory.create({ data: { orderId: id, storeId, fromStatus: "ON_HOLD", toStatus: "COMPLETED", actorType: "pos_finalize", actorId } });
        }, txOptions());
      } catch (e) {
        await cacheBust(cacheKey("orders", storeId));
        return { ok: false, error: { type: "conflict", message: e instanceof Error ? e.message : "Could not finalize the pre-order" } };
      }
      await cacheBust(cacheKey("orders", storeId));
      return {
        ok: true,
        value: { orderId: id, orderNumber: order.orderNumber, status: "COMPLETED", totalMinor: finalTotal, currencyCode: order.currencyCode, creditEntryId: "", signatureAt: signatureAt.toISOString(), paymentMethod: "cash", changeMinor: plan.hasCash ? plan.changeMinor : 0 },
      };
    }
    try {
      await prisma.$transaction(async (tx) => {
        const cr = await this.credit.sellOnCredit(tx as never, storeId, order.storeCustomerId!, id, finalTotal, actorId, { startAt, dueAt });
        // Mapped below into a clean conflict — an uncaught throw here surfaced as a
        // 500 "Internal server error" that told staff nothing about the real reason.
        if (!cr.ok) throw new Error("message" in cr.error ? cr.error.message : "Credit declined");
        await tx.order.update({
          where: { id },
          data: { status: "COMPLETED", paymentStatus: "PENDING", signatureData, signatureAt },
        });
        const entry = await tx.creditEntry.findFirst({ where: { orderId: id }, orderBy: { createdAt: "desc" } });
        creditEntryId = entry?.id ?? "";
        await tx.orderStatusHistory.create({
          data: { orderId: id, storeId, fromStatus: "ON_HOLD", toStatus: "COMPLETED", actorType: "pos_finalize", actorId },
        });
      }, txOptions());
    } catch (e) {
      // The transaction rolled back, so the draft is untouched: report the reason the
      // way every other counter command does (409 + a message the UI can show).
      const message = e instanceof Error ? e.message : "Could not finalize the pre-order";
      await cacheBust(cacheKey("orders", storeId));
      return { ok: false, error: { type: "conflict", message } };
    }
    await cacheBust(cacheKey("orders", storeId));
    return {
      ok: true,
      value: {
        orderId: id, orderNumber: order.orderNumber, status: "COMPLETED", totalMinor: finalTotal,
        currencyCode: order.currencyCode, creditEntryId, signatureAt: signatureAt.toISOString(),
      },
    };
  }

  /**
   * Replace the lines of an ON_HOLD counter order (POS hold or pre-order draft).
   * `opts.source` scopes which kind of draft this route may edit, so a POS hold can
   * never be re-priced through the pre-order route (and vice versa). Line prices come
   * from loadProducts, which honours a bounded + reasoned counter override.
   */
  async replaceItems(storeId: string, actorId: string, holdId: string, input: PosHoldItemsRequest, opts?: { source?: "pos" | "PRE_ORDER" }): Promise<PosResult<{ id: string; totalMinor: number; lines: LoadedLine[] }>> {
    if (!this.validateItems(input.items)) {
      return { ok: false, error: { type: "validation", errors: ["At least one item with positive quantity is required"] } };
    }
    const hold = await prisma.order.findFirst({ where: { storeId, id: holdId, status: "ON_HOLD", ...(opts?.source ? { source: opts.source } : {}) } });
    if (!hold) {
      return {
        ok: false,
        error: { type: "not_found", message: opts?.source === "PRE_ORDER" ? "Pre-order not found" : "Held order not found" },
      };
    }

    const loaded = await this.loadProducts(storeId, input.items, { allowShort: opts?.source === "PRE_ORDER" });
    if (!loaded.ok) return loaded;
    // Only the stock identity of the previous lines matters here (restore delta).
    const oldLines = (await prisma.orderItem.findMany({ where: { orderId: holdId } })).map((i) => ({
      productId: i.productId ?? "", variantId: i.variantId ?? null, quantity: i.quantity,
    }));
    const { lines, totals } = loaded.value;
    // M4: a re-price changes the VAT base — re-freeze it instead of keeping the
    // columns from the previous total (the receipt prints these).
    const taxCols = await taxColumnsFor(
      storeId,
      lines.map((l) => ({ productId: l.productId, lineTotalMinor: l.unitPriceMinor * l.quantity })),
      { discountMinor: hold.discountMinor, deliveryFeeMinor: 0 },
    );
    const overriddenAt = new Date();

    await prisma.$transaction(async (tx) => {
      // Restore stock for removed lines, decrement for added (delta approach).
      await this.restoreStock(tx, storeId, oldLines, { orderId: holdId, createdBy: actorId });
      await this.decrementStock(tx, storeId, lines, { orderId: holdId, createdBy: actorId, allowBelowZero: opts?.source === "PRE_ORDER" });
      await tx.orderItem.deleteMany({ where: { orderId: holdId } });
      await tx.orderItem.createMany({
        data: lines.map((l) => ({
          orderId: holdId, storeId, productId: l.productId, productName: l.name, sku: l.sku,
          // The variant identity must survive an edit, or a variant line silently
          // becomes a plain product line.
          variantId: l.variantId, variantName: l.variantName,
          unitPriceMinor: l.unitPriceMinor, quantity: l.quantity, lineTotalMinor: l.unitPriceMinor * l.quantity,
          priceOverridden: l.priceOverridden,
          priceOverrideReason: l.priceOverrideReason,
          priceOverriddenById: l.priceOverridden ? actorId : null,
          priceOverriddenAt: l.priceOverridden ? overriddenAt : null,
          catalogUnitPriceMinor: l.priceOverridden ? l.catalogUnitPriceMinor : null,
        })),
      });
      await tx.order.update({ where: { id: holdId }, data: { subtotalMinor: totals.subtotalMinor, totalMinor: totals.totalMinor, snapshot: { lines, source: hold.source.toLowerCase(), paymentMethod: hold.paymentMethod } as object, ...taxCols } });
      await tx.orderStatusHistory.create({ data: { orderId: holdId, storeId, fromStatus: "ON_HOLD", toStatus: "ON_HOLD", reason: "items edited", actorType: "pos", actorId: actorId } });
    }, txOptions());
    return { ok: true, value: { id: holdId, totalMinor: totals.totalMinor, lines } };
  }

  async completeHold(storeId: string, actorId: string, holdId: string, input: PosHoldCompleteRequest): Promise<PosResult<PosSellResponse>> {
    // Payment can be taken on any on-process order (hold, confirmed, preparing, ready) — paid orders skip to COMPLETED.
    const hold = await prisma.order.findFirst({ where: { storeId, id: holdId, status: { in: ["ON_HOLD", "CONFIRMED", "PREPARING", "READY"] } } });
    if (!hold) return { ok: false, error: { type: "not_found", message: "Held order not found" } };
    if (!["cash", "credit"].includes(input.paymentMethod)) {
      return { ok: false, error: { type: "validation", errors: ["paymentMethod must be cash or credit"] } };
    }

    // Optional resume-edit: replace lines first.
    let totalMinor = hold.totalMinor;
    let lines: LoadedLine[] = [];
    if (input.items) {
      const replaced = await this.replaceItems(storeId, actorId, holdId, { items: input.items }, { source: "pos" });
      if (!replaced.ok) return replaced;
      totalMinor = replaced.value.totalMinor;
      lines = replaced.value.lines;
    } else {
      const items = await prisma.orderItem.findMany({ where: { orderId: holdId } });
      // Re-read the STORED prices so completing a hold never re-prices it, and carry
      // the override audit forward.
      lines = items.map((i) => ({
        productId: i.productId ?? "", variantId: i.variantId ?? null, variantName: i.variantName ?? null,
        quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, name: i.productName, sku: i.sku,
        catalogUnitPriceMinor: i.catalogUnitPriceMinor ?? i.unitPriceMinor,
        priceOverridden: i.priceOverridden, priceOverrideReason: i.priceOverrideReason,
      }));
    }

    const { storeCustomerId: custId, displayName } = input.paymentMethod === "credit"
      ? await this.resolveCustomer(storeId, input)
      : await this.resolveCustomer(storeId, { customerId: input.customerId, customerName: hold.customerName });
    if (input.paymentMethod === "credit" && !custId) {
      return { ok: false, error: { type: "validation", errors: ["Credit sales require a linked customer"] } };
    }

    // v4: utang sales require a captured signature (data-URL PNG).
    if (input.paymentMethod === "credit" && !this.isValidSignature(input.signatureData)) {
      return { ok: false, error: { type: "validation", errors: ["Signature is required for credit sales"] } };
    }

    // M1: the tender list decides what this holds touches — cash needs an open shift.
    const probeTenders = this.tenderList(input, 0); // amounts are computed once the total is known
    const kinds = await this.tenderKinds(storeId, input, probeTenders);
    let registerSessionId: string | null = null;
    if (kinds.hasCash) {
      const session = await this.registers.requireOpenSession(storeId);
      if (!session.ok) return { ok: false, error: { type: "conflict", message: session.error.message } };
      registerSessionId = session.value;
    }

    // v4: loyalty redemption — credit sales with a linked customer only (checkout pattern).
    let discountMinor = 0;
    let loyaltyRedeemed = 0;
    let loyaltyCustomerId: string | null = null;
    if (input.loyaltyPoints) {
      if (input.paymentMethod !== "credit" || !custId) {
        return { ok: false, error: { type: "validation", errors: ["Loyalty redemption requires a credit sale with a linked customer"] } };
      }
      const sc = await prisma.storeCustomer.findUnique({ where: { id: custId } });
      if (!sc) return { ok: false, error: { type: "conflict", message: "Customer not found in this store" } };
      loyaltyCustomerId = sc.customerId;
      const redeemResult = await this.loyalty.redeem(storeId, sc.customerId, input.loyaltyPoints, totalMinor);
      if (!redeemResult.ok) {
        return { ok: false, error: { type: "conflict", message: redeemResult.message } };
      }
      loyaltyRedeemed = input.loyaltyPoints;
      discountMinor += redeemResult.discountMinor;
    }
    const finalTotal = Math.max(0, totalMinor - discountMinor);
    // M1: validate the tender list before opening the transaction.
    const prepared = await this.prepareCounterTenders(storeId, holdId, input, finalTotal, custId);
    if (!prepared.ok) return prepared;
    const plan = prepared.value;
    const signatureAt = new Date();

    let changeMinor = 0;
    let finalStatus: "COMPLETED" | "OUT_FOR_DELIVERY" = "COMPLETED";
    await prisma.$transaction(async (tx) => {
      if (plan.hasCash) changeMinor = plan.changeMinor;
      await writeTenders(tx, {
        storeId, orderId: holdId, actorId, plan,
        note: plan.prepared.length > 1 ? `POS sale (${plan.prepared.length} tenders, held)` : "POS cash sale (held)",
        registerSessionId,
        creditTerms: { startAt: input.startAt, dueAt: input.dueAt },
      });
      const cur = await tx.order.findUnique({ where: { id: holdId }, select: { snapshot: true } });
      // Send-for-delivery: staff collected payment at the counter for a delivery-tagged order
      // → route it into the delivery pipeline (OUT_FOR_DELIVERY) instead of completing it.
      // The reliable delivery signal is a real address — deliveryType defaults to "delivery"
      // in the schema, so POS holds (no address) are counter sales, never auto-routed.
      const isDelivery = Boolean(hold.deliveryAddressLine1?.trim());
      finalStatus = input.sendForDelivery === true && isDelivery ? "OUT_FOR_DELIVERY" : "COMPLETED";
      await tx.order.update({
        where: { id: holdId },
        data: {
          status: finalStatus,
          fulfillmentType: finalStatus === "OUT_FOR_DELIVERY" ? "DELIVERY" : "PICKUP", // M3: explicit
          paymentMethod: input.paymentMethod,
          paymentStatus: kinds.hasCredit ? "PENDING" : "COLLECTED",
          customerName: displayName,
          storeCustomerId: custId,
          discountMinor,
          totalMinor: finalTotal,
          ...(input.paymentMethod === "credit"
            ? { signatureData: input.signatureData, signatureAt }
            : {}),
          ...(registerSessionId ? { registerSessionId } : {}),
          snapshot: {
            ...(cur?.snapshot && typeof cur.snapshot === "object" ? cur.snapshot as Record<string, unknown> : {}),
            ...(input.paymentMethod === "credit" && input.signatureData ? { signature: { capturedAt: signatureAt.toISOString() } } : {}),
          },
        },
      });
      await tx.orderStatusHistory.create({ data: { orderId: holdId, storeId, fromStatus: hold.status, toStatus: finalStatus, reason: input.sendForDelivery === true && isDelivery ? "paid at counter → send for delivery" : null, actorType: "pos", actorId: actorId } });
    }, txOptions());

    // v4: record loyalty redemption after the order exists (checkout pattern).
        if (loyaltyRedeemed > 0 && loyaltyCustomerId && custId) {
          await this.loyalty.recordRedemption(holdId, storeId, loyaltyCustomerId, custId, loyaltyRedeemed);
        }
        await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("orders", storeId));

        return {
          ok: true,
          value: {
            orderId: holdId, orderNumber: hold.orderNumber, status: finalStatus, totalMinor: finalTotal,
            currencyCode: hold.currencyCode, paymentMethod: input.paymentMethod, changeMinor,
            ...(loyaltyRedeemed > 0 ? { loyaltyPointsRedeemed: loyaltyRedeemed } : {}),
          },
        };
      }

  async voidHold(storeId: string, actorId: string, holdId: string, reason?: string): Promise<PosResult<{ id: string; status: string }>> {
    const hold = await prisma.order.findFirst({ where: { storeId, id: holdId, status: "ON_HOLD" } });
    if (!hold) return { ok: false, error: { type: "not_found", message: "Held order not found" } };
    const items = await prisma.orderItem.findMany({ where: { orderId: holdId } });
    const lines: StockLine[] = items.map((i) => ({ productId: i.productId ?? "", variantId: i.variantId ?? null, quantity: i.quantity }));

    await prisma.$transaction(async (tx) => {
      await this.restoreStock(tx, storeId, lines, { orderId: holdId, createdBy: actorId });
      await tx.order.update({ where: { id: holdId }, data: { status: "CANCELLED", paymentStatus: "CANCELLED_REFUND" } });
      await tx.orderStatusHistory.create({
        data: { orderId: holdId, storeId, fromStatus: "ON_HOLD", toStatus: "CANCELLED", reason: reason?.trim() ?? null, actorType: "pos_void", actorId: actorId },
      });
    }, txOptions());
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("orders", storeId));
    return { ok: true, value: { id: holdId, status: "CANCELLED" } };
  }
}
// POS (point of sale) — counter sales, V1 staged flow.
// Creates Orders with source="pos". Paths:
//   sell            : immediate cash/utang sale → status COMPLETED (cash: Payment row + change; utang: CreditEntry)
//   hold / complete : staged flow — hold decrements stock (ON_HOLD), complete transitions to COMPLETED
//                     with optional line replacement (resume-edit), void restores stock.
// Totals are always server-computed; stock mutations are atomic.

import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { deductStock, restoreStock as restoreStockLedger } from "../domain/movements.js";
import { RegisterService } from "../registers/register.service.js";
import { PrismaOrderSequenceRepository } from "../persistence/prisma-repositories.js";
import { computeOrderTotals } from "../domain/pricing.js";
import { taxColumnsFor } from "../domain/tax-store.js";
import { formatOrderNumber } from "../domain/order-number.js";
import { randomId } from "../persistence/repositories.js";
import { CreditService } from "../credit/credit.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { ensureMethods, prepareTenders, writeTenders } from "../payments/tenders.js";
import type { ApiError, PosSellRequest, PosSellResponse, PosHoldRequest, PosHoldItemsRequest, PosHoldCompleteRequest, PosSellItem, PosTender, PreOrderCreateRequest, PreOrderFinalizeRequest, PreOrderFinalizeResponse } from "@sam-store/contracts";

export type PosResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const POS_SERVICE = Symbol("POS_SERVICE");

export interface LoadedLine { productId: string; variantId: string | null; variantName: string | null; quantity: number; unitPriceMinor: number; name: string; sku: string }

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
  private async loadProducts(storeId: string, items: PosSellItem[]): Promise<PosResult<{ products: any[]; lines: LoadedLine[]; totals: any }>> {
    const ids = items.map((i) => i.productId);
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
      } else {
        const available = p.stockLevels.reduce((s, l) => s + (l.quantityOnHand - l.quantityReserved), 0);
        if (available < it.quantity) {
          return { ok: false, error: { type: "conflict", message: `Only ${available} in stock for ${p.name}` } };
        }
      }
    }
    let totals;
    try {
      totals = computeOrderTotals({
        lines: items.map((it) => {
          const p = products.find((x) => x.id === it.productId)!;
          const v = it.variantId ? variantMap.get(it.variantId) : null;
          return { unitPriceMinor: v?.priceMinor ?? p.priceMinor, quantity: it.quantity };
        }),
      });
    } catch (e) {
      return { ok: false, error: { type: "conflict", message: e instanceof Error ? e.message : "Invalid pricing" } };
    }
    const lines: LoadedLine[] = items.map((it) => {
      const p = products.find((x) => x.id === it.productId)!;
      const v = it.variantId ? variantMap.get(it.variantId) : null;
      return { productId: p.id, variantId: v?.id ?? null, variantName: v?.name ?? null, quantity: it.quantity, unitPriceMinor: v?.priceMinor ?? p.priceMinor, name: p.name, sku: v?.sku ?? p.sku };
    });
    return { ok: true, value: { products, lines, totals } };
  }

  /** Decrement stock for a set of lines (prefer default warehouse, then any level) + ledger. */
  private async decrementStock(tx: any, storeId: string, lines: LoadedLine[], opts: { orderId?: string | null; createdBy?: string | null } = {}) {
    await deductStock(tx, storeId, lines, { type: "CONSUME", orderId: opts.orderId, createdBy: opts.createdBy });
  }

  /** Increment stock back for a set of lines (void / cancel) + ledger. */
  private async restoreStock(tx: any, storeId: string, lines: LoadedLine[], opts: { orderId?: string | null; createdBy?: string | null } = {}) {
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
  }) {
    const discountMinor = data.discountMinor ?? 0;
    const finalTotal = data.totalMinor ?? Math.max(0, data.totals.totalMinor - discountMinor);
    const signatureAt = data.signatureData ? (data.signatureAt ?? new Date()) : null;
    const source = data.source ?? "pos";
    const items = data.lines.map((l) => ({
      productId: l.productId, productName: l.name, sku: l.sku, unitPriceMinor: l.unitPriceMinor,
      variantId: l.variantId, variantName: l.variantName, // P2b
      quantity: l.quantity, lineTotalMinor: l.unitPriceMinor * l.quantity,
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
        idempotencyKey: `pos_${data.id}`, cartToken: "", customerName: data.customerName, customerPhone: "",
        deliveryAddressLine1: "", storeCustomerId: data.storeCustomerId,
        fulfillmentType: "PICKUP", // M3: POS orders are counter/pickup at creation (delivery conversion flips it)
        signatureData: data.signatureData ?? null, signatureAt,
        registerSessionId: data.registerSessionId ?? null, // N1
      },
    });
    await tx.orderItem.createMany({
      data: items.map((i) => ({ orderId: data.id, storeId, productId: i.productId, productName: i.productName, sku: i.sku, variantId: i.variantId ?? null, variantName: i.variantName ?? null, unitPriceMinor: i.unitPriceMinor, quantity: i.quantity, lineTotalMinor: i.lineTotalMinor })),
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

  async sell(storeId: string, actorId: string, input: PosSellRequest): Promise<PosResult<PosSellResponse>> {
    if (!this.validateItems(input.items)) {
      return { ok: false, error: { type: "validation", errors: ["At least one item with positive quantity is required"] } };
    }
    if (!["cash", "credit"].includes(input.paymentMethod)) {
      return { ok: false, error: { type: "validation", errors: ["paymentMethod must be cash or credit"] } };
    }
    if (input.paymentMethod === "cash" && input.tenderedMinor !== undefined && !Number.isInteger(input.tenderedMinor)) {
      return { ok: false, error: { type: "validation", errors: ["tenderedMinor must be an integer"] } };
    }

    const loaded = await this.loadProducts(storeId, input.items);
    if (!loaded.ok) return loaded;
    const { products, lines, totals } = loaded.value;

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

    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    const seq = await this.sequences.nextOrderSequence(storeId);
    const orderNumber = formatOrderNumber(store.slug, seq);
    const id = randomId();

    // M1: validate the tender list before opening the transaction (a counter sale settles in full).
    const prepared = await this.prepareCounterTenders(storeId, id, input, finalTotal, custId);
    if (!prepared.ok) return prepared;
    const plan = prepared.value;

    let changeMinor = 0;
    await prisma.$transaction(async (tx) => {
      await this.makeOrder(tx, storeId, actorId, {
        id, orderNumber, status: "COMPLETED", paymentMethod: input.paymentMethod,
        paymentStatus: kinds.hasCredit ? "PENDING" : "COLLECTED",
        currencyCode: store.currencyCode, totals, storeCustomerId: custId, customerName: displayName, lines,
        discountMinor, totalMinor: finalTotal,
        signatureData: kinds.hasCredit ? input.signatureData : null,
        registerSessionId,
      });
      if (plan.hasCash) changeMinor = plan.changeMinor;
      await writeTenders(tx, {
        storeId, orderId: id, actorId, plan,
        note: plan.prepared.length > 1 ? `POS sale (${plan.prepared.length} tenders)` : "POS cash sale",
        registerSessionId,
        creditTerms: { startAt: input.startAt, dueAt: input.dueAt },
      });
      await this.decrementStock(tx, storeId, lines, { orderId: id, createdBy: actorId });
    }, { timeout: 30_000 });

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
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    const seq = await this.sequences.nextOrderSequence(storeId);
    const orderNumber = formatOrderNumber(store.slug, seq);
    const id = randomId();
    const { lines, totals } = loaded.value;

    await prisma.$transaction(async (tx) => {
      await this.makeOrder(tx, storeId, actorId, {
        id, orderNumber, status: "ON_HOLD", paymentMethod: "cash", paymentStatus: "PENDING",
        currencyCode: store.currencyCode, totals, storeCustomerId: custId, customerName: displayName, lines,
      });
      await this.decrementStock(tx, storeId, lines, { orderId: id, createdBy: actorId });
    }, { timeout: 30_000 });
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
    }, { timeout: 30_000 });
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
    const loaded = await this.loadProducts(storeId, input.items);
    if (!loaded.ok) return loaded;
    const { storeCustomerId: custId, displayName } = await this.resolveCustomer(storeId, input);
    if (!custId) {
      return { ok: false, error: { type: "validation", errors: ["Pre-orders require a linked customer"] } };
    }
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    const seq = await this.sequences.nextOrderSequence(storeId);
    const orderNumber = formatOrderNumber(store.slug, seq);
    const id = randomId();
    const { lines, totals } = loaded.value;

    await prisma.$transaction(async (tx) => {
      await this.makeOrder(tx, storeId, actorId, {
        id, orderNumber, status: "ON_HOLD", source: "PRE_ORDER", paymentMethod: "credit", paymentStatus: "PENDING",
        currencyCode: store.currencyCode, totals, storeCustomerId: custId, customerName: displayName, lines,
        preorder: { startAt: input.startAt ?? new Date().toISOString(), dueAt: input.dueAt ?? null },
      });
      await this.decrementStock(tx, storeId, lines, { orderId: id, createdBy: actorId });
    }, { timeout: 30_000 });
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
        items: { select: { productId: true, productName: true, sku: true, unitPriceMinor: true, quantity: true, lineTotalMinor: true } },
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
    if (typeof input.signatureData !== "string" || input.signatureData.trim().length === 0) {
      return { ok: false, error: { type: "validation", errors: ["Signature is required"] } };
    }
    const signatureData = input.signatureData.trim();
    if (!signatureData.startsWith("data:image/") || signatureData.length > PosService.SIGNATURE_MAX_LENGTH) {
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
    await prisma.$transaction(async (tx) => {
      const cr = await this.credit.sellOnCredit(tx as never, storeId, order.storeCustomerId!, id, finalTotal, actorId, { startAt, dueAt });
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
    }, { timeout: 30_000 });
    await cacheBust(cacheKey("orders", storeId));
    return {
      ok: true,
      value: {
        orderId: id, orderNumber: order.orderNumber, status: "COMPLETED", totalMinor: finalTotal,
        currencyCode: order.currencyCode, creditEntryId, signatureAt: signatureAt.toISOString(),
      },
    };
  }

  async replaceItems(storeId: string, actorId: string, holdId: string, input: PosHoldItemsRequest): Promise<PosResult<{ id: string; totalMinor: number; lines: LoadedLine[] }>> {
    if (!this.validateItems(input.items)) {
      return { ok: false, error: { type: "validation", errors: ["At least one item with positive quantity is required"] } };
    }
    const hold = await prisma.order.findFirst({ where: { storeId, id: holdId, status: "ON_HOLD" } });
    if (!hold) return { ok: false, error: { type: "not_found", message: "Held order not found" } };

    const loaded = await this.loadProducts(storeId, input.items);
    if (!loaded.ok) return loaded;
    const oldItems = await prisma.orderItem.findMany({ where: { orderId: holdId } });
    const oldLines: LoadedLine[] = oldItems.map((i) => ({ productId: i.productId ?? "", variantId: i.variantId ?? null, variantName: i.variantName ?? null, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, name: i.productName, sku: i.sku }));
    const { lines, totals } = loaded.value;

    await prisma.$transaction(async (tx) => {
      // Restore stock for removed lines, decrement for added (delta approach).
      await this.restoreStock(tx, storeId, oldLines, { orderId: holdId, createdBy: actorId });
      await this.decrementStock(tx, storeId, lines, { orderId: holdId, createdBy: actorId });
      await tx.orderItem.deleteMany({ where: { orderId: holdId } });
      await tx.orderItem.createMany({
        data: lines.map((l) => ({
          orderId: holdId, storeId, productId: l.productId, productName: l.name, sku: l.sku,
          unitPriceMinor: l.unitPriceMinor, quantity: l.quantity, lineTotalMinor: l.unitPriceMinor * l.quantity,
        })),
      });
      await tx.order.update({ where: { id: holdId }, data: { subtotalMinor: totals.subtotalMinor, totalMinor: totals.totalMinor, snapshot: { lines, source: "pos", paymentMethod: "cash" } as object } });
      await tx.orderStatusHistory.create({ data: { orderId: holdId, storeId, fromStatus: "ON_HOLD", toStatus: "ON_HOLD", reason: "items edited", actorType: "pos", actorId: actorId } });
    }, { timeout: 30_000 });
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
      const replaced = await this.replaceItems(storeId, actorId, holdId, { items: input.items });
      if (!replaced.ok) return replaced;
      totalMinor = replaced.value.totalMinor;
      lines = replaced.value.lines;
    } else {
      const items = await prisma.orderItem.findMany({ where: { orderId: holdId } });
      lines = items.map((i) => ({ productId: i.productId ?? "", variantId: i.variantId ?? null, variantName: i.variantName ?? null, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, name: i.productName, sku: i.sku }));
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
    }, { timeout: 30_000 });

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
    const lines: LoadedLine[] = items.map((i) => ({ productId: i.productId ?? "", variantId: i.variantId ?? null, variantName: i.variantName ?? null, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, name: i.productName, sku: i.sku }));

    await prisma.$transaction(async (tx) => {
      await this.restoreStock(tx, storeId, lines, { orderId: holdId, createdBy: actorId });
      await tx.order.update({ where: { id: holdId }, data: { status: "CANCELLED", paymentStatus: "CANCELLED_REFUND" } });
      await tx.orderStatusHistory.create({
        data: { orderId: holdId, storeId, fromStatus: "ON_HOLD", toStatus: "CANCELLED", reason: reason?.trim() ?? null, actorType: "pos_void", actorId: actorId },
      });
    }, { timeout: 30_000 });
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("orders", storeId));
    return { ok: true, value: { id: holdId, status: "CANCELLED" } };
  }
}
// Rice Ops M5 — Benta: the counter sale at one location, plus the manual entries that
// keep the ledger whole when reality gets ahead of the system.
//
//   sell        sack by piece, loose rice by kilo or by peso; cash, GCash or utang;
//               the location's own price; lines may come from another location
//               (held there, released on its Ilabas list — M3); a paper slip keeps
//               its real time and number. ONE sale per idempotency key, even when
//               two taps race (the unique key decides; the loser replays the winner).
//   manualItem  Bagong item: a product created at the counter with what is on hand
//               now (signed Manual na pasok), sellable at once, Susuriin until the
//               owner confirms (Para sa iyo) or merges it into an existing product.
//   stockIn     Manual na pasok: supplier stock without a purchase order, signed.
//   merge       the owner folds a manual item into a real product, stock converted
//               by weight through the ledger.
//
// Totals are server-computed. Stock leaves the selling location in the same
// transaction as the order, its payment and its signatures.

import { blendedCost, costModeOf, recordCostIn, shelfCostFor } from "../domain/shelf-cost.js";
import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { PrismaOrderSequenceRepository } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import { addForTrip, deductStock, InsufficientStockError, recordMovement, releaseForTrip, reserveForTrip, unreserveForTrip, type TripLeg } from "../domain/movements.js";
import { chargeSale } from "../payable/charges.js";
import { seesCost } from "../domain/cost-redact.js";
import { applyReceipt, loadOpenOrder } from "../purchase-orders/receive.js";
import { coverShortage, deductWithBuffer } from "../domain/buffer.js";
import { formatOrderNumber } from "../domain/order-number.js";
import { resolveLinePrice, PriceOverrideError } from "../domain/price-override.js";
import { taxColumnsFor } from "../domain/tax-store.js";
import { checkPaperSlip, isLoose, mergeQuantity, planManualItem, priceAt, priceLine, saleKey, SellingError, shortMessage, type ManualItemAsk, type PricedLine } from "../domain/selling.js";
import { formatKilos } from "../domain/weight.js";
import { limitCheck, pesoText, saleText } from "../domain/utang.js";
import { CreditService } from "../credit/credit.service.js";
import { queueSms } from "../sms/sms.service.js";
import { wakeOutbox } from "../notifications/outbox.service.js";
import { prepareTenders, writeTenders } from "../payments/tenders.js";
import {
  captureSignatures, locationRefusal, nextDocNumber, registerApprovalHandler, requestApproval, requireSignatures, signatureErrorResult,
  type Actor, type SignatureInput,
} from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";

export type BentaResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
type Tx = Prisma.TransactionClient;

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("benta step refused");
  }
}
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });
const notFound = (m: string) => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

export interface BentaLineInput {
  productId?: string;
  quantity?: unknown;
  kilos?: unknown;
  grams?: unknown;
  amountMinor?: unknown;
  /** Kunin sa ibang tindahan: serve this line from another location. */
  sourceLocationId?: string;
  /** Manual na presyo: a bounded, reasoned override of the unit price (per piece / per kilo). */
  unitPriceMinorOverride?: unknown;
  priceOverrideReason?: string;
}

export type PayMethod = "cash" | "gcash" | "maya" | "bank" | "split" | "utang";

export interface BentaInput {
  idempotencyKey?: unknown;
  locationId?: string;
  lines?: BentaLineInput[];
  payment?: { method?: string; tenderedMinor?: unknown; reference?: string; tenders?: { method?: string; amountMinor?: unknown; tenderedMinor?: unknown; reference?: string }[] };
  /** Utang: the store customer (StoreCustomer id). */
  customerId?: string;
  /** Optional name on a cash sale. */
  customerName?: string;
  signatures?: SignatureInput[];
  /** Galing sa papel: encode a paper slip (number + the real time it happened). */
  paperSlip?: { slipNo?: unknown; occurredAt?: unknown };
}

export interface BentaSaleView {
  /** COMPLETED, or WAITING_OWNER: utang over the limit — the stock is held until the owner decides. */
  status: "COMPLETED" | "WAITING_OWNER" | "DECLINED";
  approvalId: string | null;
  /** The utang text: QUEUED (sending), SKIPPED (no mobile number), or null (no text for this sale). */
  smsStatus: string | null;
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  changeMinor: number;
  paymentMethod: PayMethod;
  locationId: string;
  occurredAt: string;
  encodedLater: boolean;
  /** True when this key was already used: the earlier sale is returned, nothing new happened. */
  replayed: boolean;
  lines: { productId: string; name: string; soldBy: string | null; quantity: number; grams: number | null; unitPriceMinor: number; lineTotalMinor: number; enteredAmountMinor: number | null; sourceLocationId: string | null }[];
  releases: { id: string; docNumber: string }[];
  /** Rice Ops M8 — the zero check: items this sale emptied here ("May natira pa ba?"). */
  zeroCheck: { productId: string; name: string }[];
  /** Consignment store: items sold for less than the main store's cost (a warning, not a block). */
  belowCost: string[];
}

const PAY_CODE: Record<PayMethod, string> = { cash: "cash", gcash: "gcash", maya: "maya", bank: "bank_transfer", split: "split", utang: "credit" };
const SPLIT_PARTS: Record<string, string> = { cash: "cash", gcash: "gcash", maya: "maya", bank: "bank_transfer" };

const productSelect = {
  id: true, name: true, sku: true, priceMinor: true, costMinor: true, isActive: true, reviewStatus: true,
  stockBaseUnit: true, stockBaseQuantity: true, stockConversionFamily: true, soldByWeight: true, trackStock: true,
} as const;
type P = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

// Owner/manager confirms a Bagong item from Para sa iyo: it becomes a normal product.
registerApprovalHandler("MANUAL_ITEM", async (tx, a) => {
  if (a.documentType !== "PRODUCT" || a.status !== "APPROVED") return;
  await tx.product.updateMany({ where: { id: a.documentId, storeId: a.storeId, reviewStatus: "FOR_REVIEW" }, data: { reviewStatus: "ACTIVE" } });
});

const credit = new CreditService();

// Utang over the limit: the owner decides in Para sa iyo. Approve → the held rice leaves the
// shelf, the utang is posted past the limit, the text goes out. Decline → the hold is dropped.
registerApprovalHandler("UTANG_OVER_LIMIT", async (tx, a) => {
  if (a.documentType !== "SALE") return;
  const order = await tx.order.findFirst({ where: { id: a.documentId, storeId: a.storeId, status: "ON_HOLD", source: "UTANG_PENDING" }, include: { items: true, sellingLocation: { select: { name: true } } } });
  if (!order || !order.sellingLocationId || !order.storeCustomerId) return;
  const leg = (productId: string, warehouseId: string): TripLeg => ({ storeId: a.storeId, productId, warehouseId, actorId: a.decidedById, documentType: "SALE", documentId: order.id, note: order.orderNumber });
  if (a.status === "DECLINED") {
    for (const i of order.items) if (i.productId) await unreserveForTrip(tx, leg(i.productId, i.sourceLocationId ?? order.sellingLocationId), i.quantity);
    await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED", paymentStatus: "CANCELLED_REFUND" } });
    await tx.orderStatusHistory.create({ data: { orderId: order.id, storeId: a.storeId, fromStatus: "ON_HOLD", toStatus: "CANCELLED", reason: "Credit over the limit — declined", actorType: "owner", actorId: a.decidedById } });
    return;
  }
  for (const i of order.items) {
    if (!i.productId) continue;
    if (!i.sourceLocationId) {
      await releaseForTrip(tx, leg(i.productId, order.sellingLocationId), i.quantity, i.quantity, "CONSUME");
    } else {
      // From another location: the hold is released and the stock leaves that place now.
      await releaseForTrip(tx, leg(i.productId, i.sourceLocationId), i.quantity, i.quantity, "CONSUME");
    }
  }
  await tx.payment.create({ data: { orderId: order.id, storeId: a.storeId, method: "credit", amountMinor: order.totalMinor, type: "payment", note: "Credit (approved by the owner)", createdBy: a.decidedById } });
  const posted = await credit.sellOnCredit(tx, a.storeId, order.storeCustomerId, order.id, order.totalMinor, a.decidedById, { overLimitApprovedBy: a.decidedById });
  if (!posted.ok) throw new Error("message" in posted.error ? posted.error.message : "Could not post the credit");
  await tx.order.update({ where: { id: order.id }, data: { status: "COMPLETED", source: "pos" } });
  await tx.orderStatusHistory.create({ data: { orderId: order.id, storeId: a.storeId, fromStatus: "ON_HOLD", toStatus: "COMPLETED", reason: "Credit over the limit — approved by the owner", actorType: "owner", actorId: a.decidedById } });
  await queueSms(tx, {
    storeId: a.storeId, storeCustomerId: order.storeCustomerId, template: "utang_sale", documentType: "SALE", documentId: order.id, createdById: a.decidedById,
    text: saleText({ customerName: order.customerName, amountMinor: order.totalMinor, items: order.items.map((i) => i.productName), locationName: order.sellingLocation?.name ?? "", at: order.occurredAt ?? order.createdAt, balanceMinor: posted.value.balanceMinor }),
  });
});

export class BentaService {
  private readonly sequences = new PrismaOrderSequenceRepository();

  private async run<T>(fn: () => Promise<T>): Promise<BentaResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      if (e instanceof SellingError || e instanceof PriceOverrideError) return invalid(e.message);
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      throw e;
    }
  }

  /** The selling location: the one asked for, else the person's home, else the store default. */
  private async location(storeId: string, actor: Actor, locationId: string | undefined) {
    const id = locationId || actor.homeLocationId || (await prisma.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } }))?.id;
    const loc = id ? await prisma.warehouse.findFirst({ where: { id, storeId, isActive: true }, select: { id: true, name: true, type: true } }) : null;
    if (!loc) throw new StepError(invalid("Choose a location"));
    const refusal = locationRefusal(actor, loc.id);
    if (refusal) throw new StepError(forbidden(refusal));
    return loc;
  }

  // ─────────────────────────── catalog ───────────────────────────

  /** Products for the Benta screen: price at this location, stock at every location, most-sold first. */
  async catalog(storeId: string, actor: Actor, locationId: string | undefined) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, locationId);
      const [products, locations, prices, levels, sold] = await Promise.all([
        prisma.product.findMany({ where: { storeId, isActive: true, reviewStatus: { not: "MERGED" } }, select: productSelect, orderBy: { name: "asc" } }),
        prisma.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true, code: true, type: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
        prisma.locationPrice.findMany({ where: { storeId, warehouseId: loc.id }, select: { productId: true, priceMinor: true } }),
        prisma.stockLevel.findMany({ where: { storeId, warehouseId: { not: null } }, select: { productId: true, warehouseId: true, quantityOnHand: true, quantityReserved: true } }),
        prisma.orderItem.groupBy({ by: ["productId"], where: { storeId, order: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, status: { not: "CANCELLED" } } }, _count: { _all: true } }),
      ]);
      const priceBy = new Map(prices.map((p) => [p.productId, p.priceMinor]));
      const soldBy = new Map(sold.map((s) => [s.productId ?? "", s._count._all]));
      const stockBy = new Map<string, Record<string, number>>();
      for (const l of levels) {
        const m = stockBy.get(l.productId) ?? {};
        m[l.warehouseId!] = (m[l.warehouseId!] ?? 0) + Math.max(0, l.quantityOnHand - l.quantityReserved);
        stockBy.set(l.productId, m);
      }
      const items = products
        .map((p) => ({
          id: p.id, name: p.name, sku: p.sku, loose: isLoose(p), gramsPerUnit: p.stockBaseUnit === "g" ? p.stockBaseQuantity : null,
          priceMinor: priceAt(p.priceMinor, priceBy.get(p.id)), mainPriceMinor: p.priceMinor, forReview: p.reviewStatus === "FOR_REVIEW",
          stock: stockBy.get(p.id) ?? {}, tracked: p.trackStock !== false && stockBy.has(p.id), sold30d: soldBy.get(p.id) ?? 0,
        }))
        .sort((a, b) => b.sold30d - a.sold30d || a.name.localeCompare(b.name));
      return { location: loc, locations, products: items };
    });
  }

  // ─────────────────────────── sell ───────────────────────────

  private async replay(storeId: string, key: string): Promise<BentaSaleView | null> {
    const o = await prisma.order.findFirst({ where: { storeId, idempotencyKey: key }, include: { items: true, payments: true, stockTransfers: { select: { id: true, docNumber: true } } } });
    if (!o) return null;
    const [approval, sms] = await Promise.all([
      prisma.approvalRequest.findFirst({ where: { storeId, kind: "UTANG_OVER_LIMIT", documentType: "SALE", documentId: o.id }, select: { id: true } }),
      prisma.smsMessage.findFirst({ where: { storeId, documentType: "SALE", documentId: o.id }, select: { status: true } }),
    ]);
    return {
      status: o.status === "ON_HOLD" ? "WAITING_OWNER" : o.status === "CANCELLED" ? "DECLINED" : "COMPLETED", approvalId: approval?.id ?? null, smsStatus: sms?.status ?? null,
      orderId: o.id, orderNumber: o.orderNumber, totalMinor: o.totalMinor,
      changeMinor: o.payments.reduce((s, p) => s + (p.changeMinor ?? 0), 0),
      paymentMethod: (Object.entries(PAY_CODE).find(([, c]) => c === o.paymentMethod)?.[0] ?? "cash") as PayMethod,
      locationId: o.sellingLocationId ?? "", occurredAt: (o.occurredAt ?? o.createdAt).toISOString(), encodedLater: o.encodedLater, replayed: true,
      lines: o.items.map((i) => ({ productId: i.productId ?? "", name: i.productName, soldBy: i.soldBy, quantity: i.quantity, grams: i.grams, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor, enteredAmountMinor: i.enteredAmountMinor, sourceLocationId: i.sourceLocationId })),
      releases: o.stockTransfers.map((t) => ({ id: t.id, docNumber: t.docNumber ?? "" })),
      zeroCheck: [], belowCost: [],
    };
  }

  /** An open drawer shift at this location (or a location-less register); required only when the store says so. */
  private async drawerFor(storeId: string, locationId: string): Promise<string | null> {
    const sessions = await prisma.registerSession.findMany({
      where: { storeId, status: "OPEN", register: { OR: [{ locationId }, { locationId: null }] } },
      select: { id: true, register: { select: { locationId: true } } },
      orderBy: { openedAt: "desc" },
    });
    const exact = sessions.find((s) => s.register.locationId === locationId) ?? sessions[0];
    if (exact) return exact.id;
    const settings = await prisma.storeSettings.findUnique({ where: { storeId }, select: { requireOpenShift: true } });
    if (settings?.requireOpenShift) throw new StepError(conflict("No cash drawer is open here — open the drawer before taking cash"));
    return null;
  }

  async sell(storeId: string, actor: Actor, input: BentaInput): Promise<BentaResult<BentaSaleView>> {
    let key: string;
    try {
      key = saleKey(storeId, input.idempotencyKey);
    } catch (e) {
      return invalid((e as Error).message);
    }
    const earlier = await this.replay(storeId, key);
    if (earlier) return { ok: true, value: earlier };

    const out = await this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      if (loc.type === "BUFFER") throw new SellingError("The Buffer store cannot sell — pick a store");
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (lines.length === 0) throw new SellingError("The sale is empty");
      if (lines.length > 50) throw new SellingError("Up to 50 lines per sale");
      const method = input.payment?.method as PayMethod | undefined;
      if (!method || !(method in PAY_CODE)) throw new SellingError("Payment: Cash, GCash, Maya, Bank, Split or Credit?");

      // Products, this location's prices, and any other locations the lines come from.
      const ids = [...new Set(lines.map((l) => l.productId ?? ""))];
      const products = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: productSelect })).map((p) => [p.id, p]));
      const prices = new Map((await prisma.locationPrice.findMany({ where: { storeId, warehouseId: loc.id, productId: { in: ids } }, select: { productId: true, priceMinor: true } })).map((p) => [p.productId, p.priceMinor]));
      const remoteIds = [...new Set(lines.map((l) => l.sourceLocationId).filter((x): x is string => !!x && x !== loc.id))];
      const remotes = new Map((await prisma.warehouse.findMany({ where: { storeId, id: { in: remoteIds }, isActive: true }, select: { id: true, name: true } })).map((w) => [w.id, w]));
      if (remotes.size !== remoteIds.length) throw new SellingError("Unknown location to take from");

      // A customer picked at the counter may have special prices; they beat the store's price (not a manual change, so no reason is needed).
      const pcust = input.customerId ? await prisma.storeCustomer.findFirst({ where: { storeId, id: input.customerId }, include: { customer: { select: { name: true } } } }) : null;
      const special = pcust ? new Map((await prisma.customerPrice.findMany({ where: { storeId, storeCustomerId: pcust.id, productId: { in: ids } }, select: { productId: true, priceMinor: true } })).map((x) => [x.productId, x.priceMinor])) : new Map<string, number>();
      const priced: (PricedLine & { product: P; catalogUnitPriceMinor: number; overridden: boolean; overrideReason: string | null; sourceLocationId: string | null })[] = [];
      for (const l of lines) {
        const p = products.get(l.productId ?? "");
        if (!p || !p.isActive || p.reviewStatus === "MERGED") throw new SellingError("Product not found — refresh the page");
        const catalog = special.get(p.id) ?? priceAt(p.priceMinor, prices.get(p.id));
        let override: number | null = null;
        if (l.unitPriceMinorOverride !== undefined && l.unitPriceMinorOverride !== null) {
          if (typeof l.unitPriceMinorOverride !== "number") throw new SellingError("Wrong price");
          override = l.unitPriceMinorOverride;
        }
        const price = resolveLinePrice({ catalogUnitPriceMinor: catalog, override, reason: l.priceOverrideReason });
        const line = priceLine(p, price.unitPriceMinor, l);
        priced.push({
          ...line, product: p, catalogUnitPriceMinor: catalog, overridden: price.overridden, overrideReason: price.reason,
          sourceLocationId: l.sourceLocationId && l.sourceLocationId !== loc.id ? l.sourceLocationId : null,
        });
      }
      const subtotal = priced.reduce((s, l) => s + l.lineTotalMinor, 0);
      if (subtotal <= 0) throw new SellingError("The sale has no amount");

      // Utang needs a customer on the list and their signature; cash/GCash take the drawer of this location.
      let storeCustomerId: string | null = null;
      let customerName = input.customerName?.trim().slice(0, 80) || "Walk-in";
      // Over the limit is now refused (pay first). The hold-for-the-owner path below stays only for old held sales.
      let waitOwner = null as { balanceMinor: number; limitMinor: number } | null;
      if (method === "utang") {
        const sc = input.customerId ? await prisma.storeCustomer.findFirst({ where: { storeId, id: input.customerId }, include: { customer: { select: { name: true } } } }) : null;
        if (!sc) throw new SellingError("Choose a customer for credit");
        storeCustomerId = sc.id;
        customerName = sc.customer.name ?? "Customer";
        if (!sc.creditApproved) throw new SellingError(`${customerName} has no credit limit yet — ask the owner to set one`);
        // A customer with no limit may always buy on credit; with a limit, at the limit they must pay first.
        const limitMinor = await credit.effectiveLimit(storeId, sc);
        if (limitMinor !== null && !limitCheck(sc.creditBalanceMinor, subtotal, limitMinor).ok) {
          throw new SellingError(`${customerName} owes ${pesoText(sc.creditBalanceMinor)} of a ${pesoText(limitMinor)} credit limit. This sale would pass the limit — take a payment first, then sell on credit again.`);
        }
      }
      // A named customer on a cash/GCash/Maya/bank/split sale is linked to the sale (for their history and the top customers).
      if (pcust && method !== "utang") {
        storeCustomerId = pcust.id;
        customerName = pcust.customer.name ?? "Customer";
      }
      const paper = input.paperSlip ? checkPaperSlip(input.paperSlip, new Date()) : null;
      const registerSessionId = method === "utang" ? null : await this.drawerFor(storeId, loc.id);

      const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
      if (!store) throw new StepError(notFound("Store not found"));
      const orderId = randomId();
      // One payment, or a split: several methods that together pay the whole sale (credit is never part of a split).
      let tendersIn: { methodCode: string; amountMinor: number; tenderedMinor?: number; reference?: string }[];
      if (method === "split") {
        const parts = Array.isArray(input.payment?.tenders) ? input.payment!.tenders! : [];
        if (parts.length < 2 || parts.length > 4) throw new SellingError("Split: choose 2 to 4 ways to pay");
        tendersIn = parts.map((t) => {
          const code = SPLIT_PARTS[(t.method ?? "").toLowerCase()];
          if (!code) throw new SellingError("Split: Cash, GCash, Maya or Bank only (credit cannot be split)");
          if (typeof t.amountMinor !== "number" || !Number.isInteger(t.amountMinor) || t.amountMinor <= 0) throw new SellingError("Split: enter how much each part pays");
          if (t.tenderedMinor !== undefined && (typeof t.tenderedMinor !== "number" || !Number.isInteger(t.tenderedMinor))) throw new SellingError("Enter the cash received");
          return { methodCode: code, amountMinor: t.amountMinor, ...(code === "cash" && t.tenderedMinor !== undefined ? { tenderedMinor: t.tenderedMinor } : {}), ...(t.reference ? { reference: t.reference } : {}) };
        });
        if (tendersIn.reduce((s, t) => s + t.amountMinor, 0) !== subtotal) throw new SellingError(`The parts must add up to ${pesoText(subtotal)}`);
      } else {
        const tender = { methodCode: PAY_CODE[method], amountMinor: subtotal, ...(method === "cash" && input.payment?.tenderedMinor !== undefined ? { tenderedMinor: input.payment.tenderedMinor as number } : {}), ...(input.payment?.reference ? { reference: input.payment.reference } : {}) };
        if (method === "cash" && tender.tenderedMinor !== undefined && !Number.isInteger(tender.tenderedMinor)) throw new SellingError("Enter the cash received");
        tendersIn = [tender];
      }
      // A sale waiting for the owner takes no money yet (the utang is posted on approval).
      const prepared = waitOwner ? null : await prepareTenders({ storeId, orderId, targetMinor: subtotal, storeCustomerId, tenders: tendersIn, requireFullCoverage: true });
      if (prepared && !prepared.ok) throw new StepError(prepared);
      const plan = prepared?.ok ? prepared.value : null;
      const outcome = { approvalId: null as string | null, smsStatus: null as string | null, belowCost: [] as string[] };

      const shelfCosts = await Promise.all(priced.map((l) => shelfCostFor(prisma, storeId, l.product.id, l.sourceLocationId ?? loc.id)));
      const items = priced.map((l, idx) => ({
        productId: l.product.id, productName: l.product.name, sku: l.product.sku, unitPriceMinor: l.unitPriceMinor,
        quantity: l.stockQty, lineTotalMinor: l.lineTotalMinor, soldBy: l.soldBy, grams: l.grams, enteredAmountMinor: l.enteredAmountMinor,
        sourceLocationId: l.sourceLocationId, priceOverridden: l.overridden, priceOverrideReason: l.overrideReason, catalogUnitPriceMinor: l.catalogUnitPriceMinor,
        unitCostMinor: shelfCosts[idx],
      }));
      const taxCols = await taxColumnsFor(storeId, items.map((i) => ({ productId: i.productId, lineTotalMinor: i.lineTotalMinor })), { discountMinor: 0, deliveryFeeMinor: 0 });
      const seq = await this.sequences.nextOrderSequence(storeId);
      const orderNumber = formatOrderNumber(store.slug, seq, { prefix: store.settings?.orderNumberPrefix ?? undefined });
      const now = new Date();
      const releases: { id: string; docNumber: string }[] = [];

      try {
        await prisma.$transaction(async (tx) => {
          await tx.order.create({
            data: {
              id: orderId, orderNumber, storeId, status: waitOwner ? "ON_HOLD" : "COMPLETED", source: waitOwner ? "UTANG_PENDING" : "pos", currencyCode: store.currencyCode,
              subtotalMinor: subtotal, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: subtotal, ...taxCols,
              snapshot: { lines: items, source: "benta", paymentMethod: PAY_CODE[method], locationId: loc.id, ...(paper ? { paperSlip: { slipNo: paper.slipNo, occurredAt: paper.occurredAt.toISOString() } } : {}) } as Prisma.InputJsonValue,
              paymentMethod: PAY_CODE[method], paymentStatus: method === "utang" ? "PENDING" : "COLLECTED",
              idempotencyKey: key, cartToken: "", customerName, customerPhone: "", deliveryAddressLine1: "",
              storeCustomerId, fulfillmentType: "PICKUP", registerSessionId,
              sellingLocationId: loc.id, occurredAt: paper?.occurredAt ?? now, paperSlipNo: paper?.slipNo ?? null, encodedLater: !!paper,
            },
          });
          await tx.orderItem.createMany({
            data: items.map((i) => ({
              orderId, storeId, productId: i.productId, productName: i.productName, sku: i.sku, unitPriceMinor: i.unitPriceMinor,
              quantity: i.quantity, lineTotalMinor: i.lineTotalMinor, soldBy: i.soldBy, grams: i.grams, enteredAmountMinor: i.enteredAmountMinor,
              sourceLocationId: i.sourceLocationId, priceOverridden: i.priceOverridden, priceOverrideReason: i.priceOverrideReason,
              priceOverriddenById: i.priceOverridden ? actor.userId : null, priceOverriddenAt: i.priceOverridden ? now : null,
              catalogUnitPriceMinor: i.priceOverridden ? i.catalogUnitPriceMinor : null, unitCostMinor: i.unitCostMinor,
            })),
          });
          await tx.orderStatusHistory.create({ data: { orderId, storeId, toStatus: waitOwner ? "ON_HOLD" : "COMPLETED", actorType: "pos", actorId: actor.userId, reason: waitOwner ? "Credit over the limit — waiting for the owner" : paper ? `From a paper slip #${paper.slipNo}` : null } });

          // Signatures: utang → the customer signs; a paper slip → staff + the slip photo.
          if (method === "utang") {
            await captureSignatures(tx, storeId, actor, { documentType: "SALE", documentId: orderId, step: "UTANG", locationId: loc.id }, (input.signatures ?? []).filter((s) => s.signerKind === "CUSTOMER"));
            await requireSignatures(tx, storeId, { documentType: "SALE", documentId: orderId, step: "UTANG" });
            const sig = (input.signatures ?? []).find((s) => s.signerKind === "CUSTOMER");
            await tx.order.update({ where: { id: orderId }, data: { signatureData: sig?.imagePng ?? null, signatureAt: now } });
          }
          if (paper) {
            await captureSignatures(tx, storeId, actor, { documentType: "PAPER_SLIP", documentId: orderId, step: "ENCODE", locationId: loc.id }, (input.signatures ?? []).filter((s) => s.signerKind === "STAFF" || s.signerKind === "SLIP_PHOTO"));
            await requireSignatures(tx, storeId, { documentType: "PAPER_SLIP", documentId: orderId, step: "ENCODE" });
          }

          if (waitOwner) {
            // Hold every line where it will come from, so it cannot be sold twice while the owner decides.
            for (const l of priced) {
              await reserveForTrip(tx, { storeId, productId: l.product.id, warehouseId: l.sourceLocationId ?? loc.id, actorId: actor.userId, documentType: "SALE", documentId: orderId, note: orderNumber }, l.stockQty);
            }
            const after = waitOwner.balanceMinor + subtotal;
            outcome.approvalId = (await requestApproval(tx, {
              storeId, kind: "UTANG_OVER_LIMIT", documentType: "SALE", documentId: orderId, locationId: loc.id,
              summary: `Credit over the limit: ${customerName} — ${pesoText(subtotal)} (${priced.map((l) => (l.soldBy === "PIECE" ? `${l.stockQty} × ${l.product.name}` : `${formatKilos(l.grams ?? l.stockQty)} ${l.product.name}`)).join(", ")}) at ${loc.name}. Owes ${pesoText(waitOwner.balanceMinor)} now, limit ${pesoText(waitOwner.limitMinor)} → will owe ${pesoText(after)} (over by ${pesoText(after - waitOwner.limitMinor)}).`,
              detail: { orderNumber, totalMinor: subtotal, balanceMinor: waitOwner.balanceMinor, limitMinor: waitOwner.limitMinor, storeCustomerId },
              requestedById: actor.userId,
            })).id;
          } else {
            await writeTenders(tx, { storeId, orderId, actorId: actor.userId, plan: plan!, note: paper ? `Benta (papel #${paper.slipNo})` : "Benta", registerSessionId });
            const local = priced.filter((l) => !l.sourceLocationId);
            for (const l of local) {
              await deductWithBuffer(tx, storeId, { productId: l.product.id, quantity: l.stockQty }, { orderId, createdBy: actor.userId, warehouseId: loc.id, documentType: "SALE", documentId: orderId });
            }
            // Rice taken from another store/warehouse leaves that place at once — no porter, no release step.
            for (const l of priced.filter((x) => x.sourceLocationId)) {
              await coverShortage(tx, storeId, { productId: l.product.id, warehouseId: l.sourceLocationId!, needed: l.stockQty, actorId: actor.userId, documentType: "SALE", documentId: orderId, reason: `sale ${orderNumber}` });
              await deductStock(tx, storeId, [{ productId: l.product.id, quantity: l.stockQty }], { type: "CONSUME", orderId, createdBy: actor.userId, warehouseId: l.sourceLocationId!, documentType: "SALE", documentId: orderId });
            }
            // A consignment store owes the main store's cost for what it sells.
            const charged = await chargeSale(tx, {
              storeId, orderId, orderNumber, locationId: loc.id, actorId: actor.userId,
              lines: priced.map((l) => ({ productId: l.product.id, productName: l.product.name, quantity: l.stockQty, loose: isLoose(l.product), lineTotalMinor: l.lineTotalMinor })),
            });
            outcome.belowCost = charged.belowCost;
            if (method === "utang" && storeCustomerId) {
              // The text carries the balance this transaction just wrote.
              const bal = await tx.storeCustomer.findUniqueOrThrow({ where: { id: storeCustomerId }, select: { creditBalanceMinor: true } });
              outcome.smsStatus = (await queueSms(tx, {
                storeId, storeCustomerId, template: "utang_sale", documentType: "SALE", documentId: orderId, createdById: actor.userId,
                text: saleText({ customerName, amountMinor: subtotal, items: priced.map((l) => l.product.name), locationName: loc.name, at: paper?.occurredAt ?? now, balanceMinor: bal.creditBalanceMinor }),
              })).status;
            }
          }
          await tx.auditLog.create({
            data: { storeId, actorType: "USER", actorId: actor.userId, action: paper ? "benta.paper_slip" : "benta.sell", entityType: "Order", entityId: orderId, after: { orderNumber, totalMinor: subtotal, method, locationId: loc.id, ...(paper ? { slipNo: paper.slipNo, occurredAt: paper.occurredAt.toISOString() } : {}) } },
          });
        }, txOptions());
      } catch (e) {
        if (e instanceof InsufficientStockError) throw new StepError(conflict(await this.shortText(storeId, e.productId, loc, priced.find((l) => l.product.id === e.productId)?.sourceLocationId ?? null)));
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const target = JSON.stringify(e.meta?.target ?? "");
          if (target.includes("paperSlipNo")) throw new StepError(conflict(`Paper slip #${paper?.slipNo} is already entered`));
          if (target.includes("idempotencyKey")) throw new Replayed();
        }
        if (e instanceof Error && /Credit|limit|approved/i.test(e.message) && method === "utang") throw new StepError(conflict(e.message));
        throw e;
      }

      await cacheBust(cacheKey("products", storeId));
      await cacheBust(cacheKey("orders", storeId));
      if (outcome.smsStatus === "QUEUED") wakeOutbox();
      // The zero check: anything this sale took to 0 here gets "May natira pa ba?" on the phone.
      const localIds = waitOwner ? [] : priced.filter((l) => !l.sourceLocationId).map((l) => l.product.id);
      const emptied = localIds.length ? await prisma.stockLevel.findMany({ where: { storeId, warehouseId: loc.id, productId: { in: localIds }, quantityOnHand: { lte: 0 } }, select: { productId: true } }) : [];
      const view: BentaSaleView = {
        status: waitOwner ? "WAITING_OWNER" : "COMPLETED", approvalId: outcome.approvalId, smsStatus: outcome.smsStatus,
        orderId, orderNumber, totalMinor: subtotal, changeMinor: plan?.changeMinor ?? 0, paymentMethod: method, locationId: loc.id,
        occurredAt: (paper?.occurredAt ?? now).toISOString(), encodedLater: !!paper, replayed: false,
        lines: items.map((i) => ({ productId: i.productId, name: i.productName, soldBy: i.soldBy, quantity: i.quantity, grams: i.grams, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor, enteredAmountMinor: i.enteredAmountMinor, sourceLocationId: i.sourceLocationId })),
        releases,
        belowCost: outcome.belowCost,
        zeroCheck: emptied.filter((e) => products.get(e.productId)?.trackStock !== false).map((e) => ({ productId: e.productId, name: products.get(e.productId)?.name ?? "" })),
      };
      return view;
    }).catch(async (e) => {
      if (e instanceof Replayed) {
        const won = await this.replay(storeId, key);
        if (won) return { ok: true as const, value: won };
      }
      throw e;
    });
    return out;
  }

  /** "Isang sako na lang sa Store 2. Bawasan, o kunin sa WH." */
  async shortText(storeId: string, productId: string, loc: { id: string; name: string }, sourceId: string | null): Promise<string> {
    const [p, levels, locs] = await Promise.all([
      prisma.product.findFirst({ where: { id: productId, storeId }, select: { name: true, stockBaseUnit: true, stockBaseQuantity: true } }),
      prisma.stockLevel.findMany({ where: { storeId, productId, warehouseId: { not: null } }, select: { warehouseId: true, quantityOnHand: true, quantityReserved: true } }),
      prisma.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true } }),
    ]);
    const here = sourceId ?? loc.id;
    const avail = (id: string) => levels.filter((l) => l.warehouseId === id).reduce((s, l) => s + Math.max(0, l.quantityOnHand - l.quantityReserved), 0);
    return shortMessage({
      productName: p?.name ?? "item", loose: p ? isLoose(p) : false, available: avail(here),
      here: locs.find((l) => l.id === here)?.name ?? loc.name,
      elsewhere: locs.filter((l) => l.id !== here).map((l) => ({ name: l.name, available: avail(l.id) })),
    });
  }

  // ─────────────────────────── Manual na pasok ───────────────────────────

  /** Inside a transaction: an IN- document with its lines, signed by the receiver, stock added. */
  private async writeStockIn(
    tx: Tx, storeId: string, actor: Actor, locationId: string,
    data: { supplierName: string | null; note: string | null; purchaseOrderId?: string | null; lines: { product: P; quantity: number; unitCostMinor: number | null; poLineId?: string | null }[] },
    signatures: SignatureInput[] | undefined,
  ) {
    const docNumber = await nextDocNumber(tx, storeId, "IN");
    const doc = await tx.stockIn.create({ data: { storeId, docNumber, locationId, supplierName: data.supplierName, note: data.note, purchaseOrderId: data.purchaseOrderId ?? null, createdById: actor.userId }, select: { id: true, docNumber: true } });
    await captureSignatures(tx, storeId, actor, { documentType: "STOCK_IN", documentId: doc.id, step: "RECEIVE", locationId }, signatures);
    await requireSignatures(tx, storeId, { documentType: "STOCK_IN", documentId: doc.id, step: "RECEIVE" });
    const costMode = await costModeOf(tx, storeId);
    for (const l of data.lines) {
      await tx.stockInLine.create({ data: { storeId, stockInId: doc.id, productId: l.product.id, quantity: l.quantity, unitCostMinor: l.unitCostMinor, poLineId: l.poLineId ?? null } });
      await recordCostIn(tx, { storeId, productId: l.product.id, warehouseId: locationId }, l.quantity, l.unitCostMinor);
      // What was on hand BEFORE this stock-in, to blend the new cost with the old one.
      const levelsBefore = await tx.stockLevel.findMany({ where: { storeId, productId: l.product.id, ...(costMode === "PER_LOCATION" ? { warehouseId: locationId } : { warehouse: { type: { not: "BUFFER" } } }) }, select: { quantityOnHand: true } });
      const onHandBefore = levelsBefore.reduce((s, x) => s + Math.max(0, x.quantityOnHand), 0);
      await addForTrip(tx, { storeId, productId: l.product.id, warehouseId: locationId, actorId: actor.userId, documentType: "STOCK_IN", documentId: doc.id, note: docNumber }, l.quantity, "STOCK_IN");
      // Average purchase cost (weighted by what is on hand). One cost per product, unless the store counts cost per location:
      // then only the main location (the default one) moves the product cost; the others keep their own shelf cost.
      const mainLoc = costMode === "PER_LOCATION" ? await tx.warehouse.findUnique({ where: { id: locationId }, select: { isDefault: true } }) : null;
      if (l.unitCostMinor !== null && l.unitCostMinor > 0 && (costMode !== "PER_LOCATION" || mainLoc?.isDefault)) {
        const before = await tx.product.findUnique({ where: { id: l.product.id }, select: { costMinor: true } });
        const averaged = before ? blendedCost(onHandBefore, before.costMinor, l.quantity, l.unitCostMinor) : l.unitCostMinor;
        if (before && before.costMinor !== averaged) {
          await tx.priceHistory.create({ data: { storeId, productId: l.product.id, warehouseId: locationId, field: "COST", oldMinor: before.costMinor, newMinor: averaged, source: "PURCHASE", reason: docNumber, changedById: actor.userId } });
        }
        await tx.product.update({ where: { id: l.product.id }, data: { costMinor: averaged } });
      }
    }
    if (data.purchaseOrderId) await applyReceipt(tx, storeId, data.purchaseOrderId, data.lines.flatMap((l) => (l.poLineId ? [{ poLineId: l.poLineId, quantity: l.quantity }] : [])));
    return doc;
  }

  async stockIn(
    storeId: string, actor: Actor,
    input: { locationId?: string; supplierName?: string; note?: string; purchaseOrderId?: string; lines?: { productId?: string; quantity?: unknown; unitCostMinor?: unknown }[]; signatures?: SignatureInput[] },
  ): Promise<BentaResult<{ id: string; docNumber: string }>> {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      // Received against a purchase order: the order decides the supplier and the cost, so counter staff never type a cost.
      const po = input.purchaseOrderId ? await loadOpenOrder(storeId, input.purchaseOrderId, loc.id) : null;
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (lines.length === 0 || lines.length > 50) throw new SellingError("Enter what arrived (1–50)");
      const ids = lines.map((l) => l.productId ?? "");
      if (new Set(ids).size !== ids.length) throw new SellingError("Each product only once");
      const products = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids }, isActive: true }, select: productSelect })).map((p) => [p.id, p]));
      const checked = lines.map((l) => {
        const p = products.get(l.productId ?? "");
        if (!p) throw new SellingError("Product not found");
        if (typeof l.quantity !== "number" || !Number.isInteger(l.quantity) || l.quantity <= 0 || l.quantity > 100_000_000) throw new SellingError(`How many ${p.name} arrived?`);
        if (po) {
          const pl = po.lines.find((x) => x.productId === p.id);
          if (!pl) throw new SellingError(`${p.name} is not on ${po.docNumber}`);
          const left = pl.quantity - pl.receivedQty;
          if (l.quantity > left) throw new SellingError(left > 0 ? `${p.name}: only ${isLoose(p) ? formatKilos(left) : `${left} sack${left === 1 ? "" : "s"}`} left on ${po.docNumber}. Enter any extra as a separate Stock in.` : `${p.name} is already complete on ${po.docNumber}`);
          return { product: p, quantity: l.quantity, unitCostMinor: pl.unitCostMinor as number | null, poLineId: pl.id as string | null };
        }
        const cost = l.unitCostMinor === undefined || l.unitCostMinor === null ? null : l.unitCostMinor;
        if (cost !== null && (typeof cost !== "number" || !Number.isInteger(cost) || cost < 0 || cost > 100_000_000)) throw new SellingError("Wrong cost");
        return { product: p, quantity: l.quantity, unitCostMinor: cost as number | null, poLineId: null as string | null };
      });
      const doc = await prisma.$transaction((tx) => this.writeStockIn(tx, storeId, actor, loc.id, {
        supplierName: po ? po.supplierName : input.supplierName?.trim().slice(0, 80) || null, note: input.note?.trim().slice(0, 200) || null, purchaseOrderId: po?.id ?? null, lines: checked,
      }, input.signatures), txOptions());
      await cacheBust(cacheKey("products", storeId));
      return doc;
    });
  }

  // ─────────────────────────── Bagong item ───────────────────────────

  async manualItem(
    storeId: string, actor: Actor,
    input: ManualItemAsk & { locationId?: string; signatures?: SignatureInput[]; trackStock?: boolean; /** Pre-order: the item is added with a cost and a selling price but nothing on hand yet. */ noOpeningStock?: boolean },
  ): Promise<BentaResult<{ productId: string; name: string; stockInDocNumber: string; approvalId: string | null }>> {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      // "Do not count stock": only for pieces (rice with a sack weight must stay tracked). It sells at any time.
      const untracked = input.trackStock === false;
      if (untracked && (input as { soldAs?: unknown }).soldAs !== "PIECE") throw new SellingError("Only a piece item can skip stock counting — rice must be counted");
      const noStock = input.noOpeningStock === true && !untracked;
      const plan = planManualItem(untracked || noStock ? { ...input, openingQty: 1 } : input);
      const dupe = await prisma.product.findFirst({ where: { storeId, name: { equals: plan.name, mode: "insensitive" }, isActive: true }, select: { name: true } });
      if (dupe) throw new SellingError(`"${dupe.name}" already exists — pick it from the list`);
      const result = await prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            storeId, sku: `BAGO-${randomId().slice(-8).toUpperCase()}`, name: plan.name, priceMinor: plan.priceMinor, costMinor: plan.costMinor,
            stockBaseUnit: plan.stockBaseUnit, stockBaseQuantity: plan.stockBaseQuantity, soldByWeight: plan.soldByWeight,
            stockConversionFamily: plan.stockConversionFamily, unit: plan.soldAs === "KILO" ? "kilo" : plan.soldAs === "SACK" ? "sako" : "pc",
            reviewStatus: "ACTIVE", createdById: actor.userId, trackStock: !untracked, // goes straight into Products — no owner review
          },
          select: productSelect,
        });
        const doc = untracked || noStock
          ? { id: "", docNumber: "" }
          : await this.writeStockIn(tx, storeId, actor, loc.id, { supplierName: null, note: `New item: ${plan.name}`, lines: [{ product, quantity: plan.openingQty, unitCostMinor: null }] }, input.signatures);
        const hawak = untracked ? "not counted" : noStock ? "none yet (pre-order)" : plan.soldAs === "KILO" ? formatKilos(plan.openingQty) : `${plan.openingQty} ${plan.soldAs === "SACK" ? "sack(s)" : "piece(s)"}`;
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "product.manual_create", entityType: "Product", entityId: product.id, after: { name: plan.name, soldAs: plan.soldAs, priceMinor: plan.priceMinor, costMinor: plan.costMinor, onHand: noStock ? "none yet" : hawak } } });
        return { productId: product.id, name: product.name, stockInDocNumber: doc.docNumber, approvalId: null };
      }, txOptions());
      await cacheBust(cacheKey("products", storeId));
      return result;
    });
  }

  /** Recent manual stock-ins (newest first) with their lines, so each one can be printed as a receipt. */
  async stockInList(storeId: string, actor: Actor, locationId: string | undefined) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, locationId);
      const docs = await prisma.stockIn.findMany({
        where: { storeId, locationId: loc.id }, orderBy: { createdAt: "desc" }, take: 30,
        select: { id: true, docNumber: true, supplierName: true, note: true, createdAt: true, lines: { select: { productId: true, quantity: true, unitCostMinor: true, poLineId: true } } },
      });
      const ids = [...new Set(docs.flatMap((d) => d.lines.map((l) => l.productId)))];
      const prods = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, name: true, stockBaseUnit: true, stockBaseQuantity: true } })).map((p) => [p.id, p]));
      return {
        location: { id: loc.id, name: loc.name },
        stockIns: docs.map((d) => ({
          id: d.id, docNumber: d.docNumber, supplierName: d.supplierName, note: d.note, createdAt: d.createdAt,
          lines: d.lines.map((l) => { const p = prods.get(l.productId); return { name: p?.name ?? "", loose: p?.stockBaseUnit === "g" && p?.stockBaseQuantity === 1, quantity: l.quantity, unitCostMinor: l.poLineId && !seesCost(actor.role) ? null : l.unitCostMinor }; }), // a cost agreed on a purchase order is not for counter staff
        })),
      };
    });
  }

  /** Susuriin: manual items waiting for the owner. */
  async reviewList(storeId: string) {
    const rows = await prisma.product.findMany({
      where: { storeId, reviewStatus: "FOR_REVIEW" },
      select: { ...productSelect, createdAt: true, createdById: true, stockLevels: { select: { warehouseId: true, quantityOnHand: true } }, _count: { select: { orderItems: true } } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((p) => ({
      id: p.id, name: p.name, priceMinor: p.priceMinor, costMinor: p.costMinor, loose: isLoose(p), gramsPerUnit: p.stockBaseUnit === "g" ? p.stockBaseQuantity : null,
      createdAt: p.createdAt, timesSold: p._count.orderItems, stock: p.stockLevels.map((l) => ({ locationId: l.warehouseId, quantity: l.quantityOnHand })),
    }));
  }

  /** Pagsamahin: fold a manual item into an existing product. Stock is converted by weight through the ledger. */
  async merge(storeId: string, actor: Actor, productId: string, intoProductId: string | undefined): Promise<BentaResult<{ id: string; mergedIntoId: string; moved: { locationId: string; from: number; to: number }[] }>> {
    if (!["OWNER", "MANAGER", "STORE_OWNER"].includes(actor.role)) return forbidden("Only the owner or a manager can merge products");
    if (!intoProductId || intoProductId === productId) return invalid("Choose the product to merge into");
    return this.run(async () => {
      const [from, into] = await Promise.all([
        prisma.product.findFirst({ where: { id: productId, storeId }, select: productSelect }),
        prisma.product.findFirst({ where: { id: intoProductId, storeId, isActive: true, reviewStatus: "ACTIVE" }, select: productSelect }),
      ]);
      if (!from || from.reviewStatus !== "FOR_REVIEW") throw new StepError(notFound("This is no longer in To review"));
      if (!into) throw new StepError(invalid("Choose an active product"));
      const moved: { locationId: string; from: number; to: number }[] = [];
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.product.updateMany({ where: { id: from.id, storeId, reviewStatus: "FOR_REVIEW" }, data: { reviewStatus: "MERGED", isActive: false, mergedIntoId: into.id } });
        if (claimed.count === 0) throw new StepError(conflict("This was already decided"));
        const levels = await tx.stockLevel.findMany({ where: { storeId, productId: from.id }, select: { id: true, warehouseId: true, quantityOnHand: true, quantityReserved: true } });
        for (const l of levels) {
          if (l.quantityReserved > 0) throw new StepError(conflict(`Some ${from.name} is on hold — finish the transfer or sale first`));
          if (l.quantityOnHand === 0 || !l.warehouseId) continue;
          if (l.quantityOnHand < 0) throw new StepError(conflict(`${from.name} stock is below zero — count it first`));
          const toQty = mergeQuantity(from, into, l.quantityOnHand);
          const taken = await tx.stockLevel.updateMany({ where: { id: l.id, quantityOnHand: l.quantityOnHand, quantityReserved: 0 }, data: { quantityOnHand: 0 } });
          if (taken.count === 0) throw new StepError(conflict("Stock changed while merging — try again"));
          await recordMovement(tx, { storeId, productId: from.id, warehouseId: l.warehouseId, delta: -l.quantityOnHand, type: "MERGE_OUT", createdBy: actor.userId, balanceAfter: 0, documentType: "PRODUCT_MERGE", documentId: from.id, note: `→ ${into.name}` });
          await addForTrip(tx, { storeId, productId: into.id, warehouseId: l.warehouseId, actorId: actor.userId, documentType: "PRODUCT_MERGE", documentId: from.id, note: `← ${from.name}` }, toQty, "MERGE_IN");
          moved.push({ locationId: l.warehouseId, from: l.quantityOnHand, to: toQty });
        }
        await tx.approvalRequest.updateMany({
          where: { storeId, kind: "MANUAL_ITEM", documentType: "PRODUCT", documentId: from.id, status: "PENDING" },
          data: { status: "APPROVED", decidedById: actor.userId, decidedAt: new Date(), decisionNote: `Merged into ${into.name}` },
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "product.merge", entityType: "Product", entityId: from.id, after: { into: into.id, moved } } });
      }, txOptions());
      await cacheBust(cacheKey("products", storeId));
      return { id: from.id, mergedIntoId: into.id, moved };
    });
  }
}

class Replayed extends Error {
  constructor() {
    super("idempotency key already used");
  }
}

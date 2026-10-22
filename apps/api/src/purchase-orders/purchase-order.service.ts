// Suppliers and purchase orders.
// An order says what was asked of a supplier and at what cost. A delivery received against it (Stock in) fills its lines,
// and what arrived — at the agreed cost — is what the store owes that supplier until it is paid.
// Owner and manager create, cancel and pay; counter staff only see the open orders for Stock in, never the costs.

import type { ApiError } from "@sam-store/contracts";
import { prisma } from "../persistence/prisma-repositories.js";
import { isLooseP } from "../domain/counting.js";
import { seesCost } from "../domain/cost-redact.js";
import { nextDocNumber } from "../people/people.service.js";
import { chargeAmount } from "../payable/charges.js";
import { lastCostByProduct, previousCost, priceMove, type CostRow, type PriceMove } from "../domain/price-watch.js";
import { byUrgency, COVER_DAYS, reorderAdvice, SOON_DAYS, type Urgency } from "../domain/reorder.js";

export type PoResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const notFound = (m: string) => ({ ok: false as const, error: { type: "not_found" as const, message: m } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });

const DAY_MS = 24 * 60 * 60 * 1000;
const isOpen = (status: string) => status === "OPEN" || status === "PARTLY";
const goodInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export interface PoLineView {
  id: string; productId: string; name: string; loose: boolean;
  quantity: number; receivedQty: number;
  unitCostMinor?: number; lineTotalMinor?: number;
  /** Owner/manager only: how this cost compares with the supplier's cost the time before. */
  move?: PriceMove;
}
export interface LastCost { productId: string; name: string; loose: boolean; unitCostMinor: number; at: string; poNumber: string }
export interface ReorderItem {
  productId: string; name: string; loose: boolean; urgency: Urgency; daysLeft: number | null;
  /** Stock units: pieces, or grams for loose rice. All places added together. */
  availableQty: number; perDay: number; onOrderQty: number; suggestedQty: number;
  supplierId: string | null; supplierName: string | null; lastCostMinor: number | null; productCostMinor: number;
}
export interface PoView {
  id: string; docNumber: string; supplierId: string; supplierName: string; locationId: string; locationName: string;
  status: string; expectedAt: string | null; overdue: boolean; note: string | null; createdAt: string;
  lines: PoLineView[];
  totalMinor?: number; receivedMinor?: number;
}
export interface SupplierBalance {
  id: string; name: string; contactPerson: string | null; phone: string | null;
  receivedMinor: number; paidMinor: number; owedMinor: number; pendingMinor: number;
  openOrders: number; overdueOrders: number; lastPaymentAt: string | null;
}
export interface SupplierEntry {
  id: string; kind: "DELIVERY" | "PAYMENT" | "UNDO"; at: string; ref: string; poNumber: string | null; note: string | null;
  amountMinor: number; runningMinor: number; canUndo: boolean;
}

export class PurchaseOrderService {
  /** Suppliers for the order form (everyone with counter access may read the names). */
  async suppliers(storeId: string) {
    const rows = await prisma.supplier.findMany({ where: { storeId }, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true } });
    return { ok: true as const, value: { suppliers: rows } };
  }

  /** Orders, newest first. Counter staff get the open ones only, with no costs. */
  async list(storeId: string, role: string, q: { status?: string; locationId?: string; supplierId?: string }): Promise<PoResult<{ orders: PoView[] }>> {
    const cost = seesCost(role);
    const wantOpen = !cost || q.status === "open";
    const where = {
      storeId,
      ...(wantOpen ? { status: { in: ["OPEN", "PARTLY"] } } : q.status && q.status !== "all" ? { status: q.status.toUpperCase() } : {}),
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(cost && q.supplierId ? { supplierId: q.supplierId } : {}),
    };
    const orders = await prisma.purchaseOrder.findMany({
      where, orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, docNumber: true, supplierId: true, supplierName: true, locationId: true, status: true, expectedAt: true, note: true, createdAt: true, lines: { select: { id: true, productId: true, quantity: true, receivedQty: true, unitCostMinor: true } } },
    });
    const productIds = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.productId)))];
    const [products, locations] = await Promise.all([
      prisma.product.findMany({ where: { storeId, id: { in: productIds } }, select: { id: true, name: true, stockBaseUnit: true, stockBaseQuantity: true } }),
      prisma.warehouse.findMany({ where: { storeId }, select: { id: true, name: true } }),
    ]);
    const prod = new Map(products.map((p) => [p.id, p]));
    const locName = new Map(locations.map((l) => [l.id, l.name]));
    // Price watch: what each supplier charged for the same item on earlier orders (owner and manager only).
    const before: CostRow[] = cost && orders.length > 0 ? await this.costRows(storeId, [...new Set(orders.map((o) => o.supplierId))], productIds) : [];
    const now = Date.now();
    const views: PoView[] = orders.map((o) => {
      let total = 0;
      let received = 0;
      const lines: PoLineView[] = o.lines.map((l) => {
        const p = prod.get(l.productId);
        const loose = p ? isLooseP(p) : false;
        total += chargeAmount(loose, l.quantity, l.unitCostMinor);
        received += chargeAmount(loose, l.receivedQty, l.unitCostMinor);
        const base: PoLineView = { id: l.id, productId: l.productId, name: p?.name ?? "Item", loose, quantity: l.quantity, receivedQty: l.receivedQty };
        return cost ? { ...base, unitCostMinor: l.unitCostMinor, lineTotalMinor: chargeAmount(loose, l.quantity, l.unitCostMinor), move: priceMove(previousCost(before, o.supplierId, l.productId, o.createdAt.getTime()), l.unitCostMinor) } : base;
      });
      const view: PoView = {
        id: o.id, docNumber: o.docNumber, supplierId: o.supplierId, supplierName: o.supplierName, locationId: o.locationId, locationName: locName.get(o.locationId) ?? "",
        status: o.status, expectedAt: o.expectedAt ? o.expectedAt.toISOString() : null,
        overdue: isOpen(o.status) && !!o.expectedAt && o.expectedAt.getTime() + DAY_MS <= now,
        note: o.note, createdAt: o.createdAt.toISOString(), lines,
      };
      return cost ? { ...view, totalMinor: total, receivedMinor: received } : view;
    });
    return { ok: true, value: { orders: views } };
  }

  /** Costs on earlier (not cancelled) orders for these suppliers and items, newest first. */
  private async costRows(storeId: string, supplierIds: string[], productIds: string[]): Promise<CostRow[]> {
    if (supplierIds.length === 0 || productIds.length === 0) return [];
    const rows = await prisma.purchaseOrderLine.findMany({
      where: { storeId, productId: { in: productIds }, order: { supplierId: { in: supplierIds }, status: { not: "CANCELLED" } } },
      orderBy: { order: { createdAt: "desc" } }, take: 4000,
      select: { productId: true, unitCostMinor: true, order: { select: { supplierId: true, createdAt: true } } },
    });
    return rows.map((r) => ({ supplierId: r.order.supplierId, productId: r.productId, unitCostMinor: r.unitCostMinor, at: r.order.createdAt.getTime() }));
  }

  /** Items that will run out soon at the pace of the last 2 weeks, with how much to order. All stores and the warehouse together (Buffer stores left out). */
  async reorder(storeId: string): Promise<PoResult<{ items: ReorderItem[]; soonDays: number; coverDays: number }>> {
    const places = await prisma.warehouse.findMany({ where: { storeId, isActive: true, type: { not: "BUFFER" } }, select: { id: true } });
    const ids = places.map((p) => p.id);
    const since = new Date(Date.now() - 14 * DAY_MS);
    const [levels, used, open] = await Promise.all([
      prisma.stockLevel.groupBy({ by: ["productId"], where: { storeId, warehouseId: { in: ids } }, _sum: { quantityOnHand: true, quantityReserved: true } }),
      prisma.stockMovement.groupBy({ by: ["productId"], where: { storeId, warehouseId: { in: ids }, type: "CONSUME", createdAt: { gte: since } }, _sum: { delta: true } }),
      prisma.purchaseOrderLine.findMany({ where: { storeId, order: { status: { in: ["OPEN", "PARTLY"] } } }, select: { productId: true, quantity: true, receivedQty: true } }),
    ]);
    const have = new Map(levels.map((l) => [l.productId, (l._sum.quantityOnHand ?? 0) - (l._sum.quantityReserved ?? 0)]));
    const coming = new Map<string, number>();
    for (const l of open) coming.set(l.productId, (coming.get(l.productId) ?? 0) + Math.max(0, l.quantity - l.receivedQty));
    const selling = used.filter((u) => Math.abs(u._sum.delta ?? 0) > 0);
    const products = await prisma.product.findMany({
      where: { storeId, isActive: true, id: { in: selling.map((u) => u.productId) } },
      select: { id: true, name: true, costMinor: true, stockBaseUnit: true, stockBaseQuantity: true },
    });
    const prod = new Map(products.map((p) => [p.id, p]));
    const picked: ReorderItem[] = [];
    for (const u of selling) {
      const p = prod.get(u.productId);
      if (!p) continue;
      const loose = isLooseP(p);
      const perDay = Math.abs(u._sum.delta ?? 0) / 14;
      const advice = reorderAdvice({ available: have.get(p.id) ?? 0, perDay, onOrder: coming.get(p.id) ?? 0, loose });
      if (!advice.urgency) continue;
      picked.push({
        productId: p.id, name: p.name, loose, urgency: advice.urgency, daysLeft: advice.daysLeft,
        availableQty: Math.max(0, have.get(p.id) ?? 0), perDay: Math.round(perDay * 100) / 100, onOrderQty: coming.get(p.id) ?? 0, suggestedQty: advice.suggested,
        supplierId: null, supplierName: null, lastCostMinor: null, productCostMinor: p.costMinor,
      });
    }
    if (picked.length > 0) {
      // The supplier and the cost of the last order that carried the item
      const lines = await prisma.purchaseOrderLine.findMany({
        where: { storeId, productId: { in: picked.map((x) => x.productId) }, order: { status: { not: "CANCELLED" } } },
        orderBy: { order: { createdAt: "desc" } }, take: 3000,
        select: { productId: true, unitCostMinor: true, order: { select: { supplierId: true, supplierName: true } } },
      });
      const lastBy = new Map<string, (typeof lines)[number]>();
      for (const l of lines) if (!lastBy.has(l.productId)) lastBy.set(l.productId, l);
      for (const it of picked) {
        const l = lastBy.get(it.productId);
        if (l) { it.supplierId = l.order.supplierId; it.supplierName = l.order.supplierName; it.lastCostMinor = l.unitCostMinor; }
      }
    }
    picked.sort(byUrgency);
    return { ok: true, value: { items: picked, soonDays: SOON_DAYS, coverDays: COVER_DAYS } };
  }

  /** What this supplier charged last time, per item, so the new-order form can show it next to the cost being typed. */
  async lastCosts(storeId: string, supplierId: string | undefined): Promise<PoResult<{ costs: LastCost[] }>> {
    if (!supplierId) return invalid("Choose the supplier");
    const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, storeId }, select: { id: true } });
    if (!supplier) return { ok: true, value: { costs: [] } };
    const lines = await prisma.purchaseOrderLine.findMany({
      where: { storeId, order: { supplierId, status: { not: "CANCELLED" } } },
      orderBy: { order: { createdAt: "desc" } }, take: 1500,
      select: { productId: true, unitCostMinor: true, order: { select: { docNumber: true, supplierId: true, createdAt: true } } },
    });
    const rows: CostRow[] = lines.map((r) => ({ supplierId: r.order.supplierId, productId: r.productId, unitCostMinor: r.unitCostMinor, at: r.order.createdAt.getTime() }));
    const latest = lastCostByProduct(rows, supplierId);
    const docOf = new Map(lines.map((r) => [`${r.productId}:${r.order.createdAt.getTime()}`, r.order.docNumber]));
    const products = await prisma.product.findMany({ where: { storeId, id: { in: [...latest.keys()] } }, select: { id: true, name: true, stockBaseUnit: true, stockBaseQuantity: true } });
    const costs: LastCost[] = products.map((p) => {
      const r = latest.get(p.id)!;
      return { productId: p.id, name: p.name, loose: isLooseP(p), unitCostMinor: r.unitCostMinor, at: new Date(r.at).toISOString(), poNumber: docOf.get(`${p.id}:${r.at}`) ?? "" };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, value: { costs } };
  }

  async create(
    storeId: string, actorId: string,
    input: { supplierId?: string; supplierName?: string; locationId?: string; expectedAt?: string; note?: string; lines?: { productId?: string; quantity?: unknown; unitCostMinor?: unknown }[] },
  ): Promise<PoResult<{ id: string; docNumber: string }>> {
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (lines.length === 0 || lines.length > 50) return invalid("Add what you are ordering (1–50 items)");
    const ids = lines.map((l) => l.productId ?? "");
    if (new Set(ids).size !== ids.length) return invalid("Each item only once");
    const loc = input.locationId ? await prisma.warehouse.findFirst({ where: { id: input.locationId, storeId, isActive: true, type: { not: "BUFFER" } }, select: { id: true } }) : null;
    if (!loc) return invalid("Choose where the delivery goes");
    let expectedAt: Date | null = null;
    if (input.expectedAt) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expectedAt)) return invalid("Wrong date");
      expectedAt = new Date(`${input.expectedAt}T00:00:00+08:00`);
      if (Number.isNaN(expectedAt.getTime())) return invalid("Wrong date");
    }
    const products = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids }, isActive: true }, select: { id: true, name: true, stockBaseUnit: true, stockBaseQuantity: true } })).map((p) => [p.id, p]));
    const checked: { productId: string; quantity: number; unitCostMinor: number }[] = [];
    for (const l of lines) {
      const p = products.get(l.productId ?? "");
      if (!p) return invalid("Item not found");
      if (!goodInt(l.quantity, 1, 100_000_000)) return invalid(`How many ${p.name}?`);
      if (!goodInt(l.unitCostMinor, 1, 100_000_000)) return invalid(`What is the cost of ${p.name}?`);
      checked.push({ productId: p.id, quantity: l.quantity, unitCostMinor: l.unitCostMinor });
    }
    let supplier: { id: string; name: string } | null = null;
    if (input.supplierId) supplier = await prisma.supplier.findFirst({ where: { id: input.supplierId, storeId }, select: { id: true, name: true } });
    else {
      const name = (input.supplierName ?? "").trim().slice(0, 80);
      if (name.length < 2) return invalid("Choose or type the supplier");
      supplier = (await prisma.supplier.findFirst({ where: { storeId, name }, select: { id: true, name: true } })) ?? (await prisma.supplier.create({ data: { storeId, name }, select: { id: true, name: true } }));
    }
    if (!supplier) return notFound("Supplier not found");
    const sup = supplier;
    const note = input.note?.trim().slice(0, 200) || null;
    const doc = await prisma.$transaction(async (tx) => {
      const docNumber = await nextDocNumber(tx, storeId, "PO");
      const order = await tx.purchaseOrder.create({
        data: { storeId, docNumber, supplierId: sup.id, supplierName: sup.name, locationId: loc.id, status: "OPEN", expectedAt, note, createdById: actorId, lines: { create: checked.map((c) => ({ storeId, ...c })) } },
        select: { id: true, docNumber: true },
      });
      await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: "po.create", entityType: "PurchaseOrder", entityId: order.id, after: { docNumber, supplierId: sup.id, locationId: loc.id, lines: checked.length } } });
      return order;
    });
    return { ok: true, value: doc };
  }

  /** Cancel an order nobody has delivered on; if part of it already arrived, close what is still missing instead. */
  async cancel(storeId: string, actorId: string, id: string): Promise<PoResult<{ id: string; status: string }>> {
    const po = await prisma.purchaseOrder.findFirst({ where: { id, storeId }, select: { id: true, docNumber: true, status: true, lines: { select: { receivedQty: true } } } });
    if (!po) return notFound("Purchase order not found");
    if (!isOpen(po.status)) return conflict(`${po.docNumber} is already closed`);
    const arrived = po.lines.some((l) => l.receivedQty > 0);
    const status = arrived ? "RECEIVED" : "CANCELLED";
    const done = await prisma.purchaseOrder.updateMany({ where: { id, storeId, status: { in: ["OPEN", "PARTLY"] } }, data: { status } });
    if (done.count !== 1) return conflict(`${po.docNumber} just changed. Open it again.`);
    await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: arrived ? "po.close_short" : "po.cancel", entityType: "PurchaseOrder", entityId: id, after: { docNumber: po.docNumber, status } } });
    return { ok: true, value: { id, status } };
  }

  // ─────────────────────────── what we owe ───────────────────────────

  /** Delivered value, paid, and ordered-not-yet-delivered, per supplier. */
  private async totals(storeId: string, supplierId?: string) {
    const orders = await prisma.purchaseOrder.findMany({
      where: { storeId, ...(supplierId ? { supplierId } : {}) },
      select: { supplierId: true, status: true, expectedAt: true, lines: { select: { productId: true, quantity: true, receivedQty: true, unitCostMinor: true } } },
    });
    const productIds = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.productId)))];
    const products = await prisma.product.findMany({ where: { storeId, id: { in: productIds } }, select: { id: true, stockBaseUnit: true, stockBaseQuantity: true } });
    const loose = new Map(products.map((p) => [p.id, isLooseP(p)]));
    const paid = await prisma.supplierPayment.groupBy({ by: ["supplierId"], where: { storeId, ...(supplierId ? { supplierId } : {}) }, _sum: { amountMinor: true }, _max: { createdAt: true } });
    const out = new Map<string, { received: number; paid: number; pending: number; openOrders: number; overdue: number; lastPaymentAt: Date | null }>();
    const slot = (id: string) => { let s = out.get(id); if (!s) { s = { received: 0, paid: 0, pending: 0, openOrders: 0, overdue: 0, lastPaymentAt: null }; out.set(id, s); } return s; };
    const now = Date.now();
    for (const o of orders) {
      const s = slot(o.supplierId);
      for (const l of o.lines) {
        const lo = loose.get(l.productId) ?? false;
        s.received += chargeAmount(lo, l.receivedQty, l.unitCostMinor);
        if (isOpen(o.status)) s.pending += chargeAmount(lo, Math.max(0, l.quantity - l.receivedQty), l.unitCostMinor);
      }
      if (isOpen(o.status)) {
        s.openOrders += 1;
        if (o.expectedAt && o.expectedAt.getTime() + DAY_MS <= now) s.overdue += 1;
      }
    }
    for (const p of paid) { const s = slot(p.supplierId); s.paid = p._sum.amountMinor ?? 0; s.lastPaymentAt = p._max.createdAt ?? null; }
    return out;
  }

  async balances(storeId: string): Promise<PoResult<{ suppliers: SupplierBalance[]; totalOwedMinor: number; totalPendingMinor: number }>> {
    const [rows, totals] = await Promise.all([
      prisma.supplier.findMany({ where: { storeId }, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true, contactPerson: true, phone: true } }),
      this.totals(storeId),
    ]);
    const suppliers: SupplierBalance[] = rows.map((r) => {
      const t = totals.get(r.id);
      return {
        id: r.id, name: r.name, contactPerson: r.contactPerson, phone: r.phone,
        receivedMinor: t?.received ?? 0, paidMinor: t?.paid ?? 0, owedMinor: (t?.received ?? 0) - (t?.paid ?? 0), pendingMinor: t?.pending ?? 0,
        openOrders: t?.openOrders ?? 0, overdueOrders: t?.overdue ?? 0, lastPaymentAt: t?.lastPaymentAt ? t.lastPaymentAt.toISOString() : null,
      };
    }).sort((a, b) => b.owedMinor - a.owedMinor || a.name.localeCompare(b.name));
    return { ok: true, value: { suppliers, totalOwedMinor: suppliers.reduce((s, x) => s + Math.max(0, x.owedMinor), 0), totalPendingMinor: suppliers.reduce((s, x) => s + x.pendingMinor, 0) } };
  }

  /** One supplier's statement: deliveries received (+) and payments (−), with a running balance. */
  async statement(storeId: string, supplierId: string | undefined): Promise<PoResult<{ supplier: { id: string; name: string }; owedMinor: number; entries: SupplierEntry[] }>> {
    const supplier = supplierId ? await prisma.supplier.findFirst({ where: { id: supplierId, storeId }, select: { id: true, name: true } }) : null;
    if (!supplier) return notFound("Supplier not found");
    const orders = await prisma.purchaseOrder.findMany({ where: { storeId, supplierId: supplier.id }, select: { id: true, docNumber: true } });
    const poNo = new Map(orders.map((o) => [o.id, o.docNumber]));
    const docs = await prisma.stockIn.findMany({ where: { storeId, purchaseOrderId: { in: orders.map((o) => o.id) } }, select: { id: true, docNumber: true, purchaseOrderId: true, createdAt: true, lines: { select: { productId: true, quantity: true, unitCostMinor: true } } } });
    const payments = await prisma.supplierPayment.findMany({ where: { storeId, supplierId: supplier.id }, select: { id: true, docNumber: true, amountMinor: true, note: true, reversesId: true, createdAt: true } });
    const productIds = [...new Set(docs.flatMap((d) => d.lines.map((l) => l.productId)))];
    const products = await prisma.product.findMany({ where: { storeId, id: { in: productIds } }, select: { id: true, stockBaseUnit: true, stockBaseQuantity: true } });
    const loose = new Map(products.map((p) => [p.id, isLooseP(p)]));
    const undone = new Set(payments.flatMap((p) => (p.reversesId ? [p.reversesId] : [])));
    const raw: Omit<SupplierEntry, "runningMinor">[] = [
      ...docs.map((d) => ({
        id: d.id, kind: "DELIVERY" as const, at: d.createdAt.toISOString(), ref: d.docNumber, poNumber: d.purchaseOrderId ? poNo.get(d.purchaseOrderId) ?? null : null, note: null,
        amountMinor: d.lines.reduce((s, l) => s + chargeAmount(loose.get(l.productId) ?? false, l.quantity, l.unitCostMinor ?? 0), 0), canUndo: false,
      })),
      ...payments.map((p) => ({
        id: p.id, kind: p.reversesId ? ("UNDO" as const) : ("PAYMENT" as const), at: p.createdAt.toISOString(), ref: p.docNumber, poNumber: null, note: p.note,
        amountMinor: -p.amountMinor, canUndo: !p.reversesId && !undone.has(p.id),
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    let running = 0;
    const entries: SupplierEntry[] = raw.map((e) => { running += e.amountMinor; return { ...e, runningMinor: running }; });
    return { ok: true, value: { supplier, owedMinor: running, entries: entries.reverse() } };
  }

  async pay(storeId: string, actorId: string, input: { supplierId?: string; amountMinor?: unknown; note?: string }): Promise<PoResult<{ id: string; docNumber: string }>> {
    if (!goodInt(input.amountMinor, 1, 1_000_000_000)) return invalid("Enter how much you paid");
    const amount = input.amountMinor;
    const supplier = input.supplierId ? await prisma.supplier.findFirst({ where: { id: input.supplierId, storeId }, select: { id: true, name: true } }) : null;
    if (!supplier) return notFound("Supplier not found");
    const t = (await this.totals(storeId, supplier.id)).get(supplier.id);
    const owed = (t?.received ?? 0) - (t?.paid ?? 0);
    const ceiling = Math.max(0, owed) + (t?.pending ?? 0);
    // A paid-in-advance order is fine, but a slipped zero is not: never more than owed plus what is still on order.
    if (amount > ceiling) return invalid(ceiling > 0 ? `You only owe ${supplier.name} up to ₱${(ceiling / 100).toFixed(2)} (including what is still on order)` : `You do not owe ${supplier.name} anything`);
    const note = input.note?.trim().slice(0, 200) || null;
    const row = await prisma.$transaction(async (tx) => {
      const docNumber = await nextDocNumber(tx, storeId, "SPY");
      const pay = await tx.supplierPayment.create({ data: { storeId, supplierId: supplier.id, docNumber, amountMinor: amount, note, createdById: actorId }, select: { id: true, docNumber: true } });
      await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: "supplier.pay", entityType: "SupplierPayment", entityId: pay.id, after: { docNumber, supplierId: supplier.id, amountMinor: amount } } });
      return pay;
    });
    return { ok: true, value: row };
  }

  /** Undo a payment (a wrong amount, the wrong supplier): a matching negative entry; the original stays on the statement. */
  async undoPayment(storeId: string, actorId: string, id: string): Promise<PoResult<{ id: string; docNumber: string }>> {
    const orig = await prisma.supplierPayment.findFirst({ where: { id, storeId }, select: { id: true, supplierId: true, amountMinor: true, reversesId: true, docNumber: true } });
    if (!orig) return notFound("Payment not found");
    if (orig.reversesId || orig.amountMinor <= 0) return conflict("That entry cannot be undone");
    try {
      const row = await prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "SPY");
        const undo = await tx.supplierPayment.create({ data: { storeId, supplierId: orig.supplierId, docNumber, amountMinor: -orig.amountMinor, note: `Undo ${orig.docNumber}`, reversesId: orig.id, createdById: actorId }, select: { id: true, docNumber: true } });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: "supplier.pay_undo", entityType: "SupplierPayment", entityId: undo.id, after: { undoes: orig.docNumber, amountMinor: orig.amountMinor } } });
        return undo;
      });
      return { ok: true, value: row };
    } catch (e) {
      // reversesId is unique: a second undo of the same payment is refused by the database.
      if (typeof e === "object" && e && (e as { code?: string }).code === "P2002") return conflict(`${orig.docNumber} was already undone`);
      throw e;
    }
  }
}

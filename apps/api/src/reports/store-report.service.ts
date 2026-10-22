// Store report — every store on its own: what is left (with the selling price and its value),
// what was sold in a period (by payment, by item, by day) and a side-by-side of all stores.
// Staff see their own store and no cost or profit; the owner and manager see everything.

import type { ApiError } from "@sam-store/contracts";
import { prisma } from "../persistence/prisma-repositories.js";
import { dayRange, lineCost, manilaDate, ReportError, stockFlag } from "../domain/reports.js";
import { isLooseP } from "../domain/counting.js";
import { locationRefusal, type Actor } from "../people/people.service.js";

export type StoreReportResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const fail = (type: "validation" | "forbidden", m: string): { ok: false; error: ApiError } =>
  type === "validation" ? { ok: false, error: { type: "validation", errors: [m] } } : { ok: false, error: { type: "forbidden", message: m } };

const OWNERS = ["OWNER", "MANAGER", "STORE_OWNER", "PLATFORM_ADMIN"];
const isOwner = (a: Actor) => OWNERS.includes(a.role);
const MAX_DAYS = 93;
const MAX_DAYS_SALES = 366; // the sales report may cover a whole year

const productSelect = { id: true, name: true, priceMinor: true, costMinor: true, stockBaseUnit: true, stockBaseQuantity: true } as const;

/** Peso value of `qty` stock units at `unitMinor` (loose rice: stock is grams, price is per kilo). */
function valueOf(loose: boolean, qty: number, unitMinor: number): number {
  return loose ? Math.round((qty * unitMinor) / 1000) : qty * unitMinor;
}

type SalesTotalsOut = { count: number; totalMinor: number; cashMinor: number; gcashMinor: number; creditMinor: number; otherMinor: number; costMinor?: number; grossProfitMinor?: number };
type RecordRow = { at: string; kind: "SALE" | "STOCK" | "MONEY"; title: string; detail: string; store: string | null; docNumber: string | null; amountMinor: number | null; qtyText: string | null; balanceText: string | null; by: string | null };
type CompareRow = {
  location: { id: string; name: string; type: string }; sales: SalesTotalsOut; cashInMinor: number; creditGivenMinor: number; creditCollectedMinor: number;
  stock: { items: number; low: number; empty: number; valueMinor: number };
  owesMinor: number;
};

export class StoreReportService {
  /** The places the actor may look at. */
  private async places(storeId: string, actor: Actor, locationId: string | undefined) {
    const all = await prisma.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true, code: true, type: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
    const wanted = locationId ? all.filter((l) => l.id === locationId) : isOwner(actor) ? all : all.filter((l) => l.id === actor.homeLocationId);
    if (wanted.length === 0) return { res: fail("validation", "Choose a store"), wanted: null };
    for (const l of wanted) {
      const refusal = locationRefusal(actor, l.id);
      if (refusal) return { res: fail("forbidden", refusal), wanted: null };
    }
    return { res: null, wanted };
  }

  private range(from: string | undefined, to: string | undefined, maxDays = MAX_DAYS) {
    const today = manilaDate(new Date());
    const f = from || today;
    const t = to || f;
    const start = dayRange(f).from;
    const end = dayRange(t).to;
    if (end <= start) throw new ReportError("The end date is before the start date");
    if ((end.getTime() - start.getTime()) / 86_400_000 > maxDays) throw new ReportError(`Choose at most ${maxDays} days`);
    return { from: f, to: t, start, end };
  }

  // ─────────────────────────── Stock left ───────────────────────────

  private async stockRows(storeId: string, locationId: string, owner: boolean) {
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    const [used, levels, prices] = await Promise.all([
      prisma.stockMovement.groupBy({ by: ["productId"], where: { storeId, warehouseId: locationId, type: "CONSUME", createdAt: { gte: since } }, _sum: { delta: true } }),
      prisma.stockLevel.findMany({ where: { storeId, warehouseId: locationId }, select: { productId: true, quantityOnHand: true, quantityReserved: true } }),
      prisma.locationPrice.findMany({ where: { storeId, warehouseId: locationId }, select: { productId: true, priceMinor: true } }),
    ]);
    const products = await prisma.product.findMany({ where: { storeId, isActive: true, id: { in: levels.map((l) => l.productId) } }, select: productSelect, orderBy: { name: "asc" } });
    const priceBy = new Map(prices.map((p) => [p.productId, p.priceMinor]));
    const levelBy = new Map(levels.map((l) => [l.productId, l]));
    const perDay = new Map(used.map((u) => [u.productId, Math.abs(u._sum.delta ?? 0) / 14]));
    const rows = products.map((p) => {
      const loose = isLooseP(p);
      const l = levelBy.get(p.id)!;
      const unitPriceMinor = priceBy.get(p.id) ?? p.priceMinor;
      const available = l.quantityOnHand - l.quantityReserved;
      return {
        productId: p.id, name: p.name, loose, unit: loose ? "kg" : "pcs",
        onHand: l.quantityOnHand, reserved: l.quantityReserved, available, flag: stockFlag(loose, available),
        // About how many days the stock lasts at the pace of the last 2 weeks (null = nothing sold lately).
        daysLeft: (perDay.get(p.id) ?? 0) > 0 ? Math.max(0, Math.round(available / perDay.get(p.id)!)) : null,
        unitPriceMinor, valueMinor: valueOf(loose, Math.max(0, l.quantityOnHand), unitPriceMinor),
        ...(owner ? { costValueMinor: valueOf(loose, Math.max(0, l.quantityOnHand), p.costMinor) } : {}),
      };
    });
    return rows;
  }

  async stockLeft(storeId: string, actor: Actor, input: { locationId?: string }): Promise<StoreReportResult<{
    location: { id: string; name: string }; rows: Awaited<ReturnType<StoreReportService["stockRows"]>>;
    totals: { items: number; low: number; empty: number; valueMinor: number; costValueMinor?: number };
  }>> {
    const p = await this.places(storeId, actor, input.locationId ?? actor.homeLocationId ?? undefined);
    if (p.res) return p.res;
    const loc = p.wanted[0]!;
    const owner = isOwner(actor);
    const rows = await this.stockRows(storeId, loc.id, owner);
    return {
      ok: true,
      value: {
        location: { id: loc.id, name: loc.name }, rows,
        totals: {
          items: rows.length, low: rows.filter((r) => r.flag === "LOW").length, empty: rows.filter((r) => r.flag === "ZERO").length,
          valueMinor: rows.reduce((s, r) => s + r.valueMinor, 0),
          ...(owner ? { costValueMinor: rows.reduce((s, r) => s + ((r as { costValueMinor?: number }).costValueMinor ?? 0), 0) } : {}),
        },
      },
    };
  }

  // ─────────────────────────── Sales of one store ───────────────────────────

  private async salesOf(storeId: string, locationId: string, start: Date, end: Date, owner: boolean) {
    const range = { gte: start, lt: end };
    const [orders, payments, credits] = await Promise.all([
      prisma.order.findMany({
        where: { storeId, sellingLocationId: locationId, status: "COMPLETED", OR: [{ occurredAt: range }, { occurredAt: null, createdAt: range }] },
        select: { id: true, totalMinor: true, paymentMethod: true, occurredAt: true, createdAt: true, items: { select: { productId: true, productName: true, soldBy: true, quantity: true, grams: true, lineTotalMinor: true, unitCostMinor: true } } },
      }),
      prisma.payment.findMany({
        where: { storeId, type: "payment", receivedAt: range, OR: [{ locationId }, { locationId: null, order: { sellingLocationId: locationId } }] },
        select: { method: true, amountMinor: true, orderId: true },
      }),
      prisma.creditEntry.findMany({ where: { storeId, createdAt: range, type: "purchase", order: { sellingLocationId: locationId } }, select: { amountMinor: true } }),
    ]);
    const products = new Map((await prisma.product.findMany({ where: { storeId, id: { in: [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId).filter((x): x is string => !!x)))] } }, select: productSelect })).map((x) => [x.id, x]));
    const t = { count: orders.length, totalMinor: 0, cashMinor: 0, gcashMinor: 0, creditMinor: 0, otherMinor: 0, costMinor: 0 };
    const items = new Map<string, { name: string; loose: boolean; quantity: number; salesMinor: number; costMinor: number }>();
    const days = new Map<string, { count: number; totalMinor: number }>();
    // A split sale is counted by what each part actually paid (cash, GCash, or Maya/bank under "other").
    const splitIds = orders.filter((o) => o.paymentMethod === "split").map((o) => o.id);
    const splitPays = splitIds.length ? await prisma.payment.findMany({ where: { orderId: { in: splitIds }, type: "payment" }, select: { orderId: true, method: true, amountMinor: true } }) : [];
    for (const o of orders) {
      t.totalMinor += o.totalMinor;
      if (o.paymentMethod === "split") {
        let rest = o.totalMinor;
        for (const sp of splitPays.filter((x) => x.orderId === o.id)) {
          if (sp.method === "cash") t.cashMinor += sp.amountMinor; else if (sp.method === "gcash") t.gcashMinor += sp.amountMinor; else t.otherMinor += sp.amountMinor;
          rest -= sp.amountMinor;
        }
        if (rest > 0) t.otherMinor += rest;
      } else if (o.paymentMethod === "cash") t.cashMinor += o.totalMinor;
      else if (o.paymentMethod === "gcash") t.gcashMinor += o.totalMinor;
      else if (o.paymentMethod === "credit") t.creditMinor += o.totalMinor;
      else t.otherMinor += o.totalMinor;
      const day = manilaDate(o.occurredAt ?? o.createdAt);
      const d = days.get(day) ?? { count: 0, totalMinor: 0 };
      d.count++; d.totalMinor += o.totalMinor;
      days.set(day, d);
      for (const i of o.items) {
        const p = i.productId ? products.get(i.productId) : undefined;
        const loose = p ? isLooseP(p) : i.soldBy === "KILO" || i.soldBy === "PESO";
        const key = i.productId ?? i.productName;
        const cur = items.get(key) ?? { name: i.productName, loose, quantity: 0, salesMinor: 0, costMinor: 0 };
        cur.quantity += loose ? (i.grams ?? i.quantity) : i.quantity;
        cur.salesMinor += i.lineTotalMinor;
        items.set(key, cur);
        if (p) { const c = lineCost(i, p.costMinor, loose); t.costMinor += c; cur.costMinor += c; }
      }
    }
    return {
      sales: { count: t.count, totalMinor: t.totalMinor, cashMinor: t.cashMinor, gcashMinor: t.gcashMinor, creditMinor: t.creditMinor, otherMinor: t.otherMinor, ...(owner ? { costMinor: t.costMinor, grossProfitMinor: t.totalMinor - t.costMinor } : {}) },
      cashInMinor: payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amountMinor, 0),
      creditGivenMinor: credits.reduce((s, c) => s + c.amountMinor, 0),
      creditCollectedMinor: payments.filter((p) => !p.orderId && p.method !== "credit").reduce((s, p) => s + p.amountMinor, 0),
      items: [...items.values()].map((v) => ({ name: v.name, unit: v.loose ? "kg" : "pcs", quantity: v.loose ? v.quantity / 1000 : v.quantity, salesMinor: v.salesMinor, ...(owner ? { profitMinor: v.salesMinor - v.costMinor } : {}) })).sort((a, b) => b.salesMinor - a.salesMinor),
      days: [...days.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  }

  async sales(storeId: string, actor: Actor, input: { locationId?: string; from?: string; to?: string }) {
    try {
      const r = this.range(input.from, input.to, MAX_DAYS_SALES);
      const p = await this.places(storeId, actor, input.locationId ?? actor.homeLocationId ?? undefined);
      if (p.res) return p.res;
      const loc = p.wanted[0]!;
      const value = await this.salesOf(storeId, loc.id, r.start, r.end, isOwner(actor));
      return { ok: true as const, value: { location: { id: loc.id, name: loc.name }, from: r.from, to: r.to, ...value } };
    } catch (e) {
      if (e instanceof ReportError) return fail("validation", e.message);
      throw e;
    }
  }

  // ─────────────────────────── Top 10 customers (owner) ───────────────────────────

  /** The 10 customers who bought most often, and the 10 who spent most, in the last 30 days (all stores). */
  async topCustomers(storeId: string, actor: Actor) {
    try {
      if (!isOwner(actor)) return fail("forbidden", "Top customers is for the owner");
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const orders = await prisma.order.findMany({
        where: { storeId, status: { in: ["COMPLETED", "DELIVERED"] }, storeCustomerId: { not: null }, OR: [{ occurredAt: { gte: since } }, { occurredAt: null, createdAt: { gte: since } }] },
        select: { storeCustomerId: true, totalMinor: true, occurredAt: true, createdAt: true },
      });
      const by = new Map<string, { visits: number; totalMinor: number; lastAt: Date }>();
      for (const o of orders) {
        const at = o.occurredAt ?? o.createdAt;
        const cur = by.get(o.storeCustomerId!) ?? { visits: 0, totalMinor: 0, lastAt: at };
        cur.visits++; cur.totalMinor += o.totalMinor; if (at > cur.lastAt) cur.lastAt = at;
        by.set(o.storeCustomerId!, cur);
      }
      const names = new Map((await prisma.storeCustomer.findMany({ where: { id: { in: [...by.keys()] } }, select: { id: true, customer: { select: { name: true } } } })).map((c) => [c.id, c.customer.name ?? "Customer"]));
      const rows = [...by.entries()].map(([id, v]) => ({ id, name: names.get(id) ?? "Customer", visits: v.visits, totalMinor: v.totalMinor, lastAt: v.lastAt.toISOString() }));
      return {
        ok: true as const,
        value: {
          days: 30,
          byVisits: [...rows].sort((a, b) => b.visits - a.visits || b.totalMinor - a.totalMinor).slice(0, 10),
          byAmount: [...rows].sort((a, b) => b.totalMinor - a.totalMinor || b.visits - a.visits).slice(0, 10),
        },
      };
    } catch (e) {
      if (e instanceof ReportError) return fail("validation", e.message);
      throw e;
    }
  }

  // ─────────────────────────── All stores side by side (owner) ───────────────────────────

  async compare(storeId: string, actor: Actor, input: { from?: string; to?: string }) {
    try {
      if (!isOwner(actor)) return fail("forbidden", "Comparing stores is for the owner");
      const r = this.range(input.from, input.to);
      const p = await this.places(storeId, actor, undefined);
      if (p.res) return p.res;
      const stores: CompareRow[] = [];
      const owes = new Map((await prisma.storePayableEntry.groupBy({ by: ["locationId"], where: { storeId }, _sum: { amountMinor: true } })).map((x) => [x.locationId, x._sum.amountMinor ?? 0]));
      // One store at a time: the database pool is small.
      for (const l of p.wanted.filter((x) => x.type !== "BUFFER")) {
        const s = await this.salesOf(storeId, l.id, r.start, r.end, true);
        const stock = await this.stockRows(storeId, l.id, true);
        stores.push({
          location: { id: l.id, name: l.name, type: l.type }, sales: s.sales, cashInMinor: s.cashInMinor, creditGivenMinor: s.creditGivenMinor, creditCollectedMinor: s.creditCollectedMinor,
          stock: { items: stock.length, low: stock.filter((x) => x.flag === "LOW").length, empty: stock.filter((x) => x.flag === "ZERO").length, valueMinor: stock.reduce((a, x) => a + x.valueMinor, 0) },
          owesMinor: owes.get(l.id) ?? 0,
        });
      }
      const sum = (f: (x: (typeof stores)[number]) => number) => stores.reduce((a, x) => a + f(x), 0);
      return {
        ok: true as const,
        value: {
          from: r.from, to: r.to, stores,
          total: { salesMinor: sum((x) => x.sales.totalMinor), count: sum((x) => x.sales.count), grossProfitMinor: sum((x) => x.sales.grossProfitMinor ?? 0), creditGivenMinor: sum((x) => x.creditGivenMinor), stockValueMinor: sum((x) => x.stock.valueMinor), owesMinor: sum((x) => x.owesMinor) },
        },
      };
    } catch (e) {
      if (e instanceof ReportError) return fail("validation", e.message);
      throw e;
    }
  }
  // ─────────────────────────── Buffer store: the "to fix" list (owner) ───────────────────────────

  async buffer(storeId: string, actor: Actor): Promise<StoreReportResult<{
    buffer: { id: string; name: string } | null;
    owed: { productId: string; name: string; unit: string; quantity: number; valueMinor: number; oldestAt: string | null }[];
    surplus: { productId: string; name: string; unit: string; quantity: number }[];
    totals: { owedMinor: number; owedItems: number };
    entries: { at: string; productName: string; unit: string; quantity: number; orderNumber: string | null; store: string | null; by: string | null; what: string }[];
  }>> {
    if (!isOwner(actor)) return fail("forbidden", "The Buffer report is for the owner");
    const buf = await prisma.warehouse.findFirst({ where: { storeId, type: "BUFFER", isActive: true }, select: { id: true, name: true } });
    if (!buf) return { ok: true, value: { buffer: null, owed: [], surplus: [], totals: { owedMinor: 0, owedItems: 0 }, entries: [] } };
    const rows = await this.stockRows(storeId, buf.id, false);
    const moves = await prisma.stockMovement.findMany({
      where: { storeId, warehouseId: buf.id, delta: { lt: 0 } }, orderBy: { createdAt: "desc" }, take: 150,
      select: { createdAt: true, productId: true, delta: true, documentId: true, documentType: true, note: true, createdBy: true },
    });
    const orders = new Map((await prisma.order.findMany({ where: { storeId, id: { in: [...new Set(moves.filter((m) => m.documentType === "SALE").map((m) => m.documentId).filter((x): x is string => !!x))] } }, select: { id: true, orderNumber: true, sellingLocation: { select: { name: true } } } })).map((o) => [o.id, o]));
    const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.createdBy).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const prods = new Map((await prisma.product.findMany({ where: { storeId, id: { in: [...new Set(moves.map((m) => m.productId))] } }, select: productSelect })).map((x) => [x.id, x]));
    const oldest = new Map<string, Date>();
    for (const m of moves) oldest.set(m.productId, m.createdAt); // moves are newest first, so the last write is the oldest
    const owedRows = rows.filter((r) => r.onHand < 0);
    return {
      ok: true,
      value: {
        buffer: { id: buf.id, name: buf.name },
        owed: owedRows.map((r) => ({
          productId: r.productId, name: r.name, unit: r.unit, quantity: r.loose ? -r.onHand / 1000 : -r.onHand,
          valueMinor: valueOf(r.loose, -r.onHand, r.unitPriceMinor), oldestAt: oldest.get(r.productId)?.toISOString() ?? null,
        })),
        surplus: rows.filter((r) => r.onHand > 0).map((r) => ({ productId: r.productId, name: r.name, unit: r.unit, quantity: r.loose ? r.onHand / 1000 : r.onHand })),
        totals: { owedMinor: owedRows.reduce((s, r) => s + valueOf(r.loose, -r.onHand, r.unitPriceMinor), 0), owedItems: owedRows.length },
        entries: moves.slice(0, 40).map((m) => {
          const p = prods.get(m.productId);
          const loose = p ? isLooseP(p) : false;
          const o = m.documentId && m.documentType === "SALE" ? orders.get(m.documentId) : undefined;
          return { at: m.createdAt.toISOString(), productName: p?.name ?? "Item", unit: loose ? "kg" : "pcs", quantity: loose ? -m.delta / 1000 : -m.delta, orderNumber: o?.orderNumber ?? null, store: o?.sellingLocation?.name ?? null, by: m.createdBy ? users.get(m.createdBy) ?? null : null, what: (m.note ?? "").replace(/^Buffer covered: /, "") || (m.documentType === "SALE" ? "sale" : "stock out") };
        }),
      },
    };
  }
  // ─────────────────────────── All records: every transaction, one list ───────────────────────────

  async records(storeId: string, actor: Actor, input: { locationId?: string; from?: string; to?: string; productId?: string; kind?: string }): Promise<StoreReportResult<{
    from: string; to: string; truncated: boolean;
    records: RecordRow[];
  }>> {
    try {
      const r = this.range(input.from, input.to);
      const p = await this.places(storeId, actor, input.locationId || (isOwner(actor) ? undefined : actor.homeLocationId ?? undefined));
      if (p.res) return p.res;
      const ids = p.wanted.map((l) => l.id);
      const names = new Map(p.wanted.map((l) => [l.id, l.name]));
      const range = { gte: r.start, lt: r.end };
      const kind = input.kind === "sales" || input.kind === "stock" || input.kind === "money" ? input.kind : "all";
      const LIMIT = 250;

      const out: RecordRow[] = [];

      if (kind === "all" || kind === "sales") {
        const orders = await prisma.order.findMany({
          where: { storeId, sellingLocationId: { in: ids }, status: { in: ["COMPLETED", "CANCELLED"] }, OR: [{ occurredAt: range }, { occurredAt: null, createdAt: range }], ...(input.productId ? { items: { some: { productId: input.productId } } } : {}) },
          orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { id: true, orderNumber: true, status: true, source: true, totalMinor: true, paymentMethod: true, customerName: true, occurredAt: true, createdAt: true, sellingLocationId: true, items: { select: { productName: true, quantity: true, grams: true, soldBy: true } } },
        });
        for (const o of orders) {
          const what = o.items.map((i) => (i.soldBy === "PIECE" || !i.grams ? `${i.quantity} × ${i.productName}` : `${i.grams / 1000} kg ${i.productName}`)).join(", ");
          const pay = o.paymentMethod === "credit" ? "credit" : o.paymentMethod ?? "";
          out.push({
            at: (o.occurredAt ?? o.createdAt).toISOString(), kind: "SALE", title: o.status === "CANCELLED" ? "Sale cancelled" : "Sale",
            detail: `${what}${o.customerName && o.customerName !== "Walk-in" ? ` · ${o.customerName}` : ""}${pay ? ` · ${pay}` : ""}`,
            store: o.sellingLocationId ? names.get(o.sellingLocationId) ?? null : null, docNumber: o.orderNumber, amountMinor: o.totalMinor, qtyText: null, balanceText: null, by: null,
          });
        }
      }

      if (kind === "all" || kind === "money") {
        const pays = await prisma.payment.findMany({
          where: { storeId, type: { in: ["payment", "refund"] }, orderId: null, receivedAt: range, locationId: { in: ids } },
          orderBy: { receivedAt: "desc" }, take: LIMIT, select: { receivedAt: true, amountMinor: true, method: true, type: true, note: true, locationId: true, createdBy: true },
        });
        const who = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(pays.map((x) => x.createdBy).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
        for (const x of pays) {
          out.push({
            at: x.receivedAt.toISOString(), kind: "MONEY", title: x.type === "refund" ? "Refund" : "Credit payment received", detail: `${x.method}${x.note ? ` · ${x.note}` : ""}`,
            store: x.locationId ? names.get(x.locationId) ?? null : null, docNumber: null, amountMinor: x.amountMinor, qtyText: null, balanceText: null, by: x.createdBy ? who.get(x.createdBy) ?? null : null,
          });
        }
      }

      if (kind === "all" || kind === "stock") {
        const moves = await prisma.stockMovement.findMany({
          where: { storeId, warehouseId: { in: ids }, createdAt: range, type: { notIn: ["RESERVE", "RELEASE_RESERVATION"] }, ...(input.productId ? { productId: input.productId } : {}) },
          orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { createdAt: true, productId: true, warehouseId: true, delta: true, type: true, note: true, createdBy: true, balanceAfter: true, documentType: true, documentId: true },
        });
        const idsOf = (t: string) => [...new Set(moves.filter((m) => m.documentType === t).map((m) => m.documentId).filter((x): x is string => !!x))];
        const [prods, trs, ins, rsk, rets, ords, users] = await Promise.all([
          prisma.product.findMany({ where: { storeId, id: { in: [...new Set(moves.map((m) => m.productId))] } }, select: productSelect }),
          prisma.stockTransfer.findMany({ where: { storeId, id: { in: idsOf("TRANSFER").concat(idsOf("RELEASE")) } }, select: { id: true, docNumber: true } }),
          prisma.stockIn.findMany({ where: { storeId, id: { in: idsOf("STOCK_IN") } }, select: { id: true, docNumber: true } }),
          prisma.resackJob.findMany({ where: { storeId, id: { in: idsOf("RESACK") } }, select: { id: true, docNumber: true } }),
          prisma.stockReturn.findMany({ where: { storeId, id: { in: idsOf("RETURN") } }, select: { id: true, docNumber: true } }),
          prisma.order.findMany({ where: { storeId, id: { in: idsOf("SALE") } }, select: { id: true, orderNumber: true } }),
          prisma.user.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.createdBy).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
        ]);
        const pBy = new Map(prods.map((x) => [x.id, x]));
        const docBy = new Map<string, string>([...trs.map((x) => [x.id, x.docNumber ?? ""] as const), ...ins.map((x) => [x.id, x.docNumber] as const), ...rsk.map((x) => [x.id, x.docNumber] as const), ...rets.map((x) => [x.id, x.docNumber] as const), ...ords.map((x) => [x.id, x.orderNumber] as const)]);
        const uBy = new Map(users.map((u) => [u.id, u.name]));
        const LABEL: Record<string, string> = {
          CONSUME: "Sold / used", STOCK_IN: "Stock in", TRANSFER_OUT: "Moved out", TRANSFER_IN: "Moved in", RECEIVE_IN: "Moved in", RELEASE_OUT: "Taken out",
          RESACK_OUT: "Resack: sack opened", RESACK_IN: "Resack: packs made", RESACK_RETURN: "Resack cancelled", RETURN_IN: "Customer return", COUNT_ADJUST: "Count correction",
          ADJUST: "Adjustment", MERGE_IN: "Merged item", MERGE_OUT: "Merged item", CONVERSION_IN: "Conversion in", CONVERSION_OUT: "Conversion out", VOID_RESTORE: "Sale cancelled, stock back", RELEASE: "Stock back",
        };
        for (const m of moves) {
          const prod = pBy.get(m.productId);
          const loose = prod ? isLooseP(prod) : false;
          const fmt = (n: number) => (loose ? `${(n / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : `${n.toLocaleString("en-PH")} pcs`);
          out.push({
            at: m.createdAt.toISOString(), kind: "STOCK", title: LABEL[m.type] ?? m.type.replace(/_/g, " ").toLowerCase(),
            detail: `${prod?.name ?? "Item"}${m.note && !/^[A-Z]{2,3}-\d+$/.test(m.note) ? ` · ${m.note}` : ""}`,
            store: m.warehouseId ? names.get(m.warehouseId) ?? null : null, docNumber: m.documentId ? docBy.get(m.documentId) ?? null : null, amountMinor: null,
            qtyText: `${m.delta > 0 ? "+" : "−"}${fmt(Math.abs(m.delta))}`, balanceText: m.balanceAfter === null ? null : `now ${fmt(m.balanceAfter)}`, by: m.createdBy ? uBy.get(m.createdBy) ?? null : null,
          });
        }
      }

      out.sort((a, b) => (a.at < b.at ? 1 : -1));
      return { ok: true, value: { from: r.from, to: r.to, truncated: out.length > LIMIT, records: out.slice(0, LIMIT) } };
    } catch (e) {
      if (e instanceof ReportError) return fail("validation", e.message);
      throw e;
    }
  }
}

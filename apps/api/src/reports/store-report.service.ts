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

const productSelect = { id: true, name: true, priceMinor: true, costMinor: true, stockBaseUnit: true, stockBaseQuantity: true } as const;

/** Peso value of `qty` stock units at `unitMinor` (loose rice: stock is grams, price is per kilo). */
function valueOf(loose: boolean, qty: number, unitMinor: number): number {
  return loose ? Math.round((qty * unitMinor) / 1000) : qty * unitMinor;
}

export class StoreReportService {
  /** The places the actor may look at. */
  private async places(storeId: string, actor: Actor, locationId: string | undefined) {
    const all = await prisma.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true, code: true, type: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
    const wanted = locationId ? all.filter((l) => l.id === locationId) : isOwner(actor) ? all : all.filter((l) => l.id === actor.homeLocationId);
    if (wanted.length === 0) return { error: fail("validation", "Choose a store") } as const;
    for (const l of wanted) {
      const refusal = locationRefusal(actor, l.id);
      if (refusal) return { error: fail("forbidden", refusal) } as const;
    }
    return { all, wanted } as const;
  }

  private range(from: string | undefined, to: string | undefined) {
    const today = manilaDate(new Date());
    const f = from || today;
    const t = to || f;
    const start = dayRange(f).from;
    const end = dayRange(t).to;
    if (end <= start) throw new ReportError("The end date is before the start date");
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DAYS) throw new ReportError(`Choose at most ${MAX_DAYS} days`);
    return { from: f, to: t, start, end };
  }

  // ─────────────────────────── Stock left ───────────────────────────

  private async stockRows(storeId: string, locationId: string, owner: boolean) {
    const [levels, prices] = await Promise.all([
      prisma.stockLevel.findMany({ where: { storeId, warehouseId: locationId }, select: { productId: true, quantityOnHand: true, quantityReserved: true } }),
      prisma.locationPrice.findMany({ where: { storeId, warehouseId: locationId }, select: { productId: true, priceMinor: true } }),
    ]);
    const products = await prisma.product.findMany({ where: { storeId, isActive: true, id: { in: levels.map((l) => l.productId) } }, select: productSelect, orderBy: { name: "asc" } });
    const priceBy = new Map(prices.map((p) => [p.productId, p.priceMinor]));
    const levelBy = new Map(levels.map((l) => [l.productId, l]));
    const rows = products.map((p) => {
      const loose = isLooseP(p);
      const l = levelBy.get(p.id)!;
      const unitPriceMinor = priceBy.get(p.id) ?? p.priceMinor;
      const available = l.quantityOnHand - l.quantityReserved;
      return {
        productId: p.id, name: p.name, loose, unit: loose ? "kg" : "pcs",
        onHand: l.quantityOnHand, reserved: l.quantityReserved, available, flag: stockFlag(loose, available),
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
    if ("error" in p) return p.error;
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
    const items = new Map<string, { name: string; loose: boolean; quantity: number; salesMinor: number }>();
    const days = new Map<string, { count: number; totalMinor: number }>();
    for (const o of orders) {
      t.totalMinor += o.totalMinor;
      if (o.paymentMethod === "cash") t.cashMinor += o.totalMinor;
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
        const cur = items.get(key) ?? { name: i.productName, loose, quantity: 0, salesMinor: 0 };
        cur.quantity += loose ? (i.grams ?? i.quantity) : i.quantity;
        cur.salesMinor += i.lineTotalMinor;
        items.set(key, cur);
        if (p) t.costMinor += lineCost(i, p.costMinor, loose);
      }
    }
    return {
      sales: { count: t.count, totalMinor: t.totalMinor, cashMinor: t.cashMinor, gcashMinor: t.gcashMinor, creditMinor: t.creditMinor, otherMinor: t.otherMinor, ...(owner ? { costMinor: t.costMinor, grossProfitMinor: t.totalMinor - t.costMinor } : {}) },
      cashInMinor: payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amountMinor, 0),
      creditGivenMinor: credits.reduce((s, c) => s + c.amountMinor, 0),
      creditCollectedMinor: payments.filter((p) => !p.orderId && p.method !== "credit").reduce((s, p) => s + p.amountMinor, 0),
      items: [...items.values()].map((v) => ({ name: v.name, unit: v.loose ? "kg" : "pcs", quantity: v.loose ? v.quantity / 1000 : v.quantity, salesMinor: v.salesMinor })).sort((a, b) => b.salesMinor - a.salesMinor),
      days: [...days.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  }

  async sales(storeId: string, actor: Actor, input: { locationId?: string; from?: string; to?: string }) {
    try {
      const r = this.range(input.from, input.to);
      const p = await this.places(storeId, actor, input.locationId ?? actor.homeLocationId ?? undefined);
      if ("error" in p) return p.error;
      const loc = p.wanted[0]!;
      const value = await this.salesOf(storeId, loc.id, r.start, r.end, isOwner(actor));
      return { ok: true as const, value: { location: { id: loc.id, name: loc.name }, from: r.from, to: r.to, ...value } };
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
      if ("error" in p) return p.error;
      const stores = [];
      // One store at a time: the database pool is small.
      for (const l of p.wanted) {
        const s = await this.salesOf(storeId, l.id, r.start, r.end, true);
        const stock = await this.stockRows(storeId, l.id, true);
        stores.push({
          location: { id: l.id, name: l.name, type: l.type }, sales: s.sales, cashInMinor: s.cashInMinor, creditGivenMinor: s.creditGivenMinor, creditCollectedMinor: s.creditCollectedMinor,
          stock: { items: stock.length, low: stock.filter((x) => x.flag === "LOW").length, empty: stock.filter((x) => x.flag === "ZERO").length, valueMinor: stock.reduce((a, x) => a + x.valueMinor, 0) },
        });
      }
      const sum = (f: (x: (typeof stores)[number]) => number) => stores.reduce((a, x) => a + f(x), 0);
      return {
        ok: true as const,
        value: {
          from: r.from, to: r.to, stores,
          total: { salesMinor: sum((x) => x.sales.totalMinor), count: sum((x) => x.sales.count), grossProfitMinor: sum((x) => x.sales.grossProfitMinor ?? 0), creditGivenMinor: sum((x) => x.creditGivenMinor), stockValueMinor: sum((x) => x.stock.valueMinor) },
        },
      };
    } catch (e) {
      if (e instanceof ReportError) return fail("validation", e.message);
      throw e;
    }
  }
}

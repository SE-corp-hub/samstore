// Weekly owner summary — one page for the owner and manager, made from the numbers the other reports already keep:
//   sales this week against last week for each store, credit given and collected, what Store 2 (the consignment store) owes and
//   when it last paid, what is owed to suppliers and which orders are late, count shortages by reason, and what is running out.
// Read-only. The week is the 7 days ending on the chosen day (today by default); last week is the 7 days before that.

import type { ApiError } from "@sam-store/contracts";
import { prisma } from "../persistence/prisma-repositories.js";
import { manilaDate } from "../domain/reports.js";
import { changePct, daysSince, weekRanges, type WeekRanges } from "../domain/weekly.js";
import type { Actor } from "../people/people.service.js";
import { CountService } from "../counts/count.service.js";
import { PurchaseOrderService } from "../purchase-orders/purchase-order.service.js";
import { StoreReportService } from "./store-report.service.js";

export type WeeklyResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const OWNERS = ["OWNER", "MANAGER", "STORE_OWNER", "PLATFORM_ADMIN"];
const DAY_MS = 86_400_000;

export interface WeeklyStore { id: string; name: string; thisMinor: number; lastMinor: number; changePct: number | null; count: number; profitMinor: number }
export interface WeeklyConsignment { id: string; name: string; owesMinor: number; paidThisWeekMinor: number; lastPaymentAt: string | null; daysSincePayment: number | null; late: boolean }
export interface WeeklySupplier { id: string; name: string; owedMinor: number; overdueOrders: number }
export interface WeeklyReason { code: string; label: string; items: number; shortValueMinor: number; overValueMinor: number }
export interface WeeklyRunning { productId: string; name: string; loose: boolean; urgency: "OUT" | "NOW" | "SOON"; daysLeft: number | null; suggestedQty: number }
export interface WeeklySummary {
  from: string; to: string; lastFrom: string; lastTo: string;
  sales: { stores: WeeklyStore[]; total: { thisMinor: number; lastMinor: number; changePct: number | null; count: number; profitMinor: number } };
  credit: { givenMinor: number; collectedMinor: number; owedNowMinor: number; customersOwing: number };
  consignment: WeeklyConsignment[];
  suppliers: { owedMinor: number; pendingMinor: number; lateOrders: number; top: WeeklySupplier[] };
  counts: { counts: number; items: number; short: number; over: number; kulangValueMinor: number; sobraValueMinor: number; byReason: WeeklyReason[] };
  running: { total: number; items: WeeklyRunning[] };
}

export class WeeklySummaryService {
  private readonly storeReports = new StoreReportService();
  private readonly counts = new CountService();
  private readonly orders = new PurchaseOrderService();

  async summary(storeId: string, actor: Actor, input: { to?: string }): Promise<WeeklyResult<WeeklySummary>> {
    if (!OWNERS.includes(actor.role)) return { ok: false, error: { type: "forbidden", message: "The weekly summary is for the owner and manager" } };
    let w: WeekRanges;
    try { w = weekRanges(input.to || manilaDate(new Date())); } catch { return { ok: false, error: { type: "validation", errors: ["Wrong date"] } }; }
    if (w.thisTo > manilaDate(new Date())) return { ok: false, error: { type: "validation", errors: ["Choose today or an earlier day"] } };

    // Sales: one store at a time inside compare (the database pool is small), this week then last week.
    const thisWeek = await this.storeReports.compare(storeId, actor, { from: w.thisFrom, to: w.thisTo });
    if (!thisWeek.ok) return thisWeek;
    const lastWeek = await this.storeReports.compare(storeId, actor, { from: w.lastFrom, to: w.lastTo });
    if (!lastWeek.ok) return lastWeek;
    const lastBy = new Map(lastWeek.value.stores.map((s) => [s.location.id, s]));
    const stores: WeeklyStore[] = thisWeek.value.stores
      .filter((s) => s.location.type !== "WAREHOUSE" || s.sales.count > 0 || (lastBy.get(s.location.id)?.sales.count ?? 0) > 0)
      .map((s) => {
        const last = lastBy.get(s.location.id)?.sales.totalMinor ?? 0;
        return { id: s.location.id, name: s.location.name, thisMinor: s.sales.totalMinor, lastMinor: last, changePct: changePct(s.sales.totalMinor, last), count: s.sales.count, profitMinor: s.sales.grossProfitMinor ?? 0 };
      });
    const sum = (f: (s: WeeklyStore) => number) => stores.reduce((a, s) => a + f(s), 0);
    const totalThis = sum((s) => s.thisMinor);
    const totalLast = sum((s) => s.lastMinor);

    // Credit
    const owingRows = await prisma.creditEntry.groupBy({ by: ["storeCustomerId"], where: { storeId }, _sum: { amountMinor: true }, having: { amountMinor: { _sum: { gt: 0 } } } });
    const credit = {
      givenMinor: thisWeek.value.stores.reduce((a, s) => a + s.creditGivenMinor, 0),
      collectedMinor: thisWeek.value.stores.reduce((a, s) => a + s.creditCollectedMinor, 0),
      owedNowMinor: owingRows.reduce((a, r) => a + (r._sum.amountMinor ?? 0), 0),
      customersOwing: owingRows.length,
    };

    // The consignment store: what it owes the main store and when it last paid
    const now = new Date();
    const consignStores = await prisma.warehouse.findMany({ where: { storeId, isActive: true, consignment: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    const consignment: WeeklyConsignment[] = [];
    if (consignStores.length > 0) {
      const ids = consignStores.map((c) => c.id);
      const weekStart = new Date(`${w.thisFrom}T00:00:00+08:00`);
      const owes = await prisma.storePayableEntry.groupBy({ by: ["locationId"], where: { storeId, locationId: { in: ids } }, _sum: { amountMinor: true } });
      const paid = await prisma.storePayableEntry.groupBy({ by: ["locationId"], where: { storeId, locationId: { in: ids }, kind: "PAYMENT", createdAt: { gte: weekStart } }, _sum: { amountMinor: true } });
      const lastPay = await prisma.storePayableEntry.groupBy({ by: ["locationId"], where: { storeId, locationId: { in: ids }, kind: "PAYMENT" }, _max: { createdAt: true } });
      const firstCharge = await prisma.storePayableEntry.groupBy({ by: ["locationId"], where: { storeId, locationId: { in: ids }, kind: "CHARGE" }, _min: { createdAt: true } });
      for (const c of consignStores) {
        const owesMinor = owes.find((x) => x.locationId === c.id)?._sum.amountMinor ?? 0;
        const last = lastPay.find((x) => x.locationId === c.id)?._max.createdAt ?? null;
        const since = last ?? firstCharge.find((x) => x.locationId === c.id)?._min.createdAt ?? null;
        consignment.push({
          id: c.id, name: c.name, owesMinor, paidThisWeekMinor: -(paid.find((x) => x.locationId === c.id)?._sum.amountMinor ?? 0),
          lastPaymentAt: last ? last.toISOString() : null, daysSincePayment: daysSince(last, now),
          late: owesMinor > 0 && !!since && since.getTime() < now.getTime() - 7 * DAY_MS,
        });
      }
    }

    // Suppliers
    const bal = await this.orders.balances(storeId);
    if (!bal.ok) return bal;
    const supplierRows = bal.value.suppliers;
    const suppliers = {
      owedMinor: bal.value.totalOwedMinor, pendingMinor: bal.value.totalPendingMinor, lateOrders: supplierRows.reduce((a, s) => a + s.overdueOrders, 0),
      top: supplierRows.filter((s) => s.owedMinor > 0 || s.overdueOrders > 0).slice(0, 5).map((s) => ({ id: s.id, name: s.name, owedMinor: s.owedMinor, overdueOrders: s.overdueOrders })),
    };

    // Counts this week
    const cr = await this.counts.reportList(storeId, actor, { from: w.thisFrom, to: w.thisTo });
    if (!cr.ok) return cr;
    const t = cr.value.totals;
    const countsPart = {
      counts: t.counts, items: t.items, short: t.short, over: t.over, kulangValueMinor: t.kulangValueMinor, sobraValueMinor: t.sobraValueMinor,
      byReason: cr.value.byReason.slice(0, 8).map((r) => ({ code: r.code, label: r.label, items: r.items, shortValueMinor: r.shortValueMinor, overValueMinor: r.overValueMinor })),
    };

    // Running out
    const re = await this.orders.reorder(storeId);
    if (!re.ok) return re;
    const running = {
      total: re.value.items.length,
      items: re.value.items.slice(0, 8).map((i) => ({ productId: i.productId, name: i.name, loose: i.loose, urgency: i.urgency, daysLeft: i.daysLeft, suggestedQty: i.suggestedQty })),
    };

    return {
      ok: true,
      value: {
        from: w.thisFrom, to: w.thisTo, lastFrom: w.lastFrom, lastTo: w.lastTo,
        sales: { stores, total: { thisMinor: totalThis, lastMinor: totalLast, changePct: changePct(totalThis, totalLast), count: sum((s) => s.count), profitMinor: sum((s) => s.profitMinor) } },
        credit, consignment, suppliers, counts: countsPart, running,
      },
    };
  }
}

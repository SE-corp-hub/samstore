// Analytics service — tenant-scoped sales/order/product summaries.
// All aggregation is pure SQL/Prisma; numbers come from the DB, never fabricated.

import { currentWall, orderWall } from "../auth/wall.js";
import { dayRange, manilaDate } from "../domain/reports.js";
import { bookTotals, salesBook } from "../reports/sales-book.js";
import { prisma } from "../persistence/prisma-repositories.js";

export class AnalyticsService {
  /** Overall dashboard numbers for a store. */
  async summary(storeId: string) {
    const [totalOrders, deliveredOrders, revenueAgg, uniqueCustomers, lowStock] = await Promise.all([
      prisma.order.count({ where: { storeId } }),
      prisma.order.count({ where: { storeId, status: "DELIVERED" } }),
      prisma.order.aggregate({ where: { storeId }, _sum: { totalMinor: true } }),
      prisma.order.findMany({ where: { storeId }, distinct: ["customerPhone"], select: { customerPhone: true } }),
      prisma.stockLevel.findMany({
        where: { storeId, quantityOnHand: { lte: prisma.stockLevel.fields.reorderThreshold } },
        include: { product: { select: { name: true, sku: true } } },
        take: 10,
      }),
    ]);

    return {
      totalOrders,
      deliveredOrders,
      revenueMinor: revenueAgg._sum.totalMinor ?? 0,
      uniqueCustomers: uniqueCustomers.length,
      lowStock: lowStock.map((s) => ({ name: s.product.name, sku: s.product.sku, quantityOnHand: s.quantityOnHand, reorderThreshold: s.reorderThreshold })),
    };
  }

  /** Order status distribution (funnel). */
  async statusBreakdown(storeId: string) {
    const rows = await prisma.order.groupBy({
      by: ["status"],
      where: { storeId, AND: [orderWall()] }, // step 6: a store login counts its own store's orders
      _count: { _all: true },
      _sum: { totalMinor: true },
    });
    return rows.map((r) => ({ status: r.status, count: r._count._all, revenueMinor: r._sum.totalMinor ?? 0 }));
  }

  /**
   * Sales and their count by Manila day (last N days, today last): the "Today's sales" card and the
   * 7-day chart. Read from the sales book like every other report (2026-11-21 bug hunt): only sales
   * that were handed over, on the Manila day they were sold (a 6 AM sale is today, not yesterday in
   * UTC), a refunded or voided sale taken off on the day it was taken back. A store login sees its store.
   */
  async dailyRevenue(storeId: string, days = 14): Promise<{ days: { date: string; count: number; revenueMinor: number }[] }> {
    const n = Math.max(1, Math.floor(days));
    const dates = Array.from({ length: n }, (_, i) => manilaDate(new Date(Date.now() - (n - 1 - i) * 86_400_000)));
    const range = { gte: dayRange(dates[0]!).from, lt: dayRange(dates[n - 1]!).to };
    const wall = currentWall();
    const book = await salesBook(prisma, storeId, range, wall ? { locationId: wall.locationId, mainId: wall.mainId } : {});
    const byDay = new Map<string, typeof book.entries>();
    for (const e of book.entries) {
      const d = manilaDate(e.at);
      byDay.set(d, [...(byDay.get(d) ?? []), e]);
    }
    return {
      days: dates.map((date) => {
        const t = bookTotals(byDay.get(date) ?? [], book.splits);
        return { date, count: t.count, revenueMinor: t.totalMinor };
      }),
    };
  }

  /** Top products by quantity sold. */
  async topProducts(storeId: string, limit = 5) {
    const agg = await prisma.orderItem.groupBy({
      by: ["productName", "sku"],
      where: { storeId },
      _sum: { quantity: true, lineTotalMinor: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: limit,
    });
    return agg.map((r) => ({ name: r.productName, sku: r.sku, qty: r._sum.quantity ?? 0, revenueMinor: r._sum.lineTotalMinor ?? 0 }));
  }

  /** Voucher usage summary. */
  async voucherUsage(storeId: string) {
    return prisma.voucher.findMany({
      where: { storeId },
      include: { _count: { select: { redemptions: true } } },
      orderBy: { createdAt: "desc" },
    }).then((vs) => vs.map((v) => ({ code: v.code, discountMinor: v.discountMinor, redemptionCount: v._count.redemptions, maxRedemptions: v.maxRedemptions, isActive: v.isActive })));
  }
}
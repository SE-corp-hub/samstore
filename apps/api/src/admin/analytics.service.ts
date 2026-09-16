// Analytics service — tenant-scoped sales/order/product summaries.
// All aggregation is pure SQL/Prisma; numbers come from the DB, never fabricated.

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
      where: { storeId },
      _count: { _all: true },
      _sum: { totalMinor: true },
    });
    return rows.map((r) => ({ status: r.status, count: r._count._all, revenueMinor: r._sum.totalMinor ?? 0 }));
  }

  /** Revenue + order count by day (last N days). */
  async dailyRevenue(storeId: string, days = 14): Promise<{ days: { date: string; count: number; revenueMinor: number }[] }> {
    const since = new Date(Date.now() - days * 86_400_000);
    const orders = await prisma.order.findMany({
      where: { storeId, createdAt: { gte: since } },
      select: { createdAt: true, totalMinor: true },
    });
    const byDay = new Map<string, { count: number; revenueMinor: number }>();
    for (const o of orders) {
      const date = o.createdAt.toISOString().slice(0, 10);
      const cur = byDay.get(date) ?? { count: 0, revenueMinor: 0 };
      cur.count += 1;
      cur.revenueMinor += o.totalMinor;
      byDay.set(date, cur);
    }
    const out: { date: string; count: number; revenueMinor: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ date: d, ...(byDay.get(d) ?? { count: 0, revenueMinor: 0 }) });
    }
    return { days: out };
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
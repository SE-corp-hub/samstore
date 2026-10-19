// Reports — profit summary, sales splits, utang aging, top customers.
// Decision #9: profit/expense/COGS visible ONLY to OWNER + MANAGER (enforced in controller).
// COGS uses latest purchase cost (Product.costMinor) — labeled as an estimate.
// M8: five read-only report screens (Stock low, Sold stock, Income & Loss, Sales by payment, Customer statement).

import { prisma } from "../persistence/prisma-repositories.js";

export const REPORTS_SERVICE = Symbol("REPORTS_SERVICE");

export class ReportsService {
  /** Fulfilled orders in period (DELIVERED or COMPLETED — excludes CANCELLED/voided). */
  private async fulfilledOrders(storeId: string, from: Date, to: Date) {
    return prisma.order.findMany({
      where: { storeId, status: { in: ["DELIVERED", "COMPLETED"] }, createdAt: { gte: from, lte: to } },
      include: {
        items: { include: { product: { select: { name: true, sku: true, costMinor: true } } } },
        payments: { where: { type: "refund" }, select: { amountMinor: true } },
      },
    });
  }

  /** Profit summary: revenue − refunds − COGS − expenses. COGS is an estimate. */
  async profitSummary(storeId: string, from: Date, to: Date) {
    const orders = await this.fulfilledOrders(storeId, from, to);
    const revenue = orders.reduce((s, o) => s + o.totalMinor, 0);
    const refunds = orders.reduce((s, o) => s + o.payments.reduce((r, p) => r + Math.abs(p.amountMinor), 0), 0);
    let cogs = 0;
    let cogsEstimatedUnits = 0;
    for (const o of orders) {
      for (const it of o.items) {
        const cost = it.product?.costMinor ?? 0;
        cogs += it.quantity * cost;
        if (cost <= 0) cogsEstimatedUnits += it.quantity;
      }
    }
    const expensesRows = await prisma.expense.findMany({ where: { storeId, spentAt: { gte: from, lte: to } } });
    const expenses = expensesRows.reduce((s, e) => s + e.amountMinor, 0);
    const netRevenue = revenue - refunds;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      revenueMinor: revenue,
      refundsMinor: refunds,
      netRevenueMinor: netRevenue,
      cogsMinor: cogs,
      cogsEstimatedUnits,
      expensesMinor: expenses,
      profitMinor: netRevenue - cogs - expenses,
      ordersCount: orders.length,
      cogsNote: cogsEstimatedUnits > 0
        ? `COGS is an estimate: ${cogsEstimatedUnits} unit(s) sold had no purchase cost on record (counted at ₱0).`
        : "COGS uses the latest purchase cost per product.",
    };
  }

  /** Sales split by payment method + top customers + utang aging. */
  async salesReport(storeId: string, from: Date, to: Date) {
    const orders = await this.fulfilledOrders(storeId, from, to);
    const byMethod: Record<string, number> = {};
    for (const o of orders) byMethod[o.paymentMethod] = (byMethod[o.paymentMethod] ?? 0) + o.totalMinor;

    const byCustomer = new Map<string, { name: string; totalMinor: number; orders: number }>();
    for (const o of orders) {
      const key = o.customerName || "Walk-in";
      const cur = byCustomer.get(key) ?? { name: key, totalMinor: 0, orders: 0 };
      cur.totalMinor += o.totalMinor;
      cur.orders += 1;
      byCustomer.set(key, cur);
    }
    const topCustomers = [...byCustomer.values()].sort((a, b) => b.totalMinor - a.totalMinor).slice(0, 10);

    // Utang aging: per customer with balance, age from their oldest purchase entry.
    const debtors = await prisma.storeCustomer.findMany({
      where: { storeId, creditBalanceMinor: { gt: 0 } },
      include: {
        customer: { select: { name: true } },
        credit: { where: { type: "purchase" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } },
      },
    });
    const now = Date.now();
    const rows = debtors.map((d) => {
      const oldest = d.credit[0]?.createdAt.getTime() ?? now;
      const days = Math.floor((now - oldest) / 86_400_000);
      return { name: d.customer.name ?? "Customer", balanceMinor: d.creditBalanceMinor, daysOld: days, bucket: days > 30 ? "over30" : "current" } as { name: string; balanceMinor: number; daysOld: number; bucket: string };
    });
    const aging = {
      currentMinor: rows.filter((r) => r.bucket === "current").reduce((s, r) => s + r.balanceMinor, 0),
      over30Minor: rows.filter((r) => r.bucket === "over30").reduce((s, r) => s + r.balanceMinor, 0),
      rows,
    };

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      paymentSplit: Object.entries(byMethod).map(([method, totalMinor]) => ({ method, totalMinor })),
      topCustomers,
      utangAging: aging,
    };
  }

  // ─────────────────────────────── M8 reports ───────────────────────────────

  /** Stock (low): products where available ≤ reorder threshold. */
  async stockLow(storeId: string, from: Date, to: Date) {
    const products = await prisma.product.findMany({
      where: { storeId, isActive: true, stockLevels: { some: {} } },
      include: { stockLevels: true },
    });
    const rows = products
      .filter((p) => p.trackStock !== false) // not tracked = never "low"
      .map((p) => {
        const available = p.stockLevels.reduce((s, l) => s + (l.quantityOnHand - l.quantityReserved), 0);
        const threshold = Math.max(...p.stockLevels.map((l) => l.reorderThreshold), 0);
        return { id: p.id, name: p.name, sku: p.sku, barcode: p.barcode ?? null, unit: p.unit ?? null, availableQuantity: available, reorderThreshold: threshold, low: threshold > 0 && available <= threshold };
      })
      .filter((p) => p.low)
      .sort((a, b) => a.availableQuantity - b.availableQuantity);
    return { from: from.toISOString(), to: to.toISOString(), rows, count: rows.length };
  }

  /** Sold stock: quantity sold per product in period. */
  async soldStock(storeId: string, from: Date, to: Date) {
    const orders = await this.fulfilledOrders(storeId, from, to);
    const byProduct = new Map<string, { name: string; sku: string; sold: number }>();
    for (const o of orders) {
      for (const it of o.items) {
        const product = it.product;
        if (!product) continue;
        const pid = it.productId;
        if (!pid) continue;
        const cur = byProduct.get(pid) ?? { name: product.name, sku: product.sku, sold: 0 };
        cur.sold += it.quantity;
        byProduct.set(pid, cur);
      }
    }
    const rows = [...byProduct.values()].sort((a, b) => b.sold - a.sold);
    return { from: from.toISOString(), to: to.toISOString(), rows, totalUnitsSold: rows.reduce((s, r) => s + r.sold, 0) };
  }

  /** Income & Loss: detailed breakdown — income by source, expense categories, net. */
  async incomeLoss(storeId: string, from: Date, to: Date) {
    const orders = await this.fulfilledOrders(storeId, from, to);
    const revenue = orders.reduce((s, o) => s + o.totalMinor, 0);
    const refunds = orders.reduce((s, o) => s + o.payments.reduce((r, p) => r + Math.abs(p.amountMinor), 0), 0);
    const netRevenue = revenue - refunds;

    const expensesRows = await prisma.expense.findMany({ where: { storeId, spentAt: { gte: from, lte: to } }, select: { category: true, amountMinor: true, note: true } });
    const byCategory: Record<string, number> = {};
    for (const e of expensesRows) byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amountMinor;
    const expenseTotal = expensesRows.reduce((s, e) => s + e.amountMinor, 0);

    let cogs = 0;
    for (const o of orders) {
      for (const it of o.items) {
        const product = it.product;
        if (!product) continue;
        cogs += it.quantity * product.costMinor;
      }
    }
    const profit = netRevenue - cogs - expenseTotal;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      income: { revenueMinor: revenue, refundsMinor: refunds, netRevenueMinor: netRevenue, ordersCount: orders.length },
      expenses: { totalMinor: expenseTotal, byCategory, lineItems: expensesRows.map((e) => ({ category: e.category, amountMinor: e.amountMinor, note: e.note })) },
      cogsMinor: cogs,
      profitMinor: profit,
    };
  }

  /** Sales by payment method — detailed breakdown. */
  async salesByPayment(storeId: string, from: Date, to: Date) {
    const orders = await this.fulfilledOrders(storeId, from, to);
    const byMethod = new Map<string, { totalMinor: number; count: number }>();
    for (const o of orders) {
      const cur = byMethod.get(o.paymentMethod) ?? { totalMinor: 0, count: 0 };
      cur.totalMinor += o.totalMinor;
      cur.count += 1;
      byMethod.set(o.paymentMethod, cur);
    }
    const rows: { method: string; totalMinor: number; orders: number; avgMinor: number }[] = [];
    for (const [method, v] of byMethod) {
      rows.push({ method, totalMinor: v.totalMinor, orders: v.count, avgMinor: Math.round(v.totalMinor / v.count) });
    }
    rows.sort((a, b) => b.totalMinor - a.totalMinor);
    const grandTotal = rows.reduce((s, r) => s + r.totalMinor, 0);
    return { from: from.toISOString(), to: to.toISOString(), rows, grandTotal };
  }

  /** Customer statement: per-customer ledger with orders, payments, credits, balance. */
  async customerStatement(storeId: string, from: Date, to: Date) {
    const orders = await this.fulfilledOrders(storeId, from, to);
    const byCustomer = new Map<string, { name: string; totalPaid: number; orders: number; firstOrderAt: Date | null; lastOrderAt: Date | null }>();
    for (const o of orders) {
      const key = o.customerName || "Walk-in";
      const cur = byCustomer.get(key) ?? { name: key, totalPaid: 0, orders: 0, firstOrderAt: null, lastOrderAt: null };
      cur.totalPaid += o.totalMinor;
      cur.orders += 1;
      const created = o.createdAt;
      if (!cur.firstOrderAt || created < cur.firstOrderAt) cur.firstOrderAt = created;
      if (!cur.lastOrderAt || created > cur.lastOrderAt) cur.lastOrderAt = created;
      byCustomer.set(key, cur);
    }

    // Credit balances from StoreCustomer.
    const creditBalances = await prisma.storeCustomer.findMany({
      where: { storeId, creditBalanceMinor: { gt: 0 } },
      include: { customer: { select: { name: true } } },
    });
    const creditMap = new Map(creditBalances.map((c) => [c.customer.name ?? "Walk-in", c.creditBalanceMinor]));

    const rows = [...byCustomer.values()].map((c) => {
      const creditBalance = creditMap.get(c.name) ?? 0;
      const balance = c.totalPaid - creditBalance;
      return {
        name: c.name,
        totalPaidMinor: c.totalPaid,
        creditBalanceMinor: creditBalance,
        balanceMinor: balance,
        orders: c.orders,
        firstOrderAt: c.firstOrderAt?.toISOString() ?? null,
        lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
      };
    });
    rows.sort((a, b) => b.balanceMinor - a.balanceMinor);
    return { from: from.toISOString(), to: to.toISOString(), rows, totalPaidMinor: rows.reduce((s, r) => s + r.totalPaidMinor, 0), totalCreditMinor: rows.reduce((s, r) => s + r.creditBalanceMinor, 0) };
  }
}
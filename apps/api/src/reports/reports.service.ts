// Reports — profit summary, sales splits, utang aging, top customers.
// Decision #9: profit/expense/COGS visible ONLY to OWNER + MANAGER (enforced in controller).
// M8: five read-only report screens (Stock low, Sold stock, Income & Loss, Sales by payment, Customer statement).
//
// Per-store build, step 1c: this screen reads sales from the SALES BOOK (`sales-book.ts`), the same
// as the daily report, the month report and Compare stores, so its totals are the stores' totals
// added up. A sale counts on the day it was sold, a sale taken back counts off on the day it was
// taken back, and the cost is the cost saved with each sale.

import { prisma } from "../persistence/prisma-repositories.js";
import { bookLines, bookTotals, salesBook, type BookEntry } from "./sales-book.js";

export const REPORTS_SERVICE = Symbol("REPORTS_SERVICE");

const productSelect = { id: true, name: true, sku: true, costMinor: true, stockBaseUnit: true, stockBaseQuantity: true } as const;

export class ReportsService {
  /** The whole business in the period, from the sales book: what was sold, what was taken back, and the cost. */
  private async sold(storeId: string, from: Date, to: Date) {
    // The screen asks "up to this moment", the book reads "before": one millisecond covers the difference.
    const book = await salesBook(prisma, storeId, { gte: from, lt: new Date(to.getTime() + 1) });
    const ids = [...new Set(book.entries.flatMap((e) => e.items.map((i) => i.productId).filter((x): x is string => !!x)))];
    const products = new Map((ids.length ? await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: productSelect }) : []).map((p) => [p.id, p]));
    const lines = bookLines(book.entries, (id) => products.get(id));
    const money = bookTotals(book.entries, book.splits);
    const revenue = book.entries.filter((e) => e.sign === 1).reduce((s, e) => s + e.totalMinor, 0);
    return {
      book, lines, money,
      /** Everything sold in the period, before the sales taken back. */
      revenue,
      refunds: money.takenBack.totalMinor,
      cogs: lines.reduce((s, l) => s + l.costMinor, 0),
      /** Units sold whose product has no cost on record at all (their cost counts as ₱0). */
      noCostUnits: lines.filter((l) => l.entry.sign === 1 && (l.line.unitCostMinor ?? l.product?.costMinor ?? 0) <= 0).reduce((s, l) => s + l.line.quantity, 0),
    };
  }

  /** The book's entries with their sign applied, grouped by a key. */
  private group<K>(entries: BookEntry[], keyOf: (e: BookEntry) => K) {
    const by = new Map<K, BookEntry[]>();
    for (const e of entries) by.set(keyOf(e), [...(by.get(keyOf(e)) ?? []), e]);
    return by;
  }

  /** Profit summary: sales − sales taken back − cost of what was sold − expenses. */
  async profitSummary(storeId: string, from: Date, to: Date) {
    const s = await this.sold(storeId, from, to);
    const expensesRows = await prisma.expense.findMany({ where: { storeId, voidedAt: null, spentAt: { gte: from, lte: to } } });
    const expenses = expensesRows.reduce((a, e) => a + e.amountMinor, 0);
    const netRevenue = s.revenue - s.refunds;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      revenueMinor: s.revenue,
      refundsMinor: s.refunds,
      netRevenueMinor: netRevenue,
      cogsMinor: s.cogs,
      cogsEstimatedUnits: s.noCostUnits,
      expensesMinor: expenses,
      profitMinor: netRevenue - s.cogs - expenses,
      ordersCount: s.money.count,
      cogsNote: s.noCostUnits > 0
        ? `${s.noCostUnits} unit(s) sold had no cost on record (counted at ₱0), so the profit shown is too high.`
        : "Cost is the cost saved with each sale. These numbers are the stores' numbers added up.",
    };
  }

  /** Sales split by payment method + top customers + utang aging. */
  async salesReport(storeId: string, from: Date, to: Date) {
    const { book } = await this.sold(storeId, from, to);
    const byMethod: Record<string, number> = {};
    for (const [method, list] of this.group(book.entries, (e) => e.paymentMethod)) byMethod[method] = bookTotals(list, book.splits).totalMinor;

    const topCustomers = [...this.group(book.entries, (e) => e.customerName || "Walk-in")]
      .map(([name, list]) => { const t = bookTotals(list, book.splits); return { name, totalMinor: t.totalMinor, orders: t.count }; })
      .filter((c) => c.orders > 0 || c.totalMinor !== 0)
      .sort((a, b) => b.totalMinor - a.totalMinor).slice(0, 10);

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
      paymentSplit: Object.entries(byMethod).filter(([, totalMinor]) => totalMinor !== 0).map(([method, totalMinor]) => ({ method, totalMinor })),
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

  /** Sold stock: quantity sold per product in period (loose rice in kilos). */
  async soldStock(storeId: string, from: Date, to: Date) {
    const { lines } = await this.sold(storeId, from, to);
    const byProduct = new Map<string, { name: string; sku: string; unit: string; sold: number }>();
    for (const l of lines) {
      if (!l.product || !l.line.productId) continue;
      const cur = byProduct.get(l.line.productId) ?? { name: l.product.name, sku: l.product.sku, unit: l.loose ? "kg" : "pcs", sold: 0 };
      cur.sold += l.loose ? l.quantity / 1000 : l.quantity;
      byProduct.set(l.line.productId, cur);
    }
    const rows = [...byProduct.values()].filter((r) => r.sold !== 0).sort((a, b) => b.sold - a.sold);
    return { from: from.toISOString(), to: to.toISOString(), rows, totalUnitsSold: rows.reduce((s, r) => s + r.sold, 0) };
  }

  /** Income & Loss: detailed breakdown — income by source, expense categories, net. */
  async incomeLoss(storeId: string, from: Date, to: Date) {
    const s = await this.sold(storeId, from, to);
    const netRevenue = s.revenue - s.refunds;

    const expensesRows = await prisma.expense.findMany({ where: { storeId, voidedAt: null, spentAt: { gte: from, lte: to } }, select: { category: true, amountMinor: true, note: true } });
    const byCategory: Record<string, number> = {};
    for (const e of expensesRows) byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amountMinor;
    const expenseTotal = expensesRows.reduce((a, e) => a + e.amountMinor, 0);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      income: { revenueMinor: s.revenue, refundsMinor: s.refunds, netRevenueMinor: netRevenue, ordersCount: s.money.count },
      expenses: { totalMinor: expenseTotal, byCategory, lineItems: expensesRows.map((e) => ({ category: e.category, amountMinor: e.amountMinor, note: e.note })) },
      cogsMinor: s.cogs,
      profitMinor: netRevenue - s.cogs - expenseTotal,
    };
  }

  /** Sales by payment method — detailed breakdown. */
  async salesByPayment(storeId: string, from: Date, to: Date) {
    const { book } = await this.sold(storeId, from, to);
    const rows: { method: string; totalMinor: number; orders: number; avgMinor: number }[] = [];
    for (const [method, list] of this.group(book.entries, (e) => e.paymentMethod)) {
      const t = bookTotals(list, book.splits);
      if (t.count === 0 && t.totalMinor === 0) continue;
      rows.push({ method, totalMinor: t.totalMinor, orders: t.count, avgMinor: t.count > 0 ? Math.round(t.totalMinor / t.count) : 0 });
    }
    rows.sort((a, b) => b.totalMinor - a.totalMinor);
    const grandTotal = rows.reduce((s, r) => s + r.totalMinor, 0);
    return { from: from.toISOString(), to: to.toISOString(), rows, grandTotal };
  }

  /** Customer statement: per-customer ledger with orders, payments, credits, balance. */
  async customerStatement(storeId: string, from: Date, to: Date) {
    const { book } = await this.sold(storeId, from, to);
    const byCustomer = new Map<string, { name: string; totalPaid: number; orders: number; firstOrderAt: Date | null; lastOrderAt: Date | null }>();
    for (const [name, list] of this.group(book.entries, (e) => e.customerName || "Walk-in")) {
      const t = bookTotals(list, book.splits);
      if (t.count === 0 && t.totalMinor === 0) continue;
      const at = list.filter((e) => e.sign === 1).map((e) => e.at.getTime());
      byCustomer.set(name, { name, totalPaid: t.totalMinor, orders: t.count, firstOrderAt: at.length ? new Date(Math.min(...at)) : null, lastOrderAt: at.length ? new Date(Math.max(...at)) : null });
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
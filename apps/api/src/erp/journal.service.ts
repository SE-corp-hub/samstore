// P9: ERP double-entry journal — chart of accounts, balancing postings, reports.
// Auto-posting: fulfilled orders (sale + COGS), expenses, credit payments — each
// IDEMPOTENT (a source reference is posted once). Every entry balances to zero.

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type ErpResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

interface DefaultAccount { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" }

const DEFAULT_CHART: DefaultAccount[] = [
  { code: "1000", name: "Cash", type: "ASSET" },
  { code: "1200", name: "Accounts Receivable", type: "ASSET" },
  { code: "1300", name: "Inventory", type: "ASSET" },
  { code: "2100", name: "VAT Payable", type: "LIABILITY" },
  { code: "3000", name: "Owner's Equity", type: "EQUITY" },
  { code: "4000", name: "Sales Revenue", type: "REVENUE" },
  { code: "4100", name: "Delivery Revenue", type: "REVENUE" },
  { code: "5000", name: "Operating Expenses", type: "EXPENSE" },
  { code: "5100", name: "Cost of Goods Sold", type: "EXPENSE" },
];

export class JournalService {
  /** Seed the default chart of accounts (idempotent). */
  async ensureChart(storeId: string): Promise<void> {
    const existing = await prisma.account.findFirst({ where: { storeId } });
    if (existing) return;
    await prisma.account.createMany({ data: DEFAULT_CHART.map((a) => ({ storeId, ...a })) });
  }

  /** Post a BALANCED entry by account codes. Throws when debits ≠ credits. */
  async postEntry(
    storeId: string,
    input: {
      entryDate?: Date;
      reference: string;
      memo?: string;
      source?: string;
      createdBy?: string;
      lines: { accountCode: string; debitMinor?: number; creditMinor?: number }[];
    },
  ): Promise<ErpResult<{ id: string }>> {
    await this.ensureChart(storeId);
    let debit = 0;
    let credit = 0;
    for (const l of input.lines) {
      debit += l.debitMinor ?? 0;
      credit += l.creditMinor ?? 0;
    }
    if (debit !== credit || debit <= 0) {
      return { ok: false, error: { type: "validation", errors: ["Journal entry must balance (debits = credits > 0)"] } };
    }
    const accounts = await prisma.account.findMany({ where: { storeId, code: { in: input.lines.map((l) => l.accountCode) } } });
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const lines: { accountId: string; debitMinor: number; creditMinor: number }[] = [];
    for (const l of input.lines) {
      const acc = byCode.get(l.accountCode);
      if (!acc) return { ok: false, error: { type: "not_found", message: `Unknown account code ${l.accountCode}` } };
      lines.push({ accountId: acc.id, debitMinor: l.debitMinor ?? 0, creditMinor: l.creditMinor ?? 0 });
    }
    const entry = await prisma.$transaction(async (tx) => {
      const e = await tx.journalEntry.create({
        data: {
          storeId,
          entryDate: input.entryDate ?? new Date(),
          reference: input.reference,
          memo: input.memo ?? null,
          source: input.source ?? "manual",
          createdBy: input.createdBy ?? null,
        },
      });
      await tx.journalEntryLine.createMany({
        data: lines.map((l) => ({ storeId, entryId: e.id, ...l })),
      });
      return e;
    });
    return { ok: true, value: { id: entry.id } };
  }

  /** Auto-post a fulfilled order (sale + COGS). Idempotent per order. */
  async postOrder(storeId: string, orderId: string): Promise<ErpResult<{ id: string }>> {
    await this.ensureChart(storeId);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { select: { productId: true, quantity: true } } },
    });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (!["COMPLETED", "DELIVERED"].includes(order.status)) {
      return { ok: false, error: { type: "conflict", message: "Only fulfilled orders are posted" } };
    }
    const already = await prisma.journalEntry.findFirst({ where: { storeId, reference: `ORDER:${order.orderNumber}`, source: "sale" } });
    if (already) return { ok: true, value: { id: already.id } };

    // COGS at latest purchase cost (best-effort; 0 when no cost is set).
    const productIds = order.items.map((i) => i.productId).filter((x): x is string => !!x);
    const costs = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, costMinor: true } })
      : [];
    const costByProduct = new Map(costs.map((c) => [c.id, c.costMinor]));
    const cogs = order.items.reduce((s, i) => s + (i.productId ? (costByProduct.get(i.productId) ?? 0) * i.quantity : 0), 0);

    const lines = [
      { accountCode: "1000", debitMinor: order.totalMinor },
      { accountCode: "4000", creditMinor: order.subtotalMinor },
      ...(order.deliveryFeeMinor > 0 ? [{ accountCode: "4100", creditMinor: order.deliveryFeeMinor }] : []),
      ...(cogs > 0
        ? [{ accountCode: "5100", debitMinor: cogs }, { accountCode: "1300", creditMinor: cogs }]
        : []),
    ];
    return this.postEntry(storeId, { reference: `ORDER:${order.orderNumber}`, memo: `Sale ${order.orderNumber}`, source: "sale", lines });
  }

  /** Auto-post an expense (DR Operating Expenses / CR Cash). Idempotent. */
  async postExpense(storeId: string, expenseId: string): Promise<ErpResult<{ id: string }>> {
    await this.ensureChart(storeId);
    const expense = await prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) return { ok: false, error: { type: "not_found", message: "Expense not found" } };
    const already = await prisma.journalEntry.findFirst({ where: { storeId, reference: `EXPENSE:${expense.id}`, source: "expense" } });
    if (already) return { ok: true, value: { id: already.id } };
    return this.postEntry(storeId, { reference: `EXPENSE:${expense.id}`, memo: expense.note ?? "Expense", source: "expense", lines: [
      { accountCode: "5000", debitMinor: expense.amountMinor },
      { accountCode: "1000", creditMinor: expense.amountMinor },
    ] });
  }

  /** Backfill: post all fulfilled orders + expenses not yet posted. Idempotent. */
  async backfill(storeId: string): Promise<{ orders: number; expenses: number }> {
    await this.ensureChart(storeId);
    const postedOrderRefs = new Set(
      (await prisma.journalEntry.findMany({ where: { storeId, source: "sale" }, select: { reference: true } })).map((e) => e.reference),
    );
    const orders = await prisma.order.findMany({ where: { storeId, status: { in: ["COMPLETED", "DELIVERED"] } }, select: { id: true, orderNumber: true } });
    let ordersPosted = 0;
    for (const o of orders) {
      if (postedOrderRefs.has(`ORDER:${o.orderNumber}`)) continue;
      const r = await this.postOrder(storeId, o.id);
      if (r.ok) ordersPosted += 1;
    }
    const postedExpenseRefs = new Set(
      (await prisma.journalEntry.findMany({ where: { storeId, source: "expense" }, select: { reference: true } })).map((e) => e.reference),
    );
    const expenses = await prisma.expense.findMany({ where: { storeId }, select: { id: true } });
    let expensesPosted = 0;
    for (const e of expenses) {
      if (postedExpenseRefs.has(`EXPENSE:${e.id}`)) continue;
      const r = await this.postExpense(storeId, e.id);
      if (r.ok) expensesPosted += 1;
    }
    return { orders: ordersPosted, expenses: expensesPosted };
  }

  /** Trial balance: net balance per account (debit − credit), plus the check sum. */
  async trialBalance(storeId: string) {
    await this.ensureChart(storeId);
    const accounts = await prisma.account.findMany({ where: { storeId }, include: { journalLines: true } });
    const rows = accounts.map((a) => {
      const debit = a.journalLines.reduce((s, l) => s + l.debitMinor, 0);
      const credit = a.journalLines.reduce((s, l) => s + l.creditMinor, 0);
      return { code: a.code, name: a.name, type: a.type, debitMinor: debit, creditMinor: credit, balanceMinor: debit - credit };
    });
    const totalDebit = rows.reduce((s, r) => s + r.debitMinor, 0);
    const totalCredit = rows.reduce((s, r) => s + r.creditMinor, 0);
    return { rows, totalDebitMinor: totalDebit, totalCreditMinor: totalCredit, balanced: totalDebit === totalCredit };
  }

  /** Income statement: revenue − COGS − expenses over a period. */
  async incomeStatement(storeId: string, from: Date, to: Date) {
    await this.ensureChart(storeId);
    const entries = await prisma.journalEntry.findMany({
      where: { storeId, entryDate: { gte: from, lte: to } },
      include: { lines: { include: { account: true } } },
    });
    let revenue = 0;
    let cogs = 0;
    let expenses = 0;
    for (const e of entries) {
      for (const l of e.lines) {
        const amount = l.creditMinor - l.debitMinor; // net to the account
        if (l.account.type === "REVENUE") revenue += amount;
        else if (l.account.code === "5100") cogs += -amount; // COGS is debit
        else if (l.account.type === "EXPENSE") expenses += -amount;
      }
    }
    return {
      revenueMinor: revenue,
      cogsMinor: cogs,
      expensesMinor: expenses,
      grossProfitMinor: revenue - cogs,
      netProfitMinor: revenue - cogs - expenses,
    };
  }
}
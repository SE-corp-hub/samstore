// Expenses — store operating costs. CRUD with owner/manager roles. Feeds profit reports (P10).

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type ExpenseResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const EXPENSES_SERVICE = Symbol("EXPENSES_SERVICE");

export const EXPENSE_CATEGORIES = ["rent", "utilities", "supplies", "wages", "transport", "other"] as const;

export class ExpensesService {
  async create(storeId: string, actorId: string, input: { category: string; amountMinor: number; note?: string; spentAt?: string }): Promise<ExpenseResult<{ id: string }>> {
    if (!EXPENSE_CATEGORIES.includes(input.category as (typeof EXPENSE_CATEGORIES)[number])) {
      return { ok: false, error: { type: "validation", errors: [`category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`] } };
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      return { ok: false, error: { type: "validation", errors: ["amountMinor must be a positive integer"] } };
    }
    const e = await prisma.expense.create({
      data: {
        storeId,
        category: input.category,
        amountMinor: input.amountMinor,
        note: input.note?.trim() ?? null,
        spentAt: input.spentAt ? new Date(input.spentAt) : new Date(),
        createdBy: actorId,
      },
    });
    return { ok: true, value: { id: e.id } };
  }

  async list(storeId: string, from?: string, to?: string) {
    const where: Record<string, unknown> = { storeId };
    if (from || to) {
      where.spentAt = {};
      if (from) (where.spentAt as Record<string, unknown>).gte = new Date(from);
      if (to) (where.spentAt as Record<string, unknown>).lte = new Date(to);
    }
    const rows = await prisma.expense.findMany({ where, orderBy: { spentAt: "desc" }, take: 200 });
    return rows;
  }

  async remove(storeId: string, id: string): Promise<ExpenseResult<{ id: string }>> {
    const existing = await prisma.expense.findFirst({ where: { storeId, id } });
    if (!existing) return { ok: false, error: { type: "not_found", message: "Expense not found" } };
    await prisma.expense.delete({ where: { id } });
    return { ok: true, value: { id } };
  }

  /** Monthly totals per category (feeds P10 reports). */
  async totals(storeId: string, from: Date, to: Date) {
    const rows = await prisma.expense.findMany({ where: { storeId, spentAt: { gte: from, lte: to } } });
    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + r.amountMinor;
      total += r.amountMinor;
    }
    return { totalMinor: total, byCategory };
  }
}
// Expenses — money the business paid out. Feeds the profit reports.
//
// Per-store build, step 3:
//   - An expense belongs to ONE store, or to the whole business (no store).
//   - A login tied to a store adds expenses for that store only, and sees only that store's.
//   - A wrong expense is CANCELLED with a reason (owner or manager), never deleted, so the list
//     always shows what was written. A cancelled expense counts in no report.
//   - "Paid from the drawer" marks cash taken out of that store's cash drawer (the cash count of
//     step 4 reads it).

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";
import { ALL_LOCATION_ROLES } from "../domain/people.js";

export type ExpenseResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const EXPENSES_SERVICE = Symbol("EXPENSES_SERVICE");

export const EXPENSE_CATEGORIES = ["rent", "utilities", "supplies", "wages", "transport", "other"] as const;

/** The login that is asking. */
export interface ExpenseActor { userId: string; role: string; homeLocationId: string | null }

export interface ExpenseInput {
  category: string; amountMinor: number; note?: string; spentAt?: string;
  /** The store it belongs to. `null` = the whole business (owner only). Left out = the login's own store. */
  locationId?: string | null;
  paidFromDrawer?: boolean;
}

/** An expense that counts: not cancelled. Every report adds this to its filter. */
export const COUNTED = { voidedAt: null } as const;

const seesAll = (a: ExpenseActor) => (ALL_LOCATION_ROLES as readonly string[]).includes(a.role);
const invalid = (msg: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "validation", errors: [msg] } });
const refused = (msg: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "forbidden", message: msg } });

export class ExpensesService {
  async create(storeId: string, actor: ExpenseActor, input: ExpenseInput): Promise<ExpenseResult<{ id: string; locationId: string | null }>> {
    if (!EXPENSE_CATEGORIES.includes(input.category as (typeof EXPENSE_CATEGORIES)[number])) return invalid(`category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`);
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return invalid("amountMinor must be a positive integer");
    const spentAt = input.spentAt ? new Date(input.spentAt) : new Date();
    if (Number.isNaN(spentAt.getTime())) return invalid("The date is not a date");
    if (spentAt.getTime() > Date.now() + 86_400_000) return invalid("The date cannot be in the future");

    // Which store? A login tied to a store: that store, always. The owner: the one chosen, or the whole business.
    let locationId: string | null;
    if (!seesAll(actor) && actor.homeLocationId) {
      if (input.locationId && input.locationId !== actor.homeLocationId) return refused("You can add expenses for your own store only.");
      locationId = actor.homeLocationId;
    } else if (typeof input.locationId === "string" && input.locationId) {
      locationId = input.locationId;
    } else if (input.locationId === null && seesAll(actor)) {
      locationId = null;
    } else {
      // An old copy of the app sends no store: the login's own store, else the whole business
      // (owner) or the main store (staff with no store set).
      locationId = actor.homeLocationId ?? (seesAll(actor) ? null : (await prisma.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } }))?.id ?? null);
    }
    if (locationId) {
      const place = await prisma.warehouse.findFirst({ where: { storeId, id: locationId, isActive: true }, select: { id: true } });
      if (!place) return invalid("Choose a store from the list");
    }

    const e = await prisma.expense.create({
      data: {
        storeId, locationId,
        category: input.category,
        amountMinor: input.amountMinor,
        note: input.note?.trim().slice(0, 200) || null,
        spentAt,
        paidFromDrawer: !!locationId && input.paidFromDrawer === true,
        createdBy: actor.userId,
      },
    });
    return { ok: true, value: { id: e.id, locationId } };
  }

  /**
   * The newest 200 expenses. `locationId`: a store, "business" (the ones with no store), or nothing
   * (all). A login tied to a store always gets its own store's only.
   */
  async list(storeId: string, actor: ExpenseActor, opts: { from?: string; to?: string; locationId?: string } = {}) {
    const day = (v?: string) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
    const from = day(opts.from), to = day(opts.to);
    const own = !seesAll(actor) && actor.homeLocationId ? actor.homeLocationId : null;
    const which = own ?? opts.locationId;
    const rows = await prisma.expense.findMany({
      where: {
        storeId,
        ...(which === "business" ? { locationId: null } : which ? { locationId: which } : {}),
        ...(from || to ? { spentAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { spentAt: "desc" }, take: 200,
      include: { location: { select: { name: true, code: true } } },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.voidedById]).filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
    const expenses = rows.map((r) => ({
      id: r.id, category: r.category, amountMinor: r.amountMinor, note: r.note, spentAt: r.spentAt, createdAt: r.createdAt,
      locationId: r.locationId, locationName: r.location?.name ?? null, paidFromDrawer: r.paidFromDrawer,
      addedBy: r.createdBy ? names.get(r.createdBy) ?? null : null,
      cancelled: !!r.voidedAt, cancelledAt: r.voidedAt, cancelReason: r.voidReason, cancelledBy: r.voidedById ? names.get(r.voidedById) ?? null : null,
    }));
    return {
      expenses,
      /** Money of the expenses shown that still count. */
      totalMinor: expenses.filter((e) => !e.cancelled).reduce((s, e) => s + e.amountMinor, 0),
      /** May this login cancel an expense, and choose the store? */
      canCancel: seesAll(actor), ownLocationId: own,
    };
  }

  /** Cancel a wrong expense. It stays on the list, crossed out, and counts in no report. */
  async cancel(storeId: string, actor: ExpenseActor, id: string, reason?: string): Promise<ExpenseResult<{ id: string }>> {
    if (!seesAll(actor)) return refused("Only the owner can cancel an expense.");
    const why = (reason ?? "").trim().slice(0, 200);
    if (why.length < 3) return invalid("Write why this expense is cancelled");
    const existing = await prisma.expense.findFirst({ where: { storeId, id }, select: { voidedAt: true } });
    if (!existing) return { ok: false, error: { type: "not_found", message: "Expense not found" } };
    if (existing.voidedAt) return { ok: true, value: { id } }; // pressed twice: already cancelled
    await prisma.expense.updateMany({ where: { storeId, id, voidedAt: null }, data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: why } });
    return { ok: true, value: { id } };
  }

  /** Old name, kept for old copies of the app: "delete" now cancels. */
  remove(storeId: string, actor: ExpenseActor, id: string): Promise<ExpenseResult<{ id: string }>> {
    return this.cancel(storeId, actor, id, "Deleted");
  }

  /** Totals per category (cancelled ones left out). For one store when `locationId` is given. */
  async totals(storeId: string, from: Date, to: Date, locationId?: string) {
    const rows = await prisma.expense.findMany({ where: { storeId, ...COUNTED, ...(locationId ? { locationId } : {}), spentAt: { gte: from, lte: to } } });
    const byCategory: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + r.amountMinor;
      total += r.amountMinor;
    }
    return { totalMinor: total, byCategory };
  }
}

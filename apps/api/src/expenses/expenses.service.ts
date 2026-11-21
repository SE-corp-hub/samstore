// Expenses — money the business paid out. Feeds the profit reports.
//
// Per-store build, step 3:
//   - An expense belongs to ONE store, or to the whole business (no store).
//   - A login tied to a store adds expenses for that store only, and sees only that store's.
//   - A wrong expense is CANCELLED with a reason (owner or manager), never deleted, so the list
//     always shows what was written. A cancelled expense counts in no report.
//   - "Paid from the drawer" marks cash taken out of that store's cash drawer (the cash count of
//     step 4 reads it).

//
// System review 2026-11-20, finding 6: a login that is not the owner or a manager
//   - writes TODAY's expenses only (no back-dating into a day that is closed),
//   - says what a drawer expense was for,
//   - may take up to STAFF_DRAWER_DAY_LIMIT_MINOR a day out of one store's drawer. Above that the
//     expense waits for the owner's OK (Approvals) and lowers the expected cash only when approved.

import { mainLocationId } from "../domain/main-store.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import type { ApiError } from "@sam-store/contracts";
import { ALL_LOCATION_ROLES } from "../domain/people.js";
import { dayRange, manilaDate } from "../domain/reports.js";
import { cashTimeFor, closedTodayRefusal } from "../day/day-gate.js";
import { registerApprovalHandler, requestApproval } from "../people/people.service.js";

/** What staff may take out of one store's drawer in a day without the owner's OK: ₱500. */
export const STAFF_DRAWER_DAY_LIMIT_MINOR = 50_000;
/** How old a POS expense that waited on the tablet may be and still be taken from staff. */
export const POS_LATE_DAYS = 3;

const pesos = (minor: number) => `₱${(minor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pure rule: does this staff drawer expense need the owner's OK? `alreadyMinor` = staff drawer expenses there today. */
export function needsOwnerOk(alreadyMinor: number, amountMinor: number, limitMinor = STAFF_DRAWER_DAY_LIMIT_MINOR): boolean {
  return alreadyMinor + amountMinor > limitMinor;
}

// The owner said yes: now the expense is written (dated when the money left the drawer) and counts.
registerApprovalHandler("EXPENSE", async (tx, a) => {
  if (a.status !== "APPROVED") return;
  if (await tx.expense.findFirst({ where: { id: a.documentId }, select: { id: true } })) return;
  const d = ((await tx.approvalRequest.findUnique({ where: { id: a.id }, select: { detail: true } }))?.detail ?? {}) as Record<string, unknown>;
  if (typeof d.amountMinor !== "number" || typeof d.category !== "string" || typeof d.locationId !== "string") return;
  await tx.expense.create({
    data: {
      id: a.documentId, storeId: a.storeId, locationId: d.locationId, category: d.category, amountMinor: d.amountMinor,
      note: typeof d.note === "string" ? d.note : null, spentAt: typeof d.spentAt === "string" ? new Date(d.spentAt) : new Date(),
      paidFromDrawer: true, createdBy: typeof d.createdBy === "string" ? d.createdBy : null,
    },
  });
});

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
  /** Written with the Expense button on POS (may have waited on the tablet with no signal). */
  fromPos?: boolean;
}

/** An expense that counts: not cancelled. Every report adds this to its filter. */
export const COUNTED = { voidedAt: null } as const;

const seesAll = (a: ExpenseActor) => (ALL_LOCATION_ROLES as readonly string[]).includes(a.role);
const invalid = (msg: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "validation", errors: [msg] } });
const refused = (msg: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "forbidden", message: msg } });

export class ExpensesService {
  async create(storeId: string, actor: ExpenseActor, input: ExpenseInput): Promise<ExpenseResult<{ id: string; locationId: string | null; /** Not written yet: it becomes expense `id` when the owner approves. */ waitingForOwner?: boolean; approvalId?: string }>> {
    if (!EXPENSE_CATEGORIES.includes(input.category as (typeof EXPENSE_CATEGORIES)[number])) return invalid(`category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`);
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return invalid("amountMinor must be a positive integer");
    let spentAt = input.spentAt ? new Date(input.spentAt) : new Date();
    if (Number.isNaN(spentAt.getTime())) return invalid("The date is not a date");
    if (spentAt.getTime() > Date.now() + 86_400_000) return invalid("The date cannot be in the future");
    const staff = !seesAll(actor);
    // "Expense" on POS: a step that waited on the tablet with no signal arrives late with its own
    // time. It is never refused (the money already left the drawer); it counts on its own day, or
    // now when that day is already closed at the store, so a closed day never changes.
    const late = input.fromPos === true && manilaDate(spentAt) !== manilaDate(new Date()) && Date.now() - spentAt.getTime() <= POS_LATE_DAYS * 86_400_000 && spentAt.getTime() < Date.now();
    if (staff && !late && manilaDate(spentAt) !== manilaDate(new Date())) return invalid("You can add today's expenses only. Ask the owner to add an older one.");

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
      locationId = actor.homeLocationId ?? (seesAll(actor) ? null : (await mainLocationId(prisma, storeId)) ?? null);
    }
    if (locationId) {
      const place = await prisma.warehouse.findFirst({ where: { storeId, id: locationId, isActive: true }, select: { id: true } });
      if (!place) return invalid("Choose a store from the list");
    }

    if (late && locationId) spentAt = await cashTimeFor(prisma, storeId, locationId, spentAt);
    const fromDrawer = !!locationId && input.paidFromDrawer === true;
    // Money taken from the drawer today, after the store's Z-read, would be in no Z-read.
    if (fromDrawer && locationId && !late && manilaDate(spentAt) === manilaDate(new Date())) {
      const closed = await closedTodayRefusal(prisma, storeId, locationId);
      if (closed) return { ok: false, error: { type: "conflict", message: closed } };
    }
    const note = input.note?.trim().slice(0, 200) || null;
    if (staff && fromDrawer && locationId) {
      if (!note || note.length < 3) return invalid("Write what the money from the drawer was for.");
      // What staff already took out of this drawer today (the owner's own expenses do not use up the limit).
      const bosses = (await prisma.userStore.findMany({ where: { storeId, role: { in: ["OWNER", "MANAGER"] } }, select: { userId: true } })).map((u) => u.userId);
      const { from, to } = dayRange(manilaDate(new Date()));
      const already = (await prisma.expense.aggregate({ where: { storeId, locationId, paidFromDrawer: true, ...COUNTED, spentAt: { gte: from, lt: to }, OR: [{ createdBy: null }, { createdBy: { notIn: bosses } }] }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
      if (needsOwnerOk(already, input.amountMinor)) {
        const place = await prisma.warehouse.findFirst({ where: { storeId, id: locationId }, select: { name: true } });
        const id = randomId();
        const approval = await prisma.$transaction((tx) => requestApproval(tx, {
          storeId, kind: "EXPENSE", documentType: "EXPENSE", documentId: id, locationId, requestedById: actor.userId,
          summary: `Expense from the drawer: ${pesos(input.amountMinor)} for ${input.category} at ${place?.name ?? "the store"} (${note}). Staff already took ${pesos(already)} today; the limit without your OK is ${pesos(STAFF_DRAWER_DAY_LIMIT_MINOR)} a day.`,
          detail: { category: input.category, amountMinor: input.amountMinor, note, spentAt: spentAt.toISOString(), locationId, createdBy: actor.userId },
        }));
        return { ok: true, value: { id, locationId, waitingForOwner: true, approvalId: approval.id } };
      }
    }

    const e = await prisma.expense.create({
      data: {
        storeId, locationId,
        category: input.category,
        amountMinor: input.amountMinor,
        note,
        spentAt,
        paidFromDrawer: fromDrawer,
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

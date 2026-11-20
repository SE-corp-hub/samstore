// Cash handed over — a store gives cash from its drawer to the owner during the day.
// Per-store build, step 4. A hand-over lowers that store's expected cash for the day (cash-book.ts).
// A wrong one is cancelled by the owner with a reason, never deleted.

import type { ApiError } from "@sam-store/contracts";
import { prisma } from "../persistence/prisma-repositories.js";
import { ALL_LOCATION_ROLES } from "../domain/people.js";
import { dayRange, manilaDate } from "../domain/reports.js";
import { locationRefusal, type Actor } from "../people/people.service.js";
import { cashTimeFor } from "../day/day-gate.js";
import { cashOfDay } from "./cash-book.js";

type R<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const invalid = (m: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "validation", errors: [m] } });
const refused = (m: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "forbidden", message: m } });
const isOwner = (a: Actor) => (ALL_LOCATION_ROLES as readonly string[]).includes(a.role);
const MAX_MINOR = 1_000_000_000;
/** How old a step that waited on the tablet may be and still keep its own time. */
export const OFFLINE_DAYS = 3;

export class CashService {
  /** Write down cash handed over to the owner. Staff: their own store, today. The owner: any store, today or an earlier day. */
  async handOver(storeId: string, actor: Actor, input: { locationId?: string; amountMinor?: unknown; note?: string; date?: string }): Promise<R<{ id: string; locationId: string; date: string; amountMinor: number; expectedMinor: number }>> {
    const locationId = input.locationId || actor.homeLocationId;
    if (!locationId) return invalid("Choose the store");
    const refusal = locationRefusal(actor, locationId);
    if (refusal) return refused(refusal);
    const loc = await prisma.warehouse.findFirst({ where: { storeId, id: locationId, isActive: true }, select: { id: true, name: true } });
    if (!loc) return invalid("Choose a store from the list");
    const amount = input.amountMinor;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_MINOR) return invalid("Type the cash that was handed over");
    const today = manilaDate(new Date());
    let date = today;
    if (input.date && input.date !== today) {
      if (!isOwner(actor)) return refused("Only the owner can write a hand-over for another day.");
      try { dayRange(input.date); } catch { return invalid("The date is not a date"); }
      if (input.date > today) return invalid("The date cannot be in the future");
      date = input.date;
    }
    const row = await prisma.$transaction(async (tx) => {
      const h = await tx.cashHandover.create({
        data: { storeId, locationId: loc.id, businessDate: date, amountMinor: amount, note: input.note?.trim().slice(0, 200) || null, handedById: actor.userId, receivedById: isOwner(actor) ? actor.userId : null },
        select: { id: true },
      });
      await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "cash.handover", entityType: "CashHandover", entityId: h.id, after: { locationId: loc.id, date, amountMinor: amount } } });
      return h;
    });
    const cash = await cashOfDay(prisma, storeId, loc.id, date);
    return { ok: true, value: { id: row.id, locationId: loc.id, date, amountMinor: amount, expectedMinor: cash.expectedMinor } };
  }

  /**
   * Cash in: money put into a store's drawer that is not a sale (more change, the owner adds money).
   * It raises that store's expected cash. Any login, at its own store, saying what the money is.
   * `at`: when it was tapped on the tablet (a step that waited offline keeps its own time, unless
   * that day is already closed at the store: then it counts now, so a closed Z-read never moves).
   */
  async cashIn(storeId: string, actor: Actor, input: { locationId?: string; amountMinor?: unknown; note?: string; at?: string }): Promise<R<{ id: string; locationId: string; amountMinor: number; expectedMinor: number }>> {
    const locationId = input.locationId || actor.homeLocationId;
    if (!locationId) return invalid("Choose the store");
    const refusal = locationRefusal(actor, locationId);
    if (refusal) return refused(refusal);
    const loc = await prisma.warehouse.findFirst({ where: { storeId, id: locationId, isActive: true }, select: { id: true, name: true } });
    if (!loc) return invalid("Choose a store from the list");
    const amount = input.amountMinor;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > MAX_MINOR) return invalid("Type the cash that was put in the drawer");
    const note = input.note?.trim().slice(0, 200) || null;
    if (!note || note.length < 3) return invalid("Say what the money is for (for example: more change).");
    const now = new Date();
    let at = input.at ? new Date(input.at) : now;
    if (Number.isNaN(at.getTime())) return invalid("The time is not a time");
    // Only a step that really waited on the tablet is older than now, and never by more than a few days.
    if (at.getTime() > now.getTime() || now.getTime() - at.getTime() > OFFLINE_DAYS * 86_400_000) at = now;
    const receivedAt = await cashTimeFor(prisma, storeId, loc.id, at, now);
    const row = await prisma.$transaction(async (tx) => {
      const c = await tx.cashIn.create({ data: { storeId, locationId: loc.id, amountMinor: amount, note, receivedAt, createdBy: actor.userId }, select: { id: true } });
      await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "cash.in", entityType: "CashIn", entityId: c.id, after: { locationId: loc.id, amountMinor: amount, note, receivedAt: receivedAt.toISOString() } } });
      return c;
    });
    const cash = await cashOfDay(prisma, storeId, loc.id, manilaDate(receivedAt));
    return { ok: true, value: { id: row.id, locationId: loc.id, amountMinor: amount, expectedMinor: cash.expectedMinor } };
  }

  /** Cancel a wrong cash in (owner). It stays on the list, crossed out, and no longer raises the expected cash. */
  async cancelCashIn(storeId: string, actor: Actor, id: string, reason?: string): Promise<R<{ id: string }>> {
    if (!isOwner(actor)) return refused("Only the owner can cancel a cash in.");
    const why = (reason ?? "").trim().slice(0, 200);
    if (why.length < 3) return invalid("Write why this cash in is cancelled");
    const row = await prisma.cashIn.findFirst({ where: { storeId, id }, select: { voidedAt: true, amountMinor: true, locationId: true } });
    if (!row) return { ok: false, error: { type: "not_found", message: "Cash in not found" } };
    if (row.voidedAt) return { ok: true, value: { id } };
    await prisma.$transaction(async (tx) => {
      const done = await tx.cashIn.updateMany({ where: { storeId, id, voidedAt: null }, data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: why } });
      if (done.count) await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "cash.in_cancel", entityType: "CashIn", entityId: id, after: { reason: why, amountMinor: row.amountMinor, locationId: row.locationId } } });
    });
    return { ok: true, value: { id } };
  }

  /** A store's cash for one day, with its hand-overs. A login tied to a store reads its own store only. */
  async day(storeId: string, actor: Actor, input: { locationId?: string; date?: string }): Promise<R<{
    date: string; location: { id: string; name: string }; canCancel: boolean;
    cash: { inMinor: number; creditPaidMinor: number; addedMinor: number; givenBackMinor: number; paidOutMinor: number; handedOverMinor: number; expectedMinor: number };
    handovers: { id: string; amountMinor: number; note: string | null; at: Date; handedBy: string | null; received: boolean; receivedBy: string | null; cancelled: boolean; cancelReason: string | null }[];
    cashIns: { id: string; amountMinor: number; note: string | null; at: Date; by: string | null; cancelled: boolean; cancelReason: string | null }[];
  }>> {
    const locationId = (isOwner(actor) ? input.locationId : null) || actor.homeLocationId || input.locationId;
    if (!locationId) return invalid("Choose the store");
    const refusal = locationRefusal(actor, locationId);
    if (refusal) return refused(refusal);
    const loc = await prisma.warehouse.findFirst({ where: { storeId, id: locationId }, select: { id: true, name: true } });
    if (!loc) return invalid("Choose a store from the list");
    const date = input.date || manilaDate(new Date());
    try { dayRange(date); } catch { return invalid("The date is not a date"); }
    const { from, to } = dayRange(date);
    const [{ inByOrder: _skip, heldForOthers: _a, heldByOthers: _b, ...cash }, rows, ins] = await Promise.all([
      cashOfDay(prisma, storeId, loc.id, date),
      prisma.cashHandover.findMany({ where: { storeId, locationId: loc.id, businessDate: date }, orderBy: { createdAt: "desc" } }),
      prisma.cashIn.findMany({ where: { storeId, locationId: loc.id, receivedAt: { gte: from, lt: to } }, orderBy: { receivedAt: "desc" } }),
    ]);
    const ids = [...new Set([...rows.flatMap((r) => [r.handedById, r.receivedById]), ...ins.map((c) => c.createdBy)].filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
    return {
      ok: true,
      value: {
        date, location: loc, canCancel: isOwner(actor), cash,
        handovers: rows.map((r) => ({
          id: r.id, amountMinor: r.amountMinor, note: r.note, at: r.createdAt, handedBy: names.get(r.handedById) ?? null,
          received: !!r.receivedById, receivedBy: r.receivedById ? names.get(r.receivedById) ?? null : null,
          cancelled: !!r.voidedAt, cancelReason: r.voidReason,
        })),
        cashIns: ins.map((c) => ({ id: c.id, amountMinor: c.amountMinor, note: c.note, at: c.receivedAt, by: names.get(c.createdBy) ?? null, cancelled: !!c.voidedAt, cancelReason: c.voidReason })),
      },
    };
  }

  /** The owner says "I received it". */
  async receive(storeId: string, actor: Actor, id: string): Promise<R<{ id: string }>> {
    if (!isOwner(actor)) return refused("Only the owner can mark cash as received.");
    const row = await prisma.cashHandover.findFirst({ where: { storeId, id }, select: { voidedAt: true } });
    if (!row) return { ok: false, error: { type: "not_found", message: "Hand-over not found" } };
    if (row.voidedAt) return { ok: false, error: { type: "conflict", message: "This hand-over was cancelled" } };
    await prisma.cashHandover.updateMany({ where: { storeId, id, receivedById: null }, data: { receivedById: actor.userId } });
    return { ok: true, value: { id } };
  }

  /** Cancel a wrong hand-over (owner). It stays on the list, crossed out, and no longer lowers the expected cash. */
  async cancel(storeId: string, actor: Actor, id: string, reason?: string): Promise<R<{ id: string }>> {
    if (!isOwner(actor)) return refused("Only the owner can cancel a hand-over.");
    const why = (reason ?? "").trim().slice(0, 200);
    if (why.length < 3) return invalid("Write why this hand-over is cancelled");
    const row = await prisma.cashHandover.findFirst({ where: { storeId, id }, select: { voidedAt: true, amountMinor: true, locationId: true, businessDate: true } });
    if (!row) return { ok: false, error: { type: "not_found", message: "Hand-over not found" } };
    if (row.voidedAt) return { ok: true, value: { id } };
    await prisma.$transaction(async (tx) => {
      const done = await tx.cashHandover.updateMany({ where: { storeId, id, voidedAt: null }, data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: why } });
      if (done.count) await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "cash.handover_cancel", entityType: "CashHandover", entityId: id, after: { reason: why, amountMinor: row.amountMinor, locationId: row.locationId, date: row.businessDate } } });
    });
    return { ok: true, value: { id } };
  }
}

// Open day + Close day (Z-read): the one gate every selling step asks.
//
// When Settings → This store → "Open and close the day on POS" is on for a store
// (Warehouse.dayOpenClose, empty = the business's StoreSettings.dayOpenClose), that store sells only while ITS day is open:
//   - no open day          → refused: "Tap Open day on POS"
//   - the open day is old   → refused: close yesterday first (its Z-read must hold only its own day)
//   - closed for today      → refused: only the owner can reopen it
// A sale made OFFLINE (it waited on the tablet) is never refused: the money was really taken.
// Its cash is dated at the sale time, unless that day is already closed at the store, then at
// the upload time, so a closed Z-read never changes after the count (see cashTimeFor).
//
// Switch off: nothing here refuses anything, and every caller keeps its old behaviour.

import type { Prisma, PrismaClient } from "@prisma/client";
import { manilaDate } from "../domain/reports.js";
import { switchesAt, switchesOfAll } from "./store-switches.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Is Open day + Close day on? Each store has its own switch ("This store" in Settings); a store
 * with no own value follows the business. No location: on when it is on at ANY store.
 */
export async function dayModeOn(db: Db, storeId: string, locationId?: string | null): Promise<boolean> {
  if (locationId) return (await switchesAt(db, storeId, locationId)).dayOpenClose;
  for (const s of (await switchesOfAll(db, storeId)).values()) if (s.dayOpenClose) return true;
  return (await switchesAt(db, storeId)).dayOpenClose;
}

/** The open day of one store (any date), or null. */
export async function openDayAt(db: Db, storeId: string, locationId: string) {
  return db.registerSession.findFirst({
    where: { storeId, locationId, status: "OPEN" },
    select: { id: true, businessDate: true, openedAt: true, openingFloatMinor: true, openedBy: true, registerId: true },
  });
}

/** The day's Z-read that still stands (closed and not reopened), or null. */
export async function closedDay(db: Db, storeId: string, locationId: string, date: string) {
  return db.registerSession.findFirst({
    where: { storeId, locationId, businessDate: date, status: "CLOSED", reopenedAt: null, zNumber: { not: null } },
    select: { id: true, zNumber: true, closedAt: true },
    orderBy: { closedAt: "desc" },
  });
}

export interface DayGate {
  /** Is the switch on? */
  on: boolean;
  /** The open day's drawer shift to attach cash to (null: none). */
  sessionId: string | null;
  /** Why this step may not happen now (null: it may). */
  refusal: string | null;
}

/**
 * May a sale (or money in or out of the drawer) happen at this store now?
 * `offline`: the step was made on the tablet earlier and is only arriving now.
 */
export async function dayGate(db: Db, storeId: string, locationId: string, opts: { offline?: boolean; now?: Date; storeName?: string } = {}): Promise<DayGate> {
  if (!(await dayModeOn(db, storeId, locationId))) return { on: false, sessionId: null, refusal: null };
  const now = opts.now ?? new Date();
  const today = manilaDate(now);
  const open = await openDayAt(db, storeId, locationId);
  if (opts.offline) return { on: true, sessionId: open?.id ?? null, refusal: null };
  const name = opts.storeName ?? (await db.warehouse.findFirst({ where: { id: locationId, storeId }, select: { name: true } }))?.name ?? "This store";
  if (open && open.businessDate === today) return { on: true, sessionId: open.id, refusal: null };
  if (open) return { on: true, sessionId: null, refusal: `${name}: the day of ${open.businessDate} is still open. Close it first with Close day on POS, then open today.` };
  if (await closedDay(db, storeId, locationId, today)) return { on: true, sessionId: null, refusal: `${name} is closed for today. Only the owner can reopen the day.` };
  return { on: true, sessionId: null, refusal: `${name}: the day is not open yet. Tap Open day on POS first.` };
}

/**
 * When the cash of a sale made at `at` counts in the drawer. A sale that waited offline keeps
 * its own time, so its cash lands on the day it was really taken; but if that day is already
 * closed at this store, the cash counts now (after the close), so a closed Z-read never moves.
 */
export async function cashTimeFor(db: Db, storeId: string, locationId: string | null, at: Date, now: Date = new Date()): Promise<Date> {
  if (at.getTime() >= now.getTime() || !locationId) return now;
  const date = manilaDate(at);
  const closed = await db.dailyClose.findFirst({ where: { storeId, locationId, businessDate: date }, select: { closedAt: true } });
  if (closed) return now;
  return at;
}

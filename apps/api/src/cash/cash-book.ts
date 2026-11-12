// The cash book — the ONE way the app works out "how much cash should be in this store's drawer".
// The daily report and the Close the store flow both ask here, so they cannot disagree.
//
// Per-store build, step 4. For one store and one day (Manila):
//
//     cash in          cash paid at this store: sales, deliveries paid in cash, credit paid in cash
//   − given back       cash refunds, and the cash of a sale that was voided, on the day it was given back
//   − paid out         expenses paid with cash from this store's drawer (cancelled ones left out)
//   − handed over      cash this store handed over to the owner (cancelled ones left out)
//   = expected         what the count of the drawer should show
//
// Money moves on the day it moved: a sale paid on Monday and refunded on Wednesday is cash in on
// Monday and cash given back on Wednesday, so a day that has passed never changes.

import type { Prisma, PrismaClient } from "@prisma/client";
import { dayRange } from "../domain/reports.js";
import { mainLocationId, paymentsOfStore } from "../reports/sales-book.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface CashOfDay {
  /** Cash that came in at this store. */
  inMinor: number;
  /** Of the cash in: credit (utang) paid in cash here. */
  creditPaidMinor: number;
  /** Cash given back to customers (refunds and voided cash sales). */
  givenBackMinor: number;
  /** Expenses paid from this store's drawer. */
  paidOutMinor: number;
  /** Cash handed over to the owner. */
  handedOverMinor: number;
  /** What should be in the drawer: in − given back − paid out − handed over. */
  expectedMinor: number;
  /** Credit paid here for a sale of another store (the cash is in THIS drawer). */
  heldForOthers: { locationId: string; amountMinor: number }[];
  /** Credit paid at another store for a sale of this store (the cash is in THAT drawer). */
  heldByOthers: { locationId: string; amountMinor: number }[];
  /** Cash in, by order (no order = a credit payment). The closing flow splits walk-ins out with this. */
  inByOrder: Map<string | null, number>;
}

/**
 * The cash of one store on one day. `upTo` stops the reading at a moment (the closing flow freezes
 * the day at the close); `after` reads only what came later (the "after the close" line).
 */
export async function cashOfDay(db: Db, storeId: string, locationId: string, date: string, opts: { mainId?: string | null; upTo?: Date; after?: Date } = {}): Promise<CashOfDay> {
  const mainId = opts.mainId !== undefined ? opts.mainId : await mainLocationId(db, storeId);
  const { from, to } = dayRange(date);
  const when = { ...(opts.after ? { gt: opts.after } : { gte: from }), lt: opts.upTo && opts.upTo < to ? opts.upTo : to };
  const here = paymentsOfStore(locationId, mainId);

  const [paid, back, voids, expenses, handovers, forOthers, byOthers] = await Promise.all([
    db.payment.findMany({ where: { storeId, type: "payment", method: "cash", receivedAt: when, ...here }, select: { amountMinor: true, orderId: true } }),
    db.payment.findMany({ where: { storeId, type: "refund", method: "cash", receivedAt: when, ...here }, select: { amountMinor: true } }),
    // A void writes a ₱0 row; the cash given back is what that sale took in cash.
    db.payment.findMany({ where: { storeId, type: "void", receivedAt: when, orderId: { not: null }, ...here }, select: { orderId: true } }),
    db.expense.aggregate({ where: { storeId, locationId, paidFromDrawer: true, voidedAt: null, spentAt: when }, _sum: { amountMinor: true } }),
    db.cashHandover.aggregate({ where: { storeId, locationId, businessDate: date, voidedAt: null, ...(opts.upTo || opts.after ? { createdAt: { ...(opts.after ? { gt: opts.after } : {}), ...(opts.upTo ? { lt: opts.upTo } : {}) } } : {}) }, _sum: { amountMinor: true } }),
    db.payment.groupBy({ by: ["forLocationId"], where: { storeId, type: "payment", method: "cash", receivedAt: when, locationId, forLocationId: { not: null } }, _sum: { amountMinor: true } }),
    db.payment.groupBy({ by: ["locationId"], where: { storeId, type: "payment", method: "cash", receivedAt: when, forLocationId: locationId }, _sum: { amountMinor: true } }),
  ]);
  const voidedIds = [...new Set(voids.map((v) => v.orderId!))];
  const voidedCash = voidedIds.length
    ? (await db.payment.aggregate({ where: { storeId, type: "payment", method: "cash", orderId: { in: voidedIds } }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0
    : 0;

  const inByOrder = new Map<string | null, number>();
  for (const p of paid) inByOrder.set(p.orderId, (inByOrder.get(p.orderId) ?? 0) + p.amountMinor);
  const inMinor = paid.reduce((s, p) => s + p.amountMinor, 0);
  // Refund rows were written with either sign over the years; the cash always left the drawer.
  const givenBackMinor = back.reduce((s, p) => s + Math.abs(p.amountMinor), 0) + voidedCash;
  const paidOutMinor = expenses._sum.amountMinor ?? 0;
  const handedOverMinor = handovers._sum.amountMinor ?? 0;
  const held = (rows: { id: string | null; sum: number | null }[]) => rows.filter((r) => r.id && r.id !== locationId && (r.sum ?? 0) !== 0).map((r) => ({ locationId: r.id!, amountMinor: r.sum ?? 0 }));
  return {
    inMinor, creditPaidMinor: inByOrder.get(null) ?? 0, givenBackMinor, paidOutMinor, handedOverMinor,
    expectedMinor: inMinor - givenBackMinor - paidOutMinor - handedOverMinor,
    heldForOthers: held(forOthers.map((r) => ({ id: r.forLocationId, sum: r._sum.amountMinor }))),
    heldByOthers: held(byOthers.map((r) => ({ id: r.locationId, sum: r._sum.amountMinor }))),
    inByOrder,
  };
}

/**
 * Which store a credit payment is for: the store of the customer's oldest credit sale that is not
 * paid off yet (payments settle the oldest credit first). `null` when it cannot be told.
 */
export async function storeOwedFirst(db: Db, storeId: string, storeCustomerId: string, mainId: string | null): Promise<string | null> {
  const entries = await db.creditEntry.findMany({
    where: { storeId, storeCustomerId }, orderBy: { createdAt: "asc" },
    select: { type: true, amountMinor: true, order: { select: { sellingLocationId: true } } },
  });
  // Everything that lowered the credit (payments, returns, corrections) pays off the oldest sales first.
  let lowered = entries.filter((e) => e.amountMinor < 0).reduce((s, e) => s - e.amountMinor, 0);
  for (const e of entries) {
    if (e.type !== "purchase" || e.amountMinor <= 0) continue;
    if (lowered >= e.amountMinor) { lowered -= e.amountMinor; continue; }
    return e.order?.sellingLocationId ?? mainId;
  }
  return null;
}

// What each customer buys here, for the SE Corp Hub's customer cards (Sales CRM step 2, owner's "recommended" and
// "next", 27 Nov 2026). The hub already counts the orders it sent here, so those (source "hub") are left out: this is
// what the customer bought at the counter, through the store link, or from an agent here.
//
// The hub asks with where its copy stands (`buysAfter`: a time, then a customer id). The answer is one short line per
// customer whose orders changed after that point, oldest change first. The line is split by location (S1, S2 …),
// since each location sells for its own business in the hub (Samrice, Samrice Lipa, Samrice Bauan): how many times
// they bought there, first and last, what they paid, their purchases of the last 180 days and their top items. Only
// customers who bought are sent, so the hub writes one row per buying customer, not one per sale.

import type { PrismaClient } from "@prisma/client";

/** One purchase: when, how much, and whether it is done (paid and handed over). */
export interface HubBuy {
  at: string;
  totalMinor: number;
  done: boolean;
}
/** One of a customer's most bought items: pieces, or grams for rice sold by the kilo. */
export interface HubBuyItem {
  name: string;
  kilo: boolean;
  total: number;
  orders: number;
}
/** A customer's buying at one location. */
export interface HubBuyPlace {
  /** The location's code (S1, S2 …); "" for an order with no location. */
  location: string;
  orders: number;
  /** Done: completed at the counter or delivered. */
  paidOrders: number;
  firstAt: string;
  lastAt: string;
  /** What the done orders came to, in centavos. */
  spentMinor: number;
  /**
   * The purchases of the RECENT_DAYS before the line was made (at most RECENT_MAX), oldest first: enough for the hub's
   * this-month, 3-month and 6-month numbers until the next change sends a new line.
   */
  recent: HubBuy[];
  items: HubBuyItem[];
}
/** A customer's buying here, as the hub keeps it. No places: nothing bought (every order was cancelled). */
export interface HubBuys {
  /** This store's id for the customer (StoreCustomer.id), the same id the customer copy sends. */
  id: string;
  /** When their orders last changed here: the hub's point to ask after next time. */
  changedAt: string;
  places: HubBuyPlace[];
}
/** The customers whose orders changed after a point (time, then id), oldest change first, at most `limit`. */
export type ChangedBuys = (storeId: string, after: { at: string; id: string }, limit: number) => Promise<HubBuys[]>;

export const RECENT_DAYS = 180;
export const RECENT_MAX = 300;
const DONE = new Set(["COMPLETED", "DELIVERED"]);
// Cancelled and failed orders were never bought; a held counter sale is not bought yet (it joins once completed).
const LEFT_OUT = ["CANCELLED", "FAILED_DELIVERY", "ON_HOLD"] as const;

export interface BuyOrder {
  status: string;
  totalMinor: number;
  createdAt: Date;
  occurredAt: Date | null;
  location: string | null;
  items: { productName: string; quantity: number; soldBy: string | null; grams: number | null }[];
}

/** One location's part of the line, from its orders (cancelled, failed and held ones already left out), oldest first. */
function place(location: string, sorted: BuyOrder[], now: Date): HubBuyPlace | null {
  const when = (o: BuyOrder) => o.occurredAt ?? o.createdAt;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  const items = new Map<string, HubBuyItem>();
  for (const o of sorted)
    for (const i of o.items) {
      const kilo = i.soldBy === "KILO" || i.soldBy === "PESO";
      const key = `${i.productName}|${kilo}`;
      const had = items.get(key) ?? { name: i.productName, kilo, total: 0, orders: 0 };
      had.total += kilo ? (i.grams ?? i.quantity) : i.quantity;
      had.orders += 1;
      items.set(key, had);
    }
  const done = sorted.filter((o) => DONE.has(o.status));
  const from = now.getTime() - RECENT_DAYS * 86_400_000;
  return {
    location,
    orders: sorted.length,
    paidOrders: done.length,
    firstAt: when(first).toISOString(),
    lastAt: when(last).toISOString(),
    spentMinor: done.reduce((s, o) => s + o.totalMinor, 0),
    recent: sorted
      .filter((o) => when(o).getTime() >= from)
      .slice(-RECENT_MAX)
      .map((o) => ({ at: when(o).toISOString(), totalMinor: o.totalMinor, done: DONE.has(o.status) })),
    items: [...items.values()].sort((a, b) => b.orders - a.orders || b.total - a.total).slice(0, 3),
  };
}

/** One customer's line from their orders here, one part per location (by code). No orders: no places. */
export function summariseBuys(id: string, changedAt: Date, orders: BuyOrder[], now = new Date()): HubBuys {
  const when = (o: BuyOrder) => (o.occurredAt ?? o.createdAt).getTime();
  const byPlace = new Map<string, BuyOrder[]>();
  for (const o of [...orders].sort((a, b) => when(a) - when(b))) {
    const code = o.location ?? "";
    byPlace.set(code, [...(byPlace.get(code) ?? []), o]);
  }
  const places = [...byPlace.keys()]
    .sort()
    .map((code) => place(code, byPlace.get(code) ?? [], now))
    .filter((p): p is HubBuyPlace => !!p);
  return { id, changedAt: changedAt.toISOString(), places };
}

/** Reads the store's books for the hub: the customers whose own orders (not the hub's) changed after the point. */
export function hubBuys(prisma: PrismaClient, now = () => new Date()): ChangedBuys {
  return async (storeId, after, limit) => {
    // The columns hold UTC without a zone, so the point is passed the same way (as the customer copy does).
    const since = (after.at && !Number.isNaN(Date.parse(after.at)) ? new Date(after.at) : new Date(0)).toISOString().replace("Z", "");
    const changed = await prisma.$queryRaw<{ id: string; changedAt: Date }[]>`
      SELECT o."storeCustomerId" AS "id", MAX(o."updatedAt") AS "changedAt"
        FROM "Order" o
       WHERE o."storeId" = ${storeId} AND o."storeCustomerId" IS NOT NULL AND o."source" <> 'hub'
         AND o."updatedAt" >= CAST(${since} AS timestamp(3))
       GROUP BY o."storeCustomerId"
      HAVING (MAX(o."updatedAt"), o."storeCustomerId") > (CAST(${since} AS timestamp(3)), ${after.id})
       ORDER BY 2, 1
       LIMIT ${limit}`;
    if (!changed.length) return [];
    const orders = await prisma.order.findMany({
      where: { storeId, storeCustomerId: { in: changed.map((c) => c.id) }, source: { not: "hub" }, status: { notIn: [...LEFT_OUT] } },
      select: {
        storeCustomerId: true,
        status: true,
        totalMinor: true,
        createdAt: true,
        occurredAt: true,
        sellingLocation: { select: { code: true } },
        items: { select: { productName: true, quantity: true, soldBy: true, grams: true } },
      },
    });
    const byCustomer = new Map<string, BuyOrder[]>();
    for (const o of orders) {
      const list = byCustomer.get(o.storeCustomerId ?? "") ?? [];
      list.push({ status: o.status, totalMinor: o.totalMinor, createdAt: o.createdAt, occurredAt: o.occurredAt, location: o.sellingLocation?.code ?? null, items: o.items });
      byCustomer.set(o.storeCustomerId ?? "", list);
    }
    // A customer whose every order was cancelled still gets a line (no places), so the hub's point moves on.
    const at = now();
    return changed.map((c) => summariseBuys(c.id, c.changedAt, byCustomer.get(c.id) ?? [], at));
  };
}

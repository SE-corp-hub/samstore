// The sales book — the ONE way every report reads "what was sold". The daily report, the month
// report, the stock book, the Store report, Compare stores and the old Reports screen all ask
// here, so no two of them can disagree about a sale.
//
// The rules (per-store build, step 1c):
//   1. A sale is an order that was handed over: COMPLETED or DELIVERED.
//   2. It is counted at the moment it was sold (`occurredAt`; old orders: `createdAt`).
//   3. It is the sale of the store named on it. An order with no store is the main store's.
//   4. A sale that is taken back later (voided or refunded) STAYS on the day it was sold and is
//      taken off on the day it was taken back, so a day that has passed never changes. A sale
//      sold and taken back inside the same dates adds up to nothing.
//   5. Its cost is the cost saved on each line when it was sold (loose rice: per kilo). Old lines
//      with no saved cost use the product's cost today.
//   6. An agent order delivered in part counts for what was delivered, the same as what was paid.

import type { Prisma, PrismaClient } from "@prisma/client";
import { SOLD_STATES } from "../domain/order-state.js";
import { lineCost, lineGrams } from "../domain/reports.js";
import { isLooseP } from "../domain/counting.js";
import { refundValue } from "../domain/utang.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface BookLine { productId: string | null; productName: string; soldBy: string | null; unitPriceMinor: number; quantity: number; grams: number | null; lineTotalMinor: number; unitCostMinor: number | null }
export interface BookEntry {
  orderId: string; orderNumber: string; source: string | null;
  /** The store whose sale this is (the main store when the order names none). */
  locationId: string | null;
  /** When it was sold (sign 1) or taken back (sign −1). */
  at: Date;
  sign: 1 | -1;
  /** When the order was written down (a pre-order or a delivery is sold later than this). */
  createdAt: Date;
  totalMinor: number; paymentMethod: string; encodedLater: boolean; customerName: string | null; storeCustomerId: string | null;
  items: BookLine[];
}
export interface SalesBook {
  mainId: string | null;
  entries: BookEntry[];
  /** How each split sale was really paid. */
  splits: Map<string, { method: string; amountMinor: number }[]>;
}
export type BookRange = { gte: Date; lt: Date };

const lineSelect = { productId: true, productName: true, soldBy: true, unitPriceMinor: true, quantity: true, grams: true, lineTotalMinor: true, unitCostMinor: true } as const;
const orderSelect = {
  id: true, orderNumber: true, source: true, sellingLocationId: true, totalMinor: true, paymentMethod: true, encodedLater: true,
  customerName: true, storeCustomerId: true, occurredAt: true, createdAt: true, items: { select: lineSelect },
} as const;

/** A sold order that was cancelled afterwards: only a void or a refund writes this row. */
const TAKEN_BACK = { toStatus: "CANCELLED", fromStatus: { in: SOLD_STATES } } as const;

/** The main store (it owns the stock, and old orders with no store are its sales). */
export async function mainLocationId(db: Db, storeId: string): Promise<string | null> {
  return (await db.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } }))?.id ?? null;
}

/** Orders that are `locationId`'s sales: the ones that name it, and for the main store the ones that name no store. */
export function ordersOfStore(locationId: string, mainId: string | null): Prisma.OrderWhereInput {
  return locationId === mainId ? { OR: [{ sellingLocationId: locationId }, { sellingLocationId: null }] } : { sellingLocationId: locationId };
}

/** Money taken at `locationId`: written there, or (old rows with no place) paid for one of its sales. */
export function paymentsOfStore(locationId: string, mainId: string | null): Prisma.PaymentWhereInput {
  return { OR: [{ locationId }, { locationId: null, order: ordersOfStore(locationId, mainId) }] };
}

const soldIn = (range: BookRange): Prisma.OrderWhereInput => ({ OR: [{ occurredAt: range }, { occurredAt: null, createdAt: range }] });

/**
 * Every sale made and every sale taken back in `range` — for one store (`locationId`) or for the
 * whole business, and for one product when `productId` is given.
 */
export async function salesBook(db: Db, storeId: string, range: BookRange, opts: { locationId?: string; productId?: string; mainId?: string | null } = {}): Promise<SalesBook> {
  const mainId = opts.mainId !== undefined ? opts.mainId : await mainLocationId(db, storeId);
  const which: Prisma.OrderWhereInput[] = [];
  if (opts.locationId) which.push(ordersOfStore(opts.locationId, mainId));
  if (opts.productId) which.push({ items: { some: { productId: opts.productId } } });

  const sold = await db.order.findMany({
    where: {
      storeId,
      AND: [
        soldIn(range),
        { OR: [{ status: { in: SOLD_STATES } }, { status: "CANCELLED", statusHistory: { some: TAKEN_BACK } }] },
        ...which,
      ],
    },
    select: orderSelect,
  });
  const back = await db.orderStatusHistory.findMany({
    where: { storeId, ...TAKEN_BACK, createdAt: range, order: { status: "CANCELLED", AND: which } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, order: { select: orderSelect } },
  });

  type Row = (typeof sold)[number];
  const entry = (o: Row, sign: 1 | -1, at: Date): BookEntry => ({
    orderId: o.id, orderNumber: o.orderNumber, source: o.source, locationId: o.sellingLocationId ?? mainId, at, sign, createdAt: o.createdAt,
    totalMinor: o.totalMinor, paymentMethod: o.paymentMethod, encodedLater: !!o.encodedLater, customerName: o.customerName, storeCustomerId: o.storeCustomerId,
    items: o.items.map((i) => ({ ...i })),
  });
  const entries: BookEntry[] = sold.map((o) => entry(o, 1, o.occurredAt ?? o.createdAt));
  const seen = new Set<string>();
  for (const h of back) {
    if (seen.has(h.order.id)) continue; // one sale is taken back once
    seen.add(h.order.id);
    entries.push(entry(h.order, -1, h.createdAt));
  }

  // Rule 6: an agent order is a sale of what was delivered.
  const agentIds = [...new Set(entries.filter((e) => e.source === "AGENT").map((e) => e.orderId))];
  if (agentIds.length) {
    const trips = await db.stockTransfer.findMany({ where: { storeId, orderId: { in: agentIds }, status: { not: "CANCELLED" } }, select: { orderId: true, productId: true, deliveredQty: true } });
    const delivered = new Map<string, Map<string, number>>();
    for (const t of trips) {
      const m = delivered.get(t.orderId!) ?? new Map<string, number>();
      m.set(t.productId, (m.get(t.productId) ?? 0) + (t.deliveredQty ?? 0));
      delivered.set(t.orderId!, m);
    }
    for (const e of entries) {
      const got = delivered.get(e.orderId);
      if (!got) continue; // an old agent order with no trips: leave its lines as they are
      e.items = e.items.map((i) => {
        const q = Math.min(i.quantity, i.productId ? got.get(i.productId) ?? 0 : i.quantity);
        if (q >= i.quantity) return i;
        const loose = i.soldBy === "KILO" || i.soldBy === "PESO";
        return { ...i, quantity: q, grams: loose && i.grams !== null ? q : i.grams, lineTotalMinor: q > 0 ? refundValue(i, q) : 0 };
      });
    }
  }

  const splitIds = [...new Set(entries.filter((e) => e.paymentMethod === "split").map((e) => e.orderId))];
  const splits = new Map<string, { method: string; amountMinor: number }[]>();
  if (splitIds.length) {
    for (const p of await db.payment.findMany({ where: { storeId, orderId: { in: splitIds }, type: "payment" }, select: { orderId: true, method: true, amountMinor: true } })) {
      splits.set(p.orderId!, [...(splits.get(p.orderId!) ?? []), { method: p.method, amountMinor: p.amountMinor }]);
    }
  }
  return { mainId, entries, splits };
}

export interface BookTotals {
  /** Sales made in the dates that were not taken back inside the same dates. */
  count: number;
  /** Money of the sales, less the sales taken back. */
  totalMinor: number;
  cashMinor: number; gcashMinor: number; creditMinor: number; otherMinor: number;
  encodedLater: number;
  /** Sales taken back in the dates (already taken off the numbers above). */
  takenBack: { count: number; totalMinor: number };
}

/** The money of a set of entries, by how it was paid. A split sale counts by what each part paid. */
export function bookTotals(entries: BookEntry[], splits: SalesBook["splits"] = new Map()): BookTotals {
  const t: BookTotals = { count: 0, totalMinor: 0, cashMinor: 0, gcashMinor: 0, creditMinor: 0, otherMinor: 0, encodedLater: 0, takenBack: { count: 0, totalMinor: 0 } };
  const backHere = new Set(entries.filter((e) => e.sign === -1).map((e) => e.orderId));
  for (const e of entries) {
    const s = e.sign;
    t.totalMinor += s * e.totalMinor;
    if (s === 1) {
      if (!backHere.has(e.orderId)) { t.count++; if (e.encodedLater) t.encodedLater++; }
    } else {
      t.takenBack.count++;
      t.takenBack.totalMinor += e.totalMinor;
    }
    if (e.paymentMethod === "split") {
      let rest = e.totalMinor;
      for (const sp of splits.get(e.orderId) ?? []) {
        if (sp.method === "cash") t.cashMinor += s * sp.amountMinor; else if (sp.method === "gcash") t.gcashMinor += s * sp.amountMinor; else t.otherMinor += s * sp.amountMinor;
        rest -= sp.amountMinor;
      }
      if (rest > 0) t.otherMinor += s * rest;
    } else if (e.paymentMethod === "cash" || e.paymentMethod === "cod") t.cashMinor += s * e.totalMinor; // cod: cash paid on delivery or pick-up
    else if (e.paymentMethod === "gcash") t.gcashMinor += s * e.totalMinor;
    else if (e.paymentMethod === "credit") t.creditMinor += s * e.totalMinor;
    else t.otherMinor += s * e.totalMinor;
  }
  return t;
}

export interface BookProduct { id: string; costMinor: number | null; stockBaseUnit: string | null; stockBaseQuantity: number | null }
export interface BookLineValue<P extends BookProduct> {
  entry: BookEntry; line: BookLine; product: P | undefined; loose: boolean;
  /** Already signed: below zero for a sale taken back. */
  salesMinor: number; costMinor: number; grams: number; quantity: number;
}

/** Every line of the book with its sales, cost and weight worked out one way (rule 5). */
export function bookLines<P extends BookProduct>(entries: BookEntry[], productOf: (id: string) => P | undefined): BookLineValue<P>[] {
  const out: BookLineValue<P>[] = [];
  for (const entry of entries) {
    for (const line of entry.items) {
      const product = line.productId ? productOf(line.productId) : undefined;
      const loose = product ? isLooseP(product as never) : line.soldBy === "KILO" || line.soldBy === "PESO";
      const s = entry.sign;
      out.push({
        entry, line, product, loose,
        salesMinor: s * line.lineTotalMinor,
        costMinor: product ? s * lineCost(line, product.costMinor ?? 0, loose) : 0,
        grams: product ? s * lineGrams(line, product.stockBaseUnit === "g" ? product.stockBaseQuantity : null) : 0,
        quantity: s * (loose ? line.grams ?? line.quantity : line.quantity),
      });
    }
  }
  return out;
}

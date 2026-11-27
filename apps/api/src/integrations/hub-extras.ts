// The parts of the SE Corp Hub link that read or write this store's own books (integrations/hub-orders.service.ts
// calls them on its usual beat):
//
//   kiloIds     per-kilo rice is weighed at the counter, so the Page is never offered it.
//   afterPlace  a hub order goes under its customer (found by the hub's reference, else by mobile number, else
//               made), so a Facebook customer earns points and has one history here; and a line the hub sold at
//               another price than ours is marked as a changed price, with why and who.
//   change      the owner or a manager changed a price on a hub order, in the hub: it is done here with the same
//               rule as Orders → Change items (a reason is kept on the line; the owner and a manager may go under the lowest price, as
//               they may on that screen).
//   days        the store's selling days (sales, cost, expenses, profit) from the SALES BOOK, the same numbers as
//               Reports, for the hub's owner.

import type { PrismaClient } from "@prisma/client";
import { isKiloItem } from "../domain/kilo.js";
import { customerAdded } from "../domain/added-where.js";
import { MAX_REASON_LENGTH } from "../domain/price-override.js";
import { dayRange, manilaDate } from "../domain/reports.js";
import { bookLines, salesBook } from "../reports/sales-book.js";
import type { OrderEditLine } from "../admin/order-admin.service.js";
import type { HubDay, HubExtras, HubPriceChange, PlacedInfo } from "./hub-orders.service.js";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** A mobile number as its last 10 digits, so 0917…, +63 917… and 917… are the same person. "" when too short. */
export function phoneKey(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/**
 * What an order's items cost this store: each line's cost frozen with the sale, else the item's cost today. A kilo
 * line's cost is per kilo. Null when any line has no cost on record, so the hub says "not known" instead of a
 * profit that reads too high.
 */
export function hubOrderCost(items: { quantity: number; grams: number | null; soldBy: string | null; unitCostMinor: number | null; product: { costMinor: number } | null }[]): number | null {
  let total = 0;
  for (const i of items) {
    const unit = i.unitCostMinor ?? i.product?.costMinor ?? 0;
    if (unit <= 0) return null;
    total += i.soldBy === "KILO" || i.soldBy === "PESO" ? Math.round((unit * (i.grams ?? i.quantity)) / 1000) : unit * i.quantity;
  }
  return total;
}

/** The words kept on a line whose price the hub changed: the reason, then who. */
export function hubPriceReason(reason: string | undefined, by: string | undefined): string {
  const who = by ? ` (${by}, SE Corp Hub)` : " (SE Corp Hub)";
  const why = (reason ?? "").trim() || "Price given on the Page";
  return `${why.slice(0, MAX_REASON_LENGTH - who.length)}${who}`;
}

/**
 * The lines to save for a price change: every line of the order as it is, with the asked lines at their new price.
 * Every other line keeps the price it was sold at, and its reason when it has one: the edit would otherwise put
 * today's list price on it, and an order already placed keeps its price. (A kept price that is the list price is
 * not a changed price, and is saved as plain.)
 * Returns why not when an asked item is not on the order, or null lines when nothing would change.
 */
export function priceChangeLines(
  lines: { productId: string | null; productName: string; sku: string; quantity: number; unitPriceMinor: number; priceOverridden: boolean; priceOverrideReason: string | null }[],
  change: Pick<HubPriceChange, "items" | "reason" | "by">,
): { error: string } | { lines: OrderEditLine[] | null } {
  const asked = new Map<number, number>();
  for (const item of change.items) {
    // The item's code first: a name can be changed here, a code is not.
    const bySku = item.sku ? lines.findIndex((l) => norm(l.sku) === norm(item.sku!)) : -1;
    const at = bySku >= 0 ? bySku : item.name ? lines.findIndex((l) => norm(l.productName) === norm(item.name!)) : -1;
    if (at < 0) return { error: `"${item.name ?? item.sku}" is not on this order in Sam Store now` };
    asked.set(at, item.unitPriceMinor);
  }
  if ([...asked].every(([at, price]) => lines[at]!.unitPriceMinor === price)) return { lines: null };
  const out: OrderEditLine[] = [];
  for (const [at, l] of lines.entries()) {
    if (!l.productId) return { error: `"${l.productName}" is no longer an item in Sam Store. Change this order in Sam Store` };
    const price = asked.get(at);
    out.push(
      price !== undefined && price !== l.unitPriceMinor
        ? { productId: l.productId, quantity: l.quantity, unitPriceMinorOverride: price, priceOverrideReason: hubPriceReason(change.reason, change.by) }
        : { productId: l.productId, quantity: l.quantity, unitPriceMinorOverride: l.unitPriceMinor, priceOverrideReason: (l.priceOverridden && l.priceOverrideReason) || hubPriceReason(undefined, undefined) },
    );
  }
  return { lines: out };
}

/** Changes an order's lines (OrderAdminService.replaceOrderItems): the hub's price change goes through the same door as the screen's. */
type ReplaceItems = (storeId: string, orderId: string, items: OrderEditLine[], actorId: string | null, role?: string) => Promise<{ ok: true } | { ok: false; error: { message?: string; errors?: string[] } }>;

export function hubExtras(prisma: PrismaClient, replaceItems: ReplaceItems): Omit<HubExtras, "buys"> {
  /** This store's customer for a hub order: the one the hub named, else the one with this mobile number, else a new one. */
  async function customerFor(storeId: string, info: PlacedInfo, locationId: string | null): Promise<string | null> {
    if (info.customerRef) {
      const named = await prisma.storeCustomer.findFirst({ where: { id: info.customerRef, storeId }, select: { id: true } });
      if (named) return named.id;
    }
    const key = phoneKey(info.customerPhone);
    if (!key) return null;
    // This store's own customer first; else the same person known at another store joins this one.
    const known = await prisma.$queryRaw<{ id: string; mine: string | null }[]>`
      SELECT c."id", sc."id" AS "mine"
        FROM "Customer" c LEFT JOIN "StoreCustomer" sc ON sc."customerId" = c."id" AND sc."storeId" = ${storeId}
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(c."phone", ''), '[^0-9]', '', 'g'), 10) = ${key}
       ORDER BY (sc."id" IS NULL), c."createdAt"
       LIMIT 1`;
    if (known[0]?.mine) return known[0].mine;
    const name = info.customerName.trim().replace(/\s+/g, " ").slice(0, 80);
    const customerId =
      known[0]?.id ??
      (await prisma.customer.create({ data: { name, phone: info.customerPhone.trim(), email: null, passwordHash: null, address: info.address?.trim().slice(0, 120) || null } })).id;
    const sc = await prisma.storeCustomer.upsert({
      where: { storeId_customerId: { storeId, customerId } },
      update: {},
      create: { storeId, customerId, ...customerAdded({ locationId, userId: null, via: "ONLINE" }) },
      select: { id: true },
    });
    return sc.id;
  }

  return {
    async kiloIds(storeId) {
      const rows = await prisma.product.findMany({ where: { storeId, stockBaseUnit: { equals: "g", mode: "insensitive" }, stockBaseQuantity: 1 }, select: { id: true, stockBaseUnit: true, stockBaseQuantity: true } });
      return new Set(rows.filter(isKiloItem).map((p) => p.id));
    },

    async afterPlace(storeId, orderNumber, info) {
      const order = await prisma.order.findFirst({
        where: { storeId, orderNumber, source: "hub" },
        select: { id: true, storeCustomerId: true, sellingLocationId: true, items: { select: { id: true, productId: true, priceOverridden: true } } },
      });
      if (!order) return;
      if (!order.storeCustomerId) {
        const storeCustomerId = await customerFor(storeId, info, order.sellingLocationId);
        // Only while it still has no customer: staff may have put it under one meanwhile.
        if (storeCustomerId) await prisma.order.updateMany({ where: { id: order.id, storeCustomerId: null }, data: { storeCustomerId } });
      }
      for (const r of info.repriced) {
        const line = order.items.find((i) => i.productId === r.productId);
        if (!line || line.priceOverridden) continue;
        await prisma.orderItem.update({
          where: { id: line.id },
          data: { priceOverridden: true, priceOverrideReason: hubPriceReason(info.priceReason, info.priceBy), priceOverriddenAt: new Date(), catalogUnitPriceMinor: r.catalogUnitPriceMinor },
        });
      }
    },

    async change(storeId, change) {
      const order = await prisma.order.findFirst({
        where: { storeId, orderNumber: change.orderNumber, source: "hub" },
        select: { id: true, items: { orderBy: { id: "asc" }, select: { productId: true, productName: true, sku: true, quantity: true, unitPriceMinor: true, priceOverridden: true, priceOverrideReason: true } } },
      });
      if (!order) return "Sam Store has no such order from the hub";
      const plan = priceChangeLines(order.items, change);
      if ("error" in plan) return plan.error;
      if (!plan.lines) return null; // already at these prices (the hub asked again after a lost answer)
      const done = await replaceItems(storeId, order.id, plan.lines, null, change.role === "owner" ? "STORE_OWNER" : "MANAGER");
      return done.ok ? null : done.error.errors?.join("; ") || done.error.message || "Sam Store could not change the price";
    },

    async days(storeId, count, now): Promise<HubDay[]> {
      const today = manilaDate(now);
      const first = manilaDate(new Date(dayRange(today).from.getTime() - (count - 1) * 86_400_000));
      const range = { gte: dayRange(first).from, lt: dayRange(today).to };
      const book = await salesBook(prisma, storeId, range);
      const ids = [...new Set(book.entries.flatMap((e) => e.items.map((i) => i.productId).filter((x): x is string => !!x)))];
      const products = new Map(
        (ids.length ? await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, costMinor: true, stockBaseUnit: true, stockBaseQuantity: true } }) : []).map((p) => [p.id, p]),
      );
      const codes = new Map((await prisma.warehouse.findMany({ where: { storeId }, select: { id: true, code: true } })).map((w) => [w.id, w.code ?? ""]));
      const rows = new Map<string, HubDay>();
      // Every day of the range has a row for the whole store, so a day with no sale reads 0 in the hub, not "unknown".
      const row = (day: string, location: string) => {
        const k = `${day} ${location}`;
        let r = rows.get(k);
        if (!r) rows.set(k, (r = { day, location, salesMinor: 0, costMinor: 0, expensesMinor: 0, profitMinor: 0, orders: 0, noCostUnits: 0, hubSalesMinor: 0, hubOrders: 0 }));
        return r;
      };
      for (let t = range.gte.getTime(); t < range.lt.getTime(); t += 86_400_000) row(manilaDate(new Date(t)), "");
      const both = (day: string, locationId: string | null, add: (r: HubDay) => void) => {
        add(row(day, ""));
        const code = locationId ? codes.get(locationId) : "";
        if (code) add(row(day, code));
      };
      for (const e of book.entries) {
        both(manilaDate(e.at), e.locationId, (r) => {
          r.salesMinor += e.sign * e.totalMinor;
          if (e.sign === 1) r.orders += 1;
          if (e.source === "hub") {
            r.hubSalesMinor += e.sign * e.totalMinor;
            if (e.sign === 1) r.hubOrders += 1;
          }
        });
      }
      for (const l of bookLines(book.entries, (id) => products.get(id))) {
        const none = l.entry.sign === 1 && (l.line.unitCostMinor ?? l.product?.costMinor ?? 0) <= 0;
        both(manilaDate(l.entry.at), l.entry.locationId, (r) => {
          r.costMinor += l.costMinor;
          if (none) r.noCostUnits += l.line.quantity;
        });
      }
      const spent = await prisma.expense.findMany({ where: { storeId, voidedAt: null, spentAt: range }, select: { amountMinor: true, spentAt: true, locationId: true } });
      for (const x of spent) both(manilaDate(x.spentAt), x.locationId, (r) => (r.expensesMinor += x.amountMinor));
      for (const r of rows.values()) r.profitMinor = r.salesMinor - r.costMinor - r.expensesMinor;
      return [...rows.values()].sort((a, b) => (a.day === b.day ? a.location.localeCompare(b.location) : a.day < b.day ? 1 : -1));
    },
  };
}

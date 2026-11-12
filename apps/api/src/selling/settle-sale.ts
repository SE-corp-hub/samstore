// One rule for every way of selling (per-store build, step 1).
//
// The moment a sale becomes final at a store, the same things happen however it came in
// (pre-order, Facebook order, agent order): the sale knows its store, each line freezes the
// cost of the shelf it came from, rice taken from another store's shelf books that store's
// profit share, a store that sells the main store's rice is charged the main store's cost,
// and the sale is dated at that moment so it lands in that day's report of that store.
//
// The counter sale (selling/benta.service.ts) does the same steps inline, because it prices
// and writes its lines in the same breath. Everything here runs inside the caller's
// transaction, so a sale and its charge stand or fall together.

import type { Prisma } from "@prisma/client";
import { shelfCostFor } from "../domain/shelf-cost.js";
import { isLoose } from "../domain/selling.js";
import { bookProfitShare, chargeSale } from "../payable/charges.js";
import { reservationLegsForOrder } from "../domain/stock-settlement.js";

type Tx = Prisma.TransactionClient;

/** Freeze each line's cost at the shelf it came from (its own source shelf, else `locationId`). */
export async function freezeLineCosts(tx: Tx, input: { storeId: string; orderId: string; locationId: string | null }): Promise<void> {
  const items = await tx.orderItem.findMany({ where: { orderId: input.orderId, storeId: input.storeId }, select: { id: true, productId: true, sourceLocationId: true } });
  for (const i of items) {
    if (!i.productId) continue;
    const unit = await shelfCostFor(tx, input.storeId, i.productId, i.sourceLocationId ?? input.locationId);
    await tx.orderItem.update({ where: { id: i.id }, data: { unitCostMinor: unit } });
  }
}

/** Where one product of a sale physically came from (an online order holds stock per shelf). */
export interface TakenFrom { productId: string; warehouseId: string | null; quantity: number }

/**
 * The sale `orderId` is final at `locationId` now. Safe to call twice for the same sale:
 * the charge and the profit share are booked once.
 *
 *   sold   what was really handed over, per product, when that is less than the order's lines
 *          (an agent order is paid for what was delivered).
 *   taken  the shelves the rice left, when the lines do not say (an online order's holds):
 *          the profit share is booked per shelf instead of per line.
 */
export async function settleSaleAtStore(
  tx: Tx,
  input: {
    storeId: string; orderId: string; orderNumber: string; locationId: string; actorId: string; at: Date;
    sold?: { productId: string; quantity: number; lineTotalMinor: number }[];
    taken?: TakenFrom[];
  },
): Promise<{ belowCost: string[] }> {
  const { storeId, orderId, locationId } = input;
  await freezeLineCosts(tx, { storeId, orderId, locationId });
  await tx.order.update({ where: { id: orderId }, data: { sellingLocationId: locationId, occurredAt: input.at } });

  const already = await tx.storePayableEntry.findFirst({ where: { storeId, orderId, kind: { in: ["CHARGE", "PROFIT_SHARE"] } }, select: { id: true } });
  if (already) return { belowCost: [] };

  const rows = await tx.orderItem.findMany({
    where: { orderId, storeId },
    select: { productId: true, productName: true, quantity: true, lineTotalMinor: true, sourceLocationId: true },
  });
  const sold = input.sold ? new Map(input.sold.map((l) => [l.productId, l])) : null;
  const items = rows.map((i) => {
    const s = sold && i.productId ? sold.get(i.productId) : undefined;
    return sold ? { ...i, quantity: s?.quantity ?? 0, lineTotalMinor: s?.lineTotalMinor ?? 0 } : i;
  });
  const ids = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
  const products = new Map((await tx.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, stockBaseUnit: true, stockBaseQuantity: true } })).map((p) => [p.id, p]));
  const share = (fromId: string, productId: string, quantity: number) =>
    bookProfitShare(tx, { storeId, fromId, toId: locationId, productId, quantity, actorId: input.actorId, ref: `sale ${input.orderNumber}`, orderId });
  if (input.taken) {
    for (const t of input.taken) if (t.warehouseId && t.warehouseId !== locationId) await share(t.warehouseId, t.productId, t.quantity);
  } else {
    for (const i of items) if (i.productId && i.sourceLocationId && i.sourceLocationId !== locationId) await share(i.sourceLocationId, i.productId, i.quantity);
  }
  return chargeSale(tx, {
    storeId, orderId, orderNumber: input.orderNumber, locationId, actorId: input.actorId,
    lines: items.filter((i) => !!i.productId && products.has(i.productId)).map((i) => ({
      productId: i.productId!, productName: i.productName, quantity: i.quantity, loose: isLoose(products.get(i.productId!)!), lineTotalMinor: i.lineTotalMinor,
    })),
  });
}

/** Orders that hold their rice from checkout and become a sale only when it is handed over. */
export const HANDED_OVER_SOURCES = ["online", "hub"];

/**
 * An online or Facebook order was just handed to the customer (picked up, delivered, or paid at the
 * counter): it becomes a sale at its store NOW. Its store is the one the Page named, else the main
 * store. Cash on delivery is written as that store's cash, once, when nothing was paid before.
 * Call it inside the transaction that changes the status, after the order row was updated (that
 * update holds the row, so two callers cannot both settle). No-op for every other kind of order.
 */
export async function settleHandedOverOrder(
  tx: Tx,
  input: { storeId: string; orderId: string; actorId: string | null; at?: Date; cashCollectedMinor?: number },
): Promise<void> {
  const { storeId, orderId } = input;
  const order = await tx.order.findFirst({
    where: { id: orderId, storeId },
    select: { orderNumber: true, source: true, sellingLocationId: true, paymentMethod: true, totalMinor: true },
  });
  if (!order || !HANDED_OVER_SOURCES.includes(order.source)) return;
  const locationId = order.sellingLocationId ?? (await tx.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true }, select: { id: true } }))?.id ?? null;
  if (!locationId) return; // a store with no locations set up: nothing is per store there
  const actorId = input.actorId ?? "system";
  const at = input.at ?? new Date();

  // The shelves this order held its rice on. A line that came whole from one other shelf says so
  // (its cost is that shelf's); the profit share follows every shelf, also for a split line.
  const taken = await reservationLegsForOrder(tx, storeId, orderId);
  const items = await tx.orderItem.findMany({ where: { orderId, storeId }, select: { id: true, productId: true, variantId: true } });
  for (const i of items) {
    if (!i.productId) continue;
    const legs = taken.filter((t) => t.productId === i.productId && (t.variantId ?? null) === (i.variantId ?? null));
    const only = legs.length === 1 ? legs[0]!.warehouseId : null;
    if (only && only !== locationId) await tx.orderItem.update({ where: { id: i.id }, data: { sourceLocationId: only } });
  }
  await settleSaleAtStore(tx, { storeId, orderId, orderNumber: order.orderNumber, locationId, actorId, at, taken });

  if (order.paymentMethod !== "cod") return;
  const paid = await tx.payment.findFirst({ where: { orderId, storeId, type: "payment", amountMinor: { gt: 0 } }, select: { id: true } });
  if (paid) return;
  const amount = input.cashCollectedMinor ?? order.totalMinor;
  if (amount <= 0) return;
  await tx.payment.create({
    data: { orderId, storeId, method: "cash", amountMinor: amount, type: "payment", status: "paid", note: `Cash on delivery ${order.orderNumber}`.slice(0, 200), createdBy: input.actorId, locationId, receivedAt: at },
  });
}

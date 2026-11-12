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

/**
 * The sale `orderId` is final at `locationId` now. Safe to call twice for the same sale:
 * the charge and the profit share are booked once.
 */
export async function settleSaleAtStore(
  tx: Tx,
  input: { storeId: string; orderId: string; orderNumber: string; locationId: string; actorId: string; at: Date },
): Promise<{ belowCost: string[] }> {
  const { storeId, orderId, locationId } = input;
  await freezeLineCosts(tx, { storeId, orderId, locationId });
  await tx.order.update({ where: { id: orderId }, data: { sellingLocationId: locationId, occurredAt: input.at } });

  const already = await tx.storePayableEntry.findFirst({ where: { storeId, orderId, kind: { in: ["CHARGE", "PROFIT_SHARE"] } }, select: { id: true } });
  if (already) return { belowCost: [] };

  const items = await tx.orderItem.findMany({
    where: { orderId, storeId },
    select: { productId: true, productName: true, quantity: true, lineTotalMinor: true, sourceLocationId: true },
  });
  const ids = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
  const products = new Map((await tx.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, stockBaseUnit: true, stockBaseQuantity: true } })).map((p) => [p.id, p]));
  for (const i of items) {
    if (!i.productId || !i.sourceLocationId || i.sourceLocationId === locationId) continue;
    await bookProfitShare(tx, { storeId, fromId: i.sourceLocationId, toId: locationId, productId: i.productId, quantity: i.quantity, actorId: input.actorId, ref: `sale ${input.orderNumber}`, orderId });
  }
  return chargeSale(tx, {
    storeId, orderId, orderNumber: input.orderNumber, locationId, actorId: input.actorId,
    lines: items.filter((i) => !!i.productId && products.has(i.productId)).map((i) => ({
      productId: i.productId!, productName: i.productName, quantity: i.quantity, loose: isLoose(products.get(i.productId!)!), lineTotalMinor: i.lineTotalMinor,
    })),
  });
}

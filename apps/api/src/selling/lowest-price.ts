// The lowest price a sale may go to (system review 2026-11-20, finding 5).
//
// The owner and a manager may sell at any price (the "below cost" popup still asks them first).
// Every other login may CHANGE a price at the counter only down to the lowest price of that rice:
// the owner's "lowest price" (Store prices) when one is set, else what the rice cost at that store.
// A price that was not changed (the list price, a customer's special price) is never refused, and
// neither is a changed price that was already on the order before this edit.

import type { Prisma, PrismaClient } from "@prisma/client";
import { seesCost } from "../domain/cost-redact.js";
import { costModeOf, effectiveCost } from "../domain/shelf-cost.js";
import { consignmentMain } from "../payable/charges.js";

type Db = PrismaClient | Prisma.TransactionClient;

const pesos = (minor: number) => `₱${(minor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pure rule: why this login may not sell one line at this price (null = it may). */
export function belowLowestRefusal(role: string | undefined, line: { name: string; unitPriceMinor: number; overridden: boolean }, lowestMinor: number): string | null {
  if (!line.overridden || seesCost(role)) return null;
  if (line.unitPriceMinor <= 0) return `${line.name}: only the owner can give rice for free.`;
  if (line.unitPriceMinor < lowestMinor) return `${line.name}: the lowest price is ${pesos(lowestMinor)}. Only the owner can sell lower.`;
  return null;
}

/** The lowest price of each product at one store (no store = the main price list's cost). */
export async function lowestPrices(db: Db, storeId: string, locationId: string | null, productIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(productIds)];
  const products = await db.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, floorPriceMinor: true, costMinor: true } });
  const costLoc = locationId ? (await consignmentMain(db as Prisma.TransactionClient, storeId, locationId)) ?? locationId : null;
  const mode = await costModeOf(db as Prisma.TransactionClient, storeId);
  const shelf = costLoc && mode === "PER_LOCATION"
    ? new Map((await db.stockLevel.findMany({ where: { storeId, warehouseId: costLoc, productId: { in: ids } }, select: { productId: true, costMinor: true } })).map((l) => [l.productId, l.costMinor]))
    : new Map<string, number | null>();
  return new Map(products.map((p) => [p.id, typeof p.floorPriceMinor === "number" ? p.floorPriceMinor : effectiveCost(mode, shelf.get(p.id), p.costMinor ?? 0)]));
}

/**
 * Check the changed prices of a sale or an order. `kept`: prices already on the order (product → unit
 * price), which an edit by staff may leave as they are.
 */
export async function lowestPriceRefusal(
  db: Db,
  input: { storeId: string; role: string | undefined; locationId: string | null; lines: { productId: string; name: string; unitPriceMinor: number; overridden: boolean }[]; kept?: Map<string, number> },
): Promise<string | null> {
  if (seesCost(input.role)) return null;
  const changed = input.lines.filter((l) => l.overridden && input.kept?.get(l.productId) !== l.unitPriceMinor);
  if (changed.length === 0) return null;
  const lowest = await lowestPrices(db, input.storeId, input.locationId, changed.map((l) => l.productId));
  for (const l of changed) {
    const why = belowLowestRefusal(input.role, l, lowest.get(l.productId) ?? 0);
    if (why) return why;
  }
  return null;
}

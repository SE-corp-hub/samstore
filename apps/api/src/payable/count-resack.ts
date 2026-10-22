// A consignment store sells loose rice from sacks it opens, but nobody records the opening.
// When the owner approves its count, the system works out how many sacks were opened and
// records the resack itself ("Resack from count"), so sacks and loose kilos are both right again.

import type { Prisma } from "@prisma/client";
import { adjustForCount, InsufficientStockError, type TripLeg } from "../domain/movements.js";
import { varietyOf } from "../domain/resack.js";
import { consignmentMain } from "./charges.js";

type Tx = Prisma.TransactionClient;

interface CountLine {
  productId: string;
  expectedQty: number | null;
  countedQty: number | null;
  product: { name: string; variety?: string | null; stockBaseUnit: string | null; stockBaseQuantity: number | null };
}

/** Returns what was moved per product (sack: −k, loose: +k × grams) so the count only posts what is left over. */
export async function autoResackFromCount(
  tx: Tx, input: { storeId: string; locationId: string; countId: string; countDoc: string; actorId: string; lines: CountLine[] },
): Promise<Map<string, number>> {
  const moved = new Map<string, number>();
  if (!(await consignmentMain(tx, input.storeId, input.locationId))) return moved;
  const groups = new Map<string, CountLine[]>();
  for (const l of input.lines) {
    if (l.countedQty === null || l.expectedQty === null) continue;
    if ((l.product.stockBaseUnit ?? "").toLowerCase() !== "g" || !l.product.stockBaseQuantity) continue;
    const key = varietyOf(l.product);
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  for (const [variety, lines] of groups) {
    const loose = lines.find((l) => l.product.stockBaseQuantity === 1);
    const sack = lines.filter((l) => (l.product.stockBaseQuantity ?? 0) > 1).sort((a, b) => b.product.stockBaseQuantity! - a.product.stockBaseQuantity!)[0];
    if (!loose || !sack) continue;
    const surplus = loose.countedQty! - loose.expectedQty!;
    const sackGone = sack.expectedQty! - sack.countedQty!;
    if (surplus <= 0 || sackGone <= 0) continue;
    const grams = sack.product.stockBaseQuantity!;
    const k = Math.min(sackGone, Math.ceil(surplus / grams));
    const leg = (productId: string): TripLeg => ({ storeId: input.storeId, productId, warehouseId: input.locationId, actorId: input.actorId, documentType: "COUNT_RESACK", documentId: input.countId, note: `Resack from count ${input.countDoc}` });
    try {
      await adjustForCount(tx, leg(sack.productId), -k);
    } catch (e) {
      if (e instanceof InsufficientStockError) continue; // part of it is held elsewhere: leave it to the count
      throw e;
    }
    await adjustForCount(tx, leg(loose.productId), k * grams);
    moved.set(sack.productId, -k);
    moved.set(loose.productId, k * grams);
    await tx.auditLog.create({
      data: { storeId: input.storeId, actorType: "USER", actorId: input.actorId, action: "count.auto_resack", entityType: "StockCount", entityId: input.countId, after: { variety, sacksOpened: k, grams: k * grams, unexplainedGrams: Math.max(0, surplus - k * grams) } },
    });
  }
  return moved;
}

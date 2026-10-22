// A consignment store sells loose rice from sacks it opens, but nobody records the opening.
// When the owner approves its count, the system works out how many sacks were opened and
// records the resack itself ("Resack from count"), so sacks and loose kilos are both right again.

import type { Prisma } from "@prisma/client";
import { adjustForCount, InsufficientStockError, type TripLeg } from "../domain/movements.js";
import { planOpenedSacks } from "../domain/count-resack.js";
import { consignmentMain } from "./charges.js";

type Tx = Prisma.TransactionClient;

interface CountLine {
  productId: string;
  expectedQty: number | null;
  countedQty: number | null;
  product: { name: string; variety?: string | null; stockBaseUnit: string | null; stockBaseQuantity: number | null };
}

/**
 * Returns what was moved per product (sack: −k, loose: +k × grams) so the count only posts what is left over.
 * Automatic at a consignment store. Anywhere else only for the kinds of rice in `varieties`
 * (the counter said "yes, a sack was opened" at the check step).
 */
export async function autoResackFromCount(
  tx: Tx, input: { storeId: string; locationId: string; countId: string; countDoc: string; actorId: string; lines: CountLine[]; varieties?: string[] },
): Promise<Map<string, number>> {
  const moved = new Map<string, number>();
  const consignment = !!(await consignmentMain(tx, input.storeId, input.locationId));
  if (!consignment && !(input.varieties && input.varieties.length)) return moved;
  const wanted = consignment ? null : new Set(input.varieties);
  for (const plan of planOpenedSacks(input.lines)) {
    if (wanted && !wanted.has(plan.variety)) continue;
    const grams = plan.grams / plan.sacks;
    const k = plan.sacks;
    const leg = (productId: string): TripLeg => ({ storeId: input.storeId, productId, warehouseId: input.locationId, actorId: input.actorId, documentType: "COUNT_RESACK", documentId: input.countId, note: `Resack from count ${input.countDoc}` });
    try {
      await adjustForCount(tx, leg(plan.sackProductId), -k);
    } catch (e) {
      if (e instanceof InsufficientStockError) continue; // part of it is held elsewhere: leave it to the count
      throw e;
    }
    await adjustForCount(tx, leg(plan.looseProductId), k * grams);
    moved.set(plan.sackProductId, -k);
    moved.set(plan.looseProductId, k * grams);
    await tx.auditLog.create({
      data: { storeId: input.storeId, actorType: "USER", actorId: input.actorId, action: "count.auto_resack", entityType: "StockCount", entityId: input.countId, after: { variety: plan.variety, sacksOpened: k, grams: k * grams, unexplainedGrams: plan.unexplainedGrams, automatic: consignment } },
    });
  }
  return moved;
}

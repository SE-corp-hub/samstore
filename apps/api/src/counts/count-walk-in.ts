// "Missing = sold to walk-ins": a store that does not ring up its walk-in customers finds the rice
// they bought as a shortage in the closing count. The owner or manager records those shortages as
// one walk-in cash sale at the store's price, so the store's sales and profit are right.
//
//   The shelf is not touched twice: the count's shortage is put back (COUNT_ADJUST +) and the sale
//   takes it again (CONSUME), all in the sale's transaction. At a consignment store the count's
//   shortage charge is undone and the sale charges the main store's cost once.

import type { Prisma } from "@prisma/client";
import { adjustForCount } from "../domain/movements.js";
import { isLoose, priceAt } from "../domain/selling.js";
import { amountForGrams } from "../domain/weight.js";
import { nextDocNumber } from "../people/people.service.js";

type Db = Prisma.TransactionClient;

export interface WalkInLine {
  lineId: string; productId: string; name: string; loose: boolean;
  /** Stock units missing (loose rice: grams). */
  quantity: number; priceMinor: number; amountMinor: number;
}

/** The shortages of an approved count that can still be recorded as walk-in sales, at the counted store's price. */
export async function walkInLines(db: Db, storeId: string, countId: string): Promise<WalkInLine[]> {
  const count = await db.stockCount.findFirst({ where: { id: countId, storeId, status: "APPROVED" }, select: { locationId: true } });
  if (!count) return [];
  const lines = await db.stockCountLine.findMany({
    where: { countId, postedQty: { lt: 0 }, walkInOrderId: null },
    include: { product: { select: { id: true, name: true, priceMinor: true, stockBaseUnit: true, stockBaseQuantity: true, isActive: true } } },
  });
  const prices = new Map((await db.locationPrice.findMany({ where: { storeId, warehouseId: count.locationId, productId: { in: lines.map((l) => l.productId) } }, select: { productId: true, priceMinor: true } })).map((p) => [p.productId, p.priceMinor]));
  return lines
    .filter((l) => l.product.isActive)
    .map((l) => {
      const loose = isLoose(l.product);
      const quantity = -(l.postedQty ?? 0);
      const priceMinor = priceAt(l.product.priceMinor, prices.get(l.productId));
      return { lineId: l.id, productId: l.productId, name: l.product.name, loose, quantity, priceMinor, amountMinor: loose ? amountForGrams(quantity, priceMinor) : quantity * priceMinor };
    })
    .filter((l) => l.priceMinor > 0)
    .sort((a, b) => b.amountMinor - a.amountMinor || a.name.localeCompare(b.name));
}

/**
 * Inside the sale's transaction, before its stock leaves: put each shortage back on the shelf, undo
 * its count charge, and tie the count line to the sale. A line already recorded is refused, so a
 * shortage is never sold twice.
 */
export async function shortsBecomeSale(
  tx: Db, input: { storeId: string; countId: string; lineIds: string[]; orderId: string; orderNumber: string; actorId: string },
): Promise<void> {
  const count = await tx.stockCount.findFirstOrThrow({ where: { id: input.countId, storeId: input.storeId, status: "APPROVED" }, select: { id: true, docNumber: true, locationId: true } });
  const claimed = await tx.stockCountLine.updateMany({
    where: { id: { in: input.lineIds }, countId: count.id, postedQty: { lt: 0 }, walkInOrderId: null },
    data: { walkInOrderId: input.orderId },
  });
  if (claimed.count !== input.lineIds.length) throw new WalkInTaken();
  const lines = await tx.stockCountLine.findMany({ where: { id: { in: input.lineIds } }, select: { id: true, productId: true, postedQty: true } });
  for (const l of lines) {
    await adjustForCount(tx, {
      storeId: input.storeId, productId: l.productId, warehouseId: count.locationId, actorId: input.actorId,
      documentType: "COUNT", documentId: count.id, note: `Bilang ${count.docNumber} · sold to walk-ins (${input.orderNumber})`,
    }, -(l.postedQty ?? 0));
    const charge = await tx.storePayableEntry.findFirst({ where: { storeId: input.storeId, sourceLineId: l.id, kind: "CHARGE" } });
    if (charge && !(await tx.storePayableEntry.findFirst({ where: { reversesId: charge.id }, select: { id: true } }))) {
      const docNumber = await nextDocNumber(tx, input.storeId, "SP");
      await tx.storePayableEntry.create({
        data: {
          storeId: input.storeId, docNumber, locationId: charge.locationId, kind: "REVERSAL", amountMinor: -charge.amountMinor, productId: charge.productId, quantity: charge.quantity,
          unitCostMinor: charge.unitCostMinor, reversesId: charge.id, note: `Undo ${charge.docNumber}: sold to walk-ins (${input.orderNumber})`.slice(0, 200), createdById: input.actorId,
        },
      });
    }
  }
}

/** Someone else recorded these shortages a moment ago. */
export class WalkInTaken extends Error {
  constructor() {
    super("These shortages were already recorded as walk-in sales");
  }
}

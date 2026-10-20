// Buffer store: shortages are taken from it instead of pushing a store's count below zero.
// Its count may go negative — that negative number is the "to fix" list until the stock is managed.

import { deductStock, type MovementTx } from "./movements.js";

/** The store's active Buffer location, if one exists. */
export async function bufferIdOf(tx: MovementTx, storeId: string): Promise<string | null> {
  const w = await tx.warehouse.findFirst({ where: { storeId, type: "BUFFER", isActive: true }, select: { id: true } });
  return w?.id ?? null;
}

/**
 * Take `quantity` at `warehouseId`: what is there comes off the store, the rest (when a Buffer store exists)
 * comes off the Buffer. With no Buffer the store itself goes below zero, as before.
 */
export async function deductWithBuffer(
  tx: MovementTx, storeId: string, line: { productId: string; quantity: number },
  opts: { orderId: string; createdBy: string; warehouseId: string; documentType: string; documentId: string },
): Promise<{ fromBuffer: number }> {
  const base = { type: "CONSUME", orderId: opts.orderId, createdBy: opts.createdBy, documentType: opts.documentType, documentId: opts.documentId };
  const bufferId = await bufferIdOf(tx, storeId);
  if (!bufferId || bufferId === opts.warehouseId) {
    await deductStock(tx, storeId, [line], { ...base, warehouseId: opts.warehouseId, allowBelowZero: true });
    return { fromBuffer: 0 };
  }
  const level = await tx.stockLevel.findFirst({ where: { storeId, productId: line.productId, warehouseId: opts.warehouseId }, select: { quantityOnHand: true, quantityReserved: true } });
  const available = Math.max(0, (level?.quantityOnHand ?? 0) - (level?.quantityReserved ?? 0));
  const here = Math.min(available, line.quantity);
  const rest = line.quantity - here;
  if (here > 0) await deductStock(tx, storeId, [{ productId: line.productId, quantity: here }], { ...base, warehouseId: opts.warehouseId });
  if (rest > 0) await deductStock(tx, storeId, [{ productId: line.productId, quantity: rest }], { ...base, warehouseId: bufferId, allowBelowZero: true });
  return { fromBuffer: rest };
}

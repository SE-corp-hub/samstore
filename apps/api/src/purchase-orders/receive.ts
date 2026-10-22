// Receiving a delivery against a purchase order (called from Stock in).
// The order fixes the supplier and the agreed cost; what arrives fills its lines, and what arrived is what is owed.

import type { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { SellingError } from "../domain/selling.js";

type Tx = Prisma.TransactionClient;

export interface OpenOrder {
  id: string;
  docNumber: string;
  supplierName: string;
  locationId: string;
  lines: { id: string; productId: string; quantity: number; receivedQty: number; unitCostMinor: number }[];
}

/** The order a delivery is being received against: it must exist, still be open, and be for this location. */
export async function loadOpenOrder(storeId: string, orderId: string, locationId: string): Promise<OpenOrder> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: orderId, storeId },
    select: { id: true, docNumber: true, supplierName: true, locationId: true, status: true, lines: { select: { id: true, productId: true, quantity: true, receivedQty: true, unitCostMinor: true } } },
  });
  if (!po) throw new SellingError("Purchase order not found");
  if (po.status === "CANCELLED") throw new SellingError(`${po.docNumber} was cancelled`);
  if (po.status === "RECEIVED") throw new SellingError(`${po.docNumber} is already complete`);
  if (po.locationId !== locationId) throw new SellingError(`${po.docNumber} is for another location`);
  return po;
}

/** Inside the Stock in transaction: add what arrived to the order's lines and move its status (OPEN → PARTLY → RECEIVED). */
export async function applyReceipt(tx: Tx, storeId: string, orderId: string, received: { poLineId: string; quantity: number }[]): Promise<void> {
  const po = await tx.purchaseOrder.findFirst({ where: { id: orderId, storeId, status: { in: ["OPEN", "PARTLY"] } }, select: { id: true } });
  if (!po) throw new SellingError("This purchase order is closed");
  for (const r of received) {
    const line = await tx.purchaseOrderLine.findFirst({ where: { id: r.poLineId, orderId }, select: { quantity: true } });
    if (!line) throw new SellingError("That item is not on this purchase order");
    // Guarded: two phones receiving the same order at once cannot both go over what was ordered.
    const done = await tx.purchaseOrderLine.updateMany({ where: { id: r.poLineId, orderId, receivedQty: { lte: line.quantity - r.quantity } }, data: { receivedQty: { increment: r.quantity } } });
    if (done.count !== 1) throw new SellingError("Someone just received this order. Check what is left and try again.");
  }
  const lines = await tx.purchaseOrderLine.findMany({ where: { orderId }, select: { quantity: true, receivedQty: true } });
  const complete = lines.every((l) => l.receivedQty >= l.quantity);
  const any = lines.some((l) => l.receivedQty > 0);
  await tx.purchaseOrder.update({ where: { id: orderId }, data: { status: complete ? "RECEIVED" : any ? "PARTLY" : "OPEN" } });
}

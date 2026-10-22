// Store payable — the automatic charges of a consignment store (one that sells the main store's rice).
// Every function runs inside the caller's transaction, so a sale and its charge stand or fall together.

import type { Prisma } from "@prisma/client";
import { shelfCostFor } from "../domain/shelf-cost.js";
import { nextDocNumber } from "../people/people.service.js";

type Tx = Prisma.TransactionClient;

/** Peso value of `qty` stock units at `unitMinor` (loose rice: grams, cost per kilo). */
export function chargeAmount(loose: boolean, qty: number, unitMinor: number): number {
  return loose ? Math.round((qty * unitMinor) / 1000) : qty * unitMinor;
}

/** The main store (the default location) when `locationId` is a consignment store; otherwise null. */
export async function consignmentMain(tx: Tx, storeId: string, locationId: string): Promise<string | null> {
  const loc = await tx.warehouse.findFirst({ where: { id: locationId, storeId, consignment: true, isActive: true }, select: { id: true } });
  if (!loc) return null;
  const main = await tx.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } });
  return main && main.id !== loc.id ? main.id : null;
}

/** A sale at a consignment store owes the main store's cost for each item sold. Returns the lines sold below that cost. */
export async function chargeSale(
  tx: Tx, input: {
    storeId: string; orderId: string; orderNumber: string; locationId: string; actorId: string;
    lines: { productId: string; productName: string; quantity: number; loose: boolean; lineTotalMinor: number }[];
  },
): Promise<{ belowCost: string[] }> {
  const main = await consignmentMain(tx, input.storeId, input.locationId);
  const belowCost: string[] = [];
  if (!main) return { belowCost };
  for (const l of input.lines) {
    if (l.quantity <= 0) continue;
    const unit = await shelfCostFor(tx, input.storeId, l.productId, main);
    const amount = chargeAmount(l.loose, l.quantity, unit);
    if (amount <= 0) continue;
    if (l.lineTotalMinor < amount) belowCost.push(l.productName);
    const docNumber = await nextDocNumber(tx, input.storeId, "SP");
    await tx.storePayableEntry.create({
      data: {
        storeId: input.storeId, docNumber, locationId: input.locationId, kind: "CHARGE", amountMinor: amount, productId: l.productId, quantity: l.quantity,
        unitCostMinor: unit, sourceLocationId: main, orderId: input.orderId, note: `Sale ${input.orderNumber}`, createdById: input.actorId,
      },
    });
  }
  return { belowCost };
}

/** A voided sale takes its charges away again. */
export async function reverseSaleCharges(tx: Tx, storeId: string, orderId: string, actorId: string, why: string): Promise<void> {
  const charges = await tx.storePayableEntry.findMany({ where: { storeId, orderId, kind: "CHARGE" } });
  for (const c of charges) {
    if (await tx.storePayableEntry.findFirst({ where: { reversesId: c.id }, select: { id: true } })) continue;
    const docNumber = await nextDocNumber(tx, storeId, "SP");
    await tx.storePayableEntry.create({
      data: { storeId, docNumber, locationId: c.locationId, kind: "REVERSAL", amountMinor: -c.amountMinor, productId: c.productId, quantity: c.quantity, unitCostMinor: c.unitCostMinor, orderId, reversesId: c.id, note: `Undo ${c.docNumber}: ${why}`.slice(0, 200), createdById: actorId },
    });
  }
}

/** Good rice a customer brings back to a consignment store is unsold again: the charge for it comes off. */
export async function reduceForReturn(
  tx: Tx, input: { storeId: string; orderId: string; productId: string; quantity: number; actorId: string; docNumber: string },
): Promise<void> {
  const charge = await tx.storePayableEntry.findFirst({ where: { storeId: input.storeId, orderId: input.orderId, productId: input.productId, kind: "CHARGE" } });
  if (!charge || !charge.quantity || !charge.unitCostMinor) return;
  const done = await tx.storePayableEntry.aggregate({ where: { storeId: input.storeId, orderId: input.orderId, productId: input.productId, kind: "REVERSAL" }, _sum: { quantity: true } });
  const room = charge.quantity - (done._sum.quantity ?? 0);
  const qty = Math.min(input.quantity, room);
  if (qty <= 0) return;
  const product = await tx.product.findFirst({ where: { id: input.productId }, select: { stockBaseUnit: true, stockBaseQuantity: true } });
  const loose = (product?.stockBaseUnit ?? "").toLowerCase() === "g" && product?.stockBaseQuantity === 1;
  const docNumber = await nextDocNumber(tx, input.storeId, "SP");
  await tx.storePayableEntry.create({
    data: { storeId: input.storeId, docNumber, locationId: charge.locationId, kind: "REVERSAL", amountMinor: -chargeAmount(loose, qty, charge.unitCostMinor), productId: input.productId, quantity: qty, unitCostMinor: charge.unitCostMinor, orderId: input.orderId, note: `Customer return ${input.docNumber}`, createdById: input.actorId },
  });
}

/** A shortage found by an approved count at a consignment store is charged to that store, at the main store's cost. The owner may undo it. */
export async function chargeCountShort(
  tx: Tx, input: { storeId: string; countId: string; countDoc: string; locationId: string; actorId: string },
): Promise<void> {
  const main = await consignmentMain(tx, input.storeId, input.locationId);
  if (!main) return;
  const lines = await tx.stockCountLine.findMany({ where: { countId: input.countId, postedQty: { lt: 0 } }, include: { product: { select: { stockBaseUnit: true, stockBaseQuantity: true } } } });
  for (const l of lines) {
    const qty = -(l.postedQty ?? 0);
    const unit = await shelfCostFor(tx, input.storeId, l.productId, main);
    const loose = (l.product.stockBaseUnit ?? "").toLowerCase() === "g" && l.product.stockBaseQuantity === 1;
    const amount = chargeAmount(loose, qty, unit);
    if (amount <= 0) continue;
    const docNumber = await nextDocNumber(tx, input.storeId, "SP");
    await tx.storePayableEntry.create({
      data: { storeId: input.storeId, docNumber, locationId: input.locationId, kind: "CHARGE", amountMinor: amount, productId: l.productId, quantity: qty, unitCostMinor: unit, sourceLocationId: main, sourceLineId: l.id, note: `Short found in count ${input.countDoc}`, createdById: input.actorId },
    });
  }
}

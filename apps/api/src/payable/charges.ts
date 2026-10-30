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

/** A voided sale takes its charges (and the profit share of rice it took from a consignment store) away again. */
export async function reverseSaleCharges(tx: Tx, storeId: string, orderId: string, actorId: string, why: string): Promise<void> {
  const charges = await tx.storePayableEntry.findMany({ where: { storeId, orderId, kind: { in: ["CHARGE", "PROFIT_SHARE"] } } });
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

// ─────────────────────────── Profit share ───────────────────────────
//   Store 1 (the main store) owns the rice at a consignment store. When Store 1 takes rice from it,
//   Store 1 pays that store only the profit it would have made: its selling price − the main store's
//   cost, booked when the rice ARRIVES (sold or not). Rice lost on the road earns no share. Rice that
//   goes back to the consignment store takes the share back (sacks shared in the last 30 days).

export const SHARE_BACK_DAYS = 30;

const looseOf = (p: { stockBaseUnit: string | null; stockBaseQuantity: number | null }) => (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1;

/** The consignment store's margin on one stock unit (loose rice: per kilo): its selling price − the main store's cost. */
export async function shareMargin(tx: Tx, storeId: string, productId: string, consignmentId: string, mainId: string): Promise<number> {
  const product = await tx.product.findFirst({ where: { id: productId, storeId }, select: { priceMinor: true } });
  const price = (await tx.locationPrice.findFirst({ where: { storeId, warehouseId: consignmentId, productId }, select: { priceMinor: true } }))?.priceMinor ?? product?.priceMinor ?? 0;
  return price - (await shelfCostFor(tx, storeId, productId, mainId));
}

/**
 * Rice from a consignment store arrived at (or was sold by) its main store: the main store owes that store
 * its margin. A negative entry on the consignment store's payable. Returns the amount (0 when not a share).
 */
export async function bookProfitShare(
  tx: Tx, input: { storeId: string; fromId: string; toId: string; productId: string; quantity: number; actorId: string; ref: string; transferId?: string; orderId?: string },
): Promise<number> {
  if (input.quantity <= 0) return 0;
  const main = await consignmentMain(tx, input.storeId, input.fromId);
  if (!main || main !== input.toId) return 0;
  const margin = await shareMargin(tx, input.storeId, input.productId, input.fromId, main);
  if (margin <= 0) return 0;
  const product = await tx.product.findFirstOrThrow({ where: { id: input.productId }, select: { stockBaseUnit: true, stockBaseQuantity: true } });
  const amount = chargeAmount(looseOf(product), input.quantity, margin);
  if (amount <= 0) return 0;
  const docNumber = await nextDocNumber(tx, input.storeId, "SP");
  await tx.storePayableEntry.create({
    data: {
      storeId: input.storeId, docNumber, locationId: input.fromId, kind: "PROFIT_SHARE", amountMinor: -amount, productId: input.productId, quantity: input.quantity,
      unitCostMinor: margin, sourceLocationId: main, transferId: input.transferId ?? null, orderId: input.orderId ?? null, note: `Profit share: ${input.ref}`.slice(0, 200), createdById: input.actorId,
    },
  });
  return amount;
}

/**
 * Rice moved from the main store back to a consignment store: the share paid on it in the last 30 days
 * comes back (at the margin it was shared at, newest first). Rice never shared earns nothing back.
 */
export async function takeBackShare(
  tx: Tx, input: { storeId: string; fromId: string; toId: string; productId: string; quantity: number; actorId: string; ref: string; transferId?: string },
): Promise<number> {
  if (input.quantity <= 0) return 0;
  const main = await consignmentMain(tx, input.storeId, input.toId);
  if (!main || main !== input.fromId) return 0;
  const since = new Date(Date.now() - SHARE_BACK_DAYS * 86_400_000);
  const where = { storeId: input.storeId, locationId: input.toId, productId: input.productId, createdAt: { gte: since } };
  const shares = await tx.storePayableEntry.findMany({ where: { ...where, kind: "PROFIT_SHARE" }, orderBy: { createdAt: "desc" }, select: { id: true, quantity: true, unitCostMinor: true } });
  const undone = new Set((await tx.storePayableEntry.findMany({ where: { reversesId: { in: shares.map((s) => s.id) } }, select: { reversesId: true } })).map((r) => r.reversesId));
  let back = (await tx.storePayableEntry.aggregate({ where: { ...where, kind: "SHARE_BACK" }, _sum: { quantity: true } }))._sum.quantity ?? 0;
  const product = await tx.product.findFirstOrThrow({ where: { id: input.productId }, select: { stockBaseUnit: true, stockBaseQuantity: true } });
  // The newest shares are taken back first; what earlier take-backs used is skipped oldest-first.
  const open: { qty: number; margin: number }[] = [];
  for (const s of [...shares].reverse()) {
    if (undone.has(s.id)) continue;
    const used = Math.min(back, s.quantity ?? 0);
    back -= used;
    if ((s.quantity ?? 0) - used > 0) open.push({ qty: (s.quantity ?? 0) - used, margin: s.unitCostMinor ?? 0 });
  }
  let left = input.quantity;
  let total = 0;
  for (const o of open.reverse()) {
    if (left <= 0) break;
    const qty = Math.min(left, o.qty);
    left -= qty;
    const amount = chargeAmount(looseOf(product), qty, o.margin);
    if (amount <= 0) continue;
    const docNumber = await nextDocNumber(tx, input.storeId, "SP");
    await tx.storePayableEntry.create({
      data: {
        storeId: input.storeId, docNumber, locationId: input.toId, kind: "SHARE_BACK", amountMinor: amount, productId: input.productId, quantity: qty,
        unitCostMinor: o.margin, sourceLocationId: main, transferId: input.transferId ?? null, note: `Share taken back: ${input.ref}`.slice(0, 200), createdById: input.actorId,
      },
    });
    total += amount;
  }
  return total;
}

/**
 * Profit share by location in a period, for the reports: + at the consignment store (it earned its margin on
 * rice the main store took), − at the main store (that margin is not its profit). Take-backs and undone shares count.
 */
export async function profitShareByLocation(db: Tx, storeId: string, range: { gte: Date; lt: Date }): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const rows = await db.storePayableEntry.findMany({ where: { storeId, createdAt: range, kind: { in: ["PROFIT_SHARE", "SHARE_BACK", "REVERSAL"] } }, select: { kind: true, locationId: true, amountMinor: true, sourceLocationId: true, reversesId: true } });
  const undoneIds = rows.flatMap((r) => (r.kind === "REVERSAL" && r.reversesId ? [r.reversesId] : []));
  const undone = new Map(undoneIds.length ? (await db.storePayableEntry.findMany({ where: { id: { in: undoneIds }, kind: "PROFIT_SHARE" }, select: { id: true, sourceLocationId: true } })).map((e) => [e.id, e.sourceLocationId]) : []);
  for (const r of rows) {
    if (r.kind === "REVERSAL" && !undone.has(r.reversesId ?? "")) continue;
    const main = r.kind === "REVERSAL" ? undone.get(r.reversesId ?? "") : r.sourceLocationId;
    out.set(r.locationId, (out.get(r.locationId) ?? 0) - r.amountMinor);
    if (main) out.set(main, (out.get(main) ?? 0) + r.amountMinor);
  }
  return out;
}

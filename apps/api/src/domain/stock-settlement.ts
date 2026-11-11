// Online-checkout RESERVATION SETTLEMENT.
//
// Online checkout does not move stock: it only raises `quantityReserved`
// (see prisma-repositories.createAtomic). The reserved units are still on the
// shelf, so the reservation has to be settled when the order leaves the
// pipeline:
//   * CONSUMED — fulfilment (DELIVERED / pickup COMPLETED): the units physically
//     left the store, so on-hand AND reserved both fall.
//   * RELEASED — cancellation (CANCELLED): the units never moved, so only
//     reserved falls and on-hand is untouched.
//
// POS and pre-order sales consume on-hand at sale time (deductStock) and carry
// no reservation, so settlement is a no-op for them.
//
// Why the Order.stockDisposition column is the guard: settlement may be reached
// twice for one order (retry, double click, two operators, a courier and the
// admin panel). A conditional `UPDATE ... WHERE "stockDisposition" IS NULL` makes
// exactly one caller win; every later or concurrent call updates 0 rows and
// returns without writing stock. The claim lives in the SAME transaction as the
// status change, so a failed settlement rolls the claim back and stays retryable.
//
// Movement ledger conventions (reconcile.ts depends on them):
//   RESERVE                reserved += qty, on-hand unchanged (delta is the reserved amount)
//   RELEASE_RESERVATION    reserved -= qty, on-hand unchanged (delta is the released amount)
//   CONSUME                on-hand -= qty (and reserved -= qty) — the on-hand ledger row
// Both reserved-only types are excluded from on-hand reconciliation.

import type { MovementTx } from "./movements.js";
import { InsufficientStockError, recordMovement } from "./movements.js";

export type StockDisposition = "CONSUMED" | "RELEASED";

export type SettlementOutcome = "applied" | "already-settled" | "no-reservation";

export interface SettlementResult {
  outcome: SettlementOutcome;
  /** Distinct stock rows touched. */
  lines: number;
  /** Total units settled. */
  quantity: number;
}

/** Movement types that move `quantityReserved` WITHOUT moving the on-hand balance. */
export const RESERVED_ONLY_MOVEMENT_TYPES = ["RESERVE", "RELEASE_RESERVATION"] as const;

export const SETTLEMENT_ACTOR = "reservation-settlement";

/** One stock row a checkout reservation is held on. */
export interface ReservationLeg {
  productId: string;
  variantId: string | null;
  warehouseId: string | null;
  quantity: number;
}

/**
 * The order statuses that settle a reservation. Everything else (dispatch,
 * failed delivery, retry) leaves the reservation in place on purpose.
 */
export function dispositionForOrderStatus(status: string): StockDisposition | null {
  if (status === "DELIVERED" || status === "COMPLETED") return "CONSUMED";
  if (status === "CANCELLED") return "RELEASED";
  return null;
}

/**
 * Replay the exact stock rows this order reserved, aggregated per row (a
 * reservation can span more than one warehouse level). Reads through the
 * caller's store scope, so another tenant's order has no visible legs.
 */
export async function reservationLegsForOrder(
  tx: MovementTx,
  storeId: string,
  orderId: string,
): Promise<ReservationLeg[]> {
  // An order edited in Orders gives back what it held (RELEASE_RESERVATION) and holds its new lines (RESERVE),
  // so what it still holds is RESERVE minus RELEASE_RESERVATION, per stock row.
  const moves = await tx.stockMovement.findMany({
    where: { storeId, orderId, type: { in: ["RESERVE", "RELEASE_RESERVATION"] } },
    select: { productId: true, variantId: true, warehouseId: true, delta: true, type: true },
  });
  const byRow = new Map<string, ReservationLeg>();
  for (const m of moves) {
    if (!m.productId || m.delta <= 0) continue;
    const key = `${m.productId}|${m.variantId ?? ""}|${m.warehouseId ?? ""}`;
    const leg = byRow.get(key) ?? { productId: m.productId, variantId: m.variantId, warehouseId: m.warehouseId, quantity: 0 };
    leg.quantity += m.type === "RESERVE" ? m.delta : -m.delta;
    byRow.set(key, leg);
  }
  return [...byRow.values()].filter((l) => l.quantity > 0);
}

/** True while an order still holds stock it reserved (online checkout, not yet settled). */
export async function hasActiveReservation(tx: MovementTx, storeId: string, orderId: string): Promise<boolean> {
  const legs = await reservationLegsForOrder(tx, storeId, orderId);
  return legs.length > 0;
}

async function findLevel(tx: MovementTx, storeId: string, productId: string, warehouseId: string | null) {
  const levels = await tx.stockLevel.findMany({ where: { storeId, productId }, select: { id: true, warehouseId: true } });
  return levels.find((l) => (l.warehouseId ?? null) === warehouseId) ?? null;
}

async function consumeLeg(tx: MovementTx, order: { id: string; storeId: string }, leg: ReservationLeg): Promise<void> {
  if (leg.variantId) {
    const changed = await tx.productVariant.updateMany({
      where: { id: leg.variantId, storeId: order.storeId, quantityOnHand: { gte: leg.quantity }, quantityReserved: { gte: leg.quantity } },
      data: { quantityOnHand: { decrement: leg.quantity }, quantityReserved: { decrement: leg.quantity } },
    });
    if (changed.count === 0) throw new InsufficientStockError(leg.productId, leg.quantity);
    const fresh = await tx.productVariant.findUnique({ where: { id: leg.variantId }, select: { quantityOnHand: true } });
    await recordMovement(tx, {
      storeId: order.storeId,
      productId: leg.productId,
      variantId: leg.variantId,
      delta: -leg.quantity,
      type: "CONSUME",
      orderId: order.id,
      createdBy: SETTLEMENT_ACTOR,
      note: "online order fulfilled — reservation consumed",
      balanceAfter: fresh?.quantityOnHand ?? null,
    });
    return;
  }
  const level = await findLevel(tx, order.storeId, leg.productId, leg.warehouseId);
  if (!level) return; // untracked product — same legacy no-op as deductStock
  const changed = await tx.stockLevel.updateMany({
    where: { id: level.id, quantityOnHand: { gte: leg.quantity }, quantityReserved: { gte: leg.quantity } },
    data: { quantityOnHand: { decrement: leg.quantity }, quantityReserved: { decrement: leg.quantity } },
  });
  if (changed.count === 0) throw new InsufficientStockError(leg.productId, leg.quantity);
  const fresh = await tx.stockLevel.findUnique({ where: { id: level.id }, select: { quantityOnHand: true } });
  await recordMovement(tx, {
    storeId: order.storeId,
    productId: leg.productId,
    warehouseId: leg.warehouseId,
    delta: -leg.quantity,
    type: "CONSUME",
    orderId: order.id,
    createdBy: SETTLEMENT_ACTOR,
    note: "online order fulfilled — reservation consumed",
    balanceAfter: fresh?.quantityOnHand ?? null,
  });
}

async function releaseLeg(tx: MovementTx, order: { id: string; storeId: string }, leg: ReservationLeg, note = "online order cancelled — reservation released", createdBy = SETTLEMENT_ACTOR): Promise<void> {
  if (leg.variantId) {
    const changed = await tx.productVariant.updateMany({
      where: { id: leg.variantId, storeId: order.storeId, quantityReserved: { gte: leg.quantity } },
      data: { quantityReserved: { decrement: leg.quantity } },
    });
    if (changed.count === 0) throw new InsufficientStockError(leg.productId, leg.quantity);
    const fresh = await tx.productVariant.findUnique({ where: { id: leg.variantId }, select: { quantityReserved: true } });
    await recordMovement(tx, {
      storeId: order.storeId,
      productId: leg.productId,
      variantId: leg.variantId,
      delta: leg.quantity,
      type: "RELEASE_RESERVATION",
      orderId: order.id,
      createdBy,
      note,
      balanceAfter: fresh?.quantityReserved ?? null,
    });
    return;
  }
  const level = await findLevel(tx, order.storeId, leg.productId, leg.warehouseId);
  if (!level) return; // untracked product — nothing was ever reserved
  const changed = await tx.stockLevel.updateMany({
    where: { id: level.id, quantityReserved: { gte: leg.quantity } },
    data: { quantityReserved: { decrement: leg.quantity } },
  });
  if (changed.count === 0) throw new InsufficientStockError(leg.productId, leg.quantity);
  const fresh = await tx.stockLevel.findUnique({ where: { id: level.id }, select: { quantityReserved: true } });
  await recordMovement(tx, {
    storeId: order.storeId,
    productId: leg.productId,
    warehouseId: leg.warehouseId,
    delta: leg.quantity,
    type: "RELEASE_RESERVATION",
    orderId: order.id,
    createdBy,
    note,
    balanceAfter: fresh?.quantityReserved ?? null,
  });
}

/**
 * Settle the stock an online order reserved at checkout. Call this INSIDE the
 * transaction that changes the order status so the claim, the counter writes and
 * the ledger legs commit or roll back together.
 *
 *   CONSUMED — fulfilment: on-hand and reserved both fall by the reserved quantity.
 *   RELEASED — cancellation: reserved falls; on-hand is untouched.
 */
export async function settleOrderReservations(
  tx: MovementTx,
  order: { id: string; storeId: string },
  disposition: StockDisposition,
): Promise<SettlementResult> {
  const legs = await reservationLegsForOrder(tx, order.storeId, order.id);
  if (legs.length === 0) {
    // A released reservation nets to nothing; it was still settled once, so say so.
    const done = await tx.order.findFirst({ where: { id: order.id, storeId: order.storeId, stockDisposition: { not: null } }, select: { id: true } });
    return { outcome: done ? "already-settled" : "no-reservation", lines: 0, quantity: 0 };
  }

  // Guarded claim: the first caller wins, everyone else is a no-op. Concurrent
  // callers serialise on this row lock instead of double-settling.
  const claimed = await tx.order.updateMany({
    where: { id: order.id, storeId: order.storeId, stockDisposition: null },
    data: { stockDisposition: disposition },
  });
  if (claimed.count === 0) return { outcome: "already-settled", lines: 0, quantity: 0 };

  for (const leg of legs) {
    if (disposition === "CONSUMED") await consumeLeg(tx, order, leg);
    else await releaseLeg(tx, order, leg);
  }
  return {
    outcome: "applied",
    lines: legs.length,
    quantity: legs.reduce((s, l) => s + l.quantity, 0),
  };
}

/** Settle whatever the target order status requires; no-op for in-flight statuses. */
export async function settleForStatus(
  tx: MovementTx,
  order: { id: string; storeId: string },
  toStatus: string,
): Promise<SettlementResult> {
  const disposition = dispositionForOrderStatus(toStatus);
  if (!disposition) return { outcome: "no-reservation", lines: 0, quantity: 0 };
  return settleOrderReservations(tx, order, disposition);
}

/**
 * Order edit (Orders → Change items) on an order that still HOLDS stock (online / SE Corp Hub checkout):
 * give back everything it holds, then hold the new lines, in the caller's transaction. The units never
 * moved, so only `quantityReserved` changes, and the ledger shows both legs against the order.
 * Throws InsufficientStockError when a new line cannot be held, so the whole edit rolls back.
 */
export async function moveOrderReservation(
  tx: MovementTx,
  order: { id: string; storeId: string },
  lines: { productId: string; quantity: number }[],
  actorId: string,
): Promise<void> {
  const old = await reservationLegsForOrder(tx, order.storeId, order.id);
  for (const leg of old) await releaseLeg(tx, order, leg, "order edited — old lines given back", actorId);
  // Hold the new lines where the order held them before when it can (same location), else anywhere with stock.
  const tracked = await tx.product.findMany({
    where: { storeId: order.storeId, id: { in: lines.map((l) => l.productId) }, trackStock: true },
    select: { id: true },
  });
  const isTracked = new Set(tracked.map((p) => p.id));
  for (const line of lines) {
    if (line.quantity <= 0 || !isTracked.has(line.productId)) continue; // Track stock off — nothing is held
    const levels = await tx.stockLevel.findMany({ where: { storeId: order.storeId, productId: line.productId } });
    if (levels.length === 0) continue;
    const before = old.find((l) => l.productId === line.productId && !l.variantId)?.warehouseId;
    levels.sort((a, b) => rank(a.warehouseId, before) - rank(b.warehouseId, before));
    let remaining = line.quantity;
    for (const lvl of levels) {
      if (remaining <= 0) break;
      const rows = await tx.$executeRawUnsafe(
        'UPDATE "StockLevel" SET "quantityReserved" = "quantityReserved" + $2 WHERE "id" = $1 AND ("quantityOnHand" - "quantityReserved") >= $2',
        lvl.id,
        remaining,
      );
      if (rows !== 1) continue;
      const fresh = await tx.stockLevel.findUnique({ where: { id: lvl.id }, select: { quantityReserved: true } });
      await recordMovement(tx, {
        storeId: order.storeId,
        productId: line.productId,
        warehouseId: lvl.warehouseId,
        delta: remaining,
        type: "RESERVE",
        orderId: order.id,
        createdBy: actorId,
        note: "order edited — new lines held",
        balanceAfter: fresh?.quantityReserved ?? null,
      });
      remaining = 0;
    }
    if (remaining > 0) throw new InsufficientStockError(line.productId, remaining);
  }
}

/** Where to hold first: the location the order used before, then any location, then the location-less row. */
function rank(warehouseId: string | null, before: string | null | undefined): number {
  if (before && warehouseId === before) return 0;
  return warehouseId ? 1 : 2;
}

// Stock movement LEDGER — append-only writes that accompany every StockLevel
// mutation. Balances on StockLevel are DERIVED facts; this table is the source
// for reconciliation (available = onHand - reserved; audit of who/when/why).
// Invariant: every stock-level change in the codebase goes through one of these
// helpers so the ledger can never silently diverge from the balances.

import type { Prisma } from "@prisma/client";
import { allocateRestore, pickDeductionLevel, type LevelView } from "./stock-location.js";

export type MovementTx = Prisma.TransactionClient;

export interface MovementInput {
  storeId: string;
  productId: string;
  /** P2b: variant-level movement (null = product-level). */
  variantId?: string | null;
  warehouseId?: string | null;
  delta: number;
  type: string; // RESERVE | RELEASE_RESERVATION | CONSUME | ADJUST | RECEIPT | TRANSFER_IN | TRANSFER_OUT | VOID_RESTORE | CONVERSION_IN | CONVERSION_OUT
  orderId?: string | null;
  conversionId?: string | null;
  createdBy?: string | null;
  note?: string | null;
  balanceAfter?: number | null;
  /** Rice Ops M1: the document behind the move (TRANSFER, SALE, ORDER_EDIT, VOID, ADJUST, …). */
  documentType?: string | null;
  /** Rice Ops M1: that document's id — every ledger row traces back to it. */
  documentId?: string | null;
}

/** Append a movement to the ledger (inside an existing transaction). */
export async function recordMovement(tx: MovementTx, m: MovementInput): Promise<void> {
  await tx.stockMovement.create({
    data: {
      storeId: m.storeId,
      productId: m.productId,
      variantId: m.variantId ?? null,
      warehouseId: m.warehouseId ?? null,
      delta: m.delta,
      type: m.type,
      orderId: m.orderId ?? null,
      conversionId: m.conversionId ?? null,
      createdBy: m.createdBy ?? null,
      note: m.note ?? null,
      balanceAfter: m.balanceAfter ?? null,
      documentType: m.documentType ?? (m.orderId ? "ORDER" : null),
      documentId: m.documentId ?? m.orderId ?? null,
    },
  });
}

/** Movement types that move `quantityReserved` only (mirrors stock-settlement.ts). */
const RESERVED_ONLY_TYPES = ["RESERVE", "RELEASE_RESERVATION"];

/** The store's default location id (null for a store that predates locations). */
export async function defaultLocationId(tx: MovementTx, storeId: string): Promise<string | null> {
  const def = await tx.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } });
  return def?.id ?? null;
}

/**
 * Rice Ops M1: the store's default location, creating one when the store has
 * none — so no new stock row is ever written without a location. A store with
 * locations but no default promotes its oldest.
 */
export async function ensureDefaultLocation(tx: MovementTx, storeId: string): Promise<string> {
  const def = await defaultLocationId(tx, storeId);
  if (def) return def;
  const oldest = await tx.warehouse.findFirst({ where: { storeId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (oldest) {
    await tx.warehouse.update({ where: { id: oldest.id }, data: { isDefault: true } });
    return oldest.id;
  }
  const created = await tx.warehouse.upsert({
    where: { storeId_name: { storeId, name: "Main" } },
    create: { storeId, name: "Main", isDefault: true },
    update: { isDefault: true },
    select: { id: true },
  });
  return created.id;
}

/**
 * Guarded decrement against AVAILABLE stock (on hand − reserved), in ONE statement:
 * a concurrent sale or reservation can never push the row below what is promised.
 * Returns the new on-hand balance, or null when the guard missed.
 */
async function takeAvailable(tx: MovementTx, levelId: string, take: number): Promise<number | null> {
  const rows = await tx.$queryRaw<{ quantityOnHand: number }[]>`
    UPDATE "StockLevel"
    SET "quantityOnHand" = "quantityOnHand" - ${take}::int, "updatedAt" = now()
    WHERE id = ${levelId} AND "quantityOnHand" - "quantityReserved" >= ${take}::int
    RETURNING "quantityOnHand"`;
  return rows[0]?.quantityOnHand ?? null;
}

/**
 * Thrown when a guarded stock write cannot be satisfied (Module 4 fix): the level
 * dropped below the requested quantity between the read and the write. Callers
 * surface this as a conflict, never as a negative balance.
 */
export class InsufficientStockError extends Error {
  constructor(
    public readonly productId: string,
    public readonly shortfall: number,
    /** Rice Ops M1: available units at OTHER locations — so the screen can offer "kunin sa …". */
    public readonly elsewhere = 0,
  ) {
    super(`insufficient stock for product ${productId} (short by ${shortfall})`);
    this.name = "InsufficientStockError";
  }
}

/**
 * Decrement stock for sale/edit lines, recording one ledger row per line.
 * Used by POS sells/holds/preorders and admin item edits.
 *
 * Rice Ops M1 rules (see stock-location.ts):
 *   * ONE location per line — `opts.warehouseId`, else the store's default
 *     location (legacy: the location-less row). Never spread over other stores.
 *   * Guarded against AVAILABLE (on hand − reserved) in a single statement, so a
 *     concurrent sale or a reservation can never be oversold.
 *   * A shortfall is an explicit InsufficientStockError carrying what is
 *     available elsewhere. Products with NO stock rows are untracked (legacy no-op).
 */
export async function deductStock(
  tx: MovementTx,
  storeId: string,
  lines: { productId: string; variantId?: string | null; quantity: number }[],
  opts?: { type?: string; orderId?: string | null; createdBy?: string | null; warehouseId?: string | null; documentType?: string | null; documentId?: string | null },
): Promise<void> {
  const type = opts?.type ?? "CONSUME";
  let defaultId: string | null | undefined;
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    // P2b: VARIANT lines decrement the variant's own counter (guarded the same way).
    if (l.variantId) {
      const take = l.quantity;
      const changed = await tx.productVariant.updateMany({
        where: { id: l.variantId, storeId, quantityOnHand: { gte: take } },
        data: { quantityOnHand: { decrement: take } },
      });
      if (changed.count === 0) {
        throw new InsufficientStockError(l.productId, take);
      }
      const fresh = await tx.productVariant.findUnique({ where: { id: l.variantId }, select: { quantityOnHand: true } });
      await recordMovement(tx, {
        storeId,
        productId: l.productId,
        variantId: l.variantId,
        delta: -take,
        type,
        orderId: opts?.orderId,
        createdBy: opts?.createdBy,
        balanceAfter: fresh?.quantityOnHand ?? null,
        documentType: opts?.documentType,
        documentId: opts?.documentId,
      });
      continue;
    }
    const levels: LevelView[] = await tx.stockLevel.findMany({
      where: { storeId, productId: l.productId },
      select: { id: true, warehouseId: true, quantityOnHand: true, quantityReserved: true },
    });
    if (defaultId === undefined) defaultId = await defaultLocationId(tx, storeId);
    const pick = pickDeductionLevel(levels, l.quantity, { warehouseId: opts?.warehouseId ?? null, defaultWarehouseId: defaultId });
    if (!pick.ok) {
      if (pick.reason === "untracked") continue; // untracked product — no stock accounting
      const available = pick.reason === "short" ? pick.available : 0;
      throw new InsufficientStockError(l.productId, l.quantity - available, pick.elsewhere);
    }
    const balanceAfter = await takeAvailable(tx, pick.level.id, l.quantity);
    if (balanceAfter === null) {
      // The row changed between the read and the guarded write (a concurrent sale).
      const fresh = await tx.stockLevel.findUnique({ where: { id: pick.level.id }, select: { quantityOnHand: true, quantityReserved: true } });
      const available = Math.max(0, (fresh?.quantityOnHand ?? 0) - (fresh?.quantityReserved ?? 0));
      throw new InsufficientStockError(l.productId, l.quantity - available);
    }
    await recordMovement(tx, {
      storeId,
      productId: l.productId,
      warehouseId: pick.level.warehouseId,
      delta: -l.quantity,
      type,
      orderId: opts?.orderId,
      createdBy: opts?.createdBy,
      balanceAfter,
      documentType: opts?.documentType,
      documentId: opts?.documentId,
    });
  }
}

/**
 * M2 — a first-class, actor-attributed stock adjustment.
 *
 * Mirrors the conventions of the other ledger writers: the level is the derived fact, the
 * movement is the source of truth, and a negative result is refused unless the caller
 * explicitly allows it (a manager's stock-take correction). `delta` adds/removes;
 * `setTo` records a counted absolute quantity (the movement carries the difference).
 */
export async function adjustStock(
  tx: MovementTx,
  input: {
    storeId: string;
    productId: string;
    warehouseId?: string | null;
    /** Signed change (+add / −remove). Mutually exclusive with `setTo`. */
    delta?: number;
    /** Absolute counted quantity (stock-take). Mutually exclusive with `delta`. */
    setTo?: number;
    /** Why — stored on the movement's note (the ledger has no separate reason column). */
    reason: string;
    actorId: string;
    /** Allow the balance to go negative (manager stock-take only). */
    allowNegative?: boolean;
    /** Rice Ops M1: the document behind the adjustment (e.g. COUNT + its id). */
    documentType?: string | null;
    documentId?: string | null;
  },
): Promise<{ levelId: string; balanceAfter: number; delta: number }> {
  const { storeId, productId, actorId, reason } = input;
  if ((input.delta === undefined) === (input.setTo === undefined)) {
    throw new Error("adjustStock needs exactly one of delta or setTo");
  }
  if (input.delta !== undefined && (!Number.isInteger(input.delta) || input.delta === 0)) {
    throw new Error("delta must be a non-zero integer");
  }
  if (input.setTo !== undefined && (!Number.isInteger(input.setTo) || input.setTo < 0)) {
    throw new Error("setTo must be a non-negative integer");
  }

  // Resolve the level: the requested warehouse, else the store's default, else the first row.
  let level = input.warehouseId
    ? await tx.stockLevel.findFirst({ where: { storeId, productId, warehouseId: input.warehouseId } })
    : await tx.stockLevel.findFirst({
        where: { storeId, productId, warehouse: { isDefault: true } },
      });
  // Legacy: a location-less row, only when no location was asked for.
  if (!level && !input.warehouseId) level = await tx.stockLevel.findFirst({ where: { storeId, productId, warehouseId: null } });
  if (!level) {
    // Rice Ops M1: a new row goes to the asked location, else the default location.
    // (A store that predates locations keeps the legacy location-less row until the
    // M1 migration / setup-locations script gives it one.)
    const warehouseId = input.warehouseId ?? (await defaultLocationId(tx, storeId));
    level = await tx.stockLevel.create({
      data: { storeId, productId, warehouseId, quantityOnHand: 0, quantityReserved: 0 },
    });
  }

  const delta = input.setTo !== undefined ? input.setTo - level.quantityOnHand : (input.delta as number);
  if (delta === 0) {
    return { levelId: level.id, balanceAfter: level.quantityOnHand, delta: 0 };
  }
  const next = level.quantityOnHand + delta;
  if (next < 0 && !input.allowNegative) {
    throw new InsufficientStockError(productId, -next);
  }

  // Guarded single-statement write; a concurrent change is re-read and re-applied once.
  const changed = await tx.stockLevel.updateMany({
    where: { id: level.id, quantityOnHand: level.quantityOnHand },
    data: { quantityOnHand: next },
  });
  let balanceAfter = next;
  if (changed.count === 0) {
    const fresh = await tx.stockLevel.findUnique({ where: { id: level.id }, select: { quantityOnHand: true } });
    const retryFrom = fresh?.quantityOnHand ?? 0;
    const retryTo = input.setTo !== undefined ? input.setTo : retryFrom + delta;
    if (retryTo < 0 && !input.allowNegative) throw new InsufficientStockError(productId, -retryTo);
    await tx.stockLevel.update({ where: { id: level.id }, data: { quantityOnHand: retryTo } });
    balanceAfter = retryTo;
  }

  await recordMovement(tx, {
    storeId,
    productId,
    warehouseId: level.warehouseId,
    delta: balanceAfter - level.quantityOnHand, // the change actually applied
    type: "ADJUST",
    createdBy: actorId,
    note: reason,
    balanceAfter,
    documentType: input.documentType ?? "ADJUST",
    documentId: input.documentId ?? null,
  });
  return { levelId: level.id, balanceAfter, delta: balanceAfter - level.quantityOnHand };
}

/**
 * Restore stock for lines (void/cancel/edit-revert), recording ledger rows.
 *
 * Rice Ops M1: stock goes back to the location it was TAKEN from, read from the
 * order's own ledger rows (allocateRestore). Without an order (or beyond what the
 * ledger shows) it goes to `opts.warehouseId`, else the default location. A
 * product with no stock row at all stays untracked (legacy no-op).
 */
export async function restoreStock(
  tx: MovementTx,
  storeId: string,
  lines: { productId: string; variantId?: string | null; quantity: number }[],
  opts?: { type?: string; orderId?: string | null; createdBy?: string | null; warehouseId?: string | null; documentType?: string | null; documentId?: string | null },
): Promise<void> {
  const type = opts?.type ?? "RELEASE";
  let fallbackId: string | null | undefined;
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    // P2b: variant lines restore the variant's counter.
    if (l.variantId) {
      const updated = await tx.productVariant.update({
        where: { id: l.variantId },
        data: { quantityOnHand: { increment: l.quantity } },
      });
      await recordMovement(tx, {
        storeId,
        productId: l.productId,
        variantId: l.variantId,
        delta: l.quantity,
        type,
        orderId: opts?.orderId,
        createdBy: opts?.createdBy,
        balanceAfter: updated.quantityOnHand,
        documentType: opts?.documentType,
        documentId: opts?.documentId,
      });
      continue;
    }
    const levels = await tx.stockLevel.findMany({ where: { storeId, productId: l.productId }, select: { id: true, warehouseId: true } });
    if (levels.length === 0) continue; // untracked product
    if (fallbackId === undefined) fallbackId = opts?.warehouseId ?? (await defaultLocationId(tx, storeId));
    const taken = opts?.orderId
      ? await tx.stockMovement.findMany({
          where: { storeId, orderId: opts.orderId, productId: l.productId, variantId: null, type: { notIn: RESERVED_ONLY_TYPES } },
          orderBy: { createdAt: "asc" },
          select: { productId: true, warehouseId: true, delta: true },
        })
      : [];
    for (const part of allocateRestore(taken, l.productId, l.quantity, fallbackId)) {
      let level = levels.find((x) => (x.warehouseId ?? null) === part.warehouseId) ?? null;
      if (!level && part.warehouseId) {
        // The stock came from a location that no longer has a row for it: recreate the row there.
        level = await tx.stockLevel.upsert({
          where: { storeId_productId_warehouseId: { storeId, productId: l.productId, warehouseId: part.warehouseId } },
          create: { storeId, productId: l.productId, warehouseId: part.warehouseId, quantityOnHand: 0, quantityReserved: 0 },
          update: {},
          select: { id: true, warehouseId: true },
        });
        levels.push(level);
      }
      if (!level) level = levels[0] ?? null; // legacy store without locations
      if (!level) continue;
      const updated = await tx.stockLevel.update({
        where: { id: level.id },
        data: { quantityOnHand: { increment: part.quantity } },
      });
      await recordMovement(tx, {
        storeId,
        productId: l.productId,
        warehouseId: level.warehouseId,
        delta: part.quantity,
        type,
        orderId: opts?.orderId,
        createdBy: opts?.createdBy,
        balanceAfter: updated.quantityOnHand,
        documentType: opts?.documentType,
        documentId: opts?.documentId,
      });
    }
  }
}

/**
 * Rice Ops M1 — move stock between two locations in ONE transaction: the only
 * writer for transfers (and, from M3, releases). The source is decremented
 * against AVAILABLE stock with a single guarded statement — a transfer can never
 * create rice the source does not have, nor push the source below what is
 * reserved. The destination row is upserted on its (store, product, location)
 * key. Both ledger rows carry the actor and the document.
 */
export async function transferStock(
  tx: MovementTx,
  input: {
    storeId: string;
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantity: number;
    actorId: string | null;
    documentType: string;
    documentId: string;
    note?: string | null;
  },
): Promise<{ fromBalance: number; toBalance: number }> {
  const { storeId, productId, fromWarehouseId, toWarehouseId, quantity } = input;
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("transfer quantity must be a positive whole number");
  if (fromWarehouseId === toWarehouseId) throw new Error("transfer source and destination must differ");

  const source = await tx.stockLevel.findFirst({ where: { storeId, productId, warehouseId: fromWarehouseId }, select: { id: true } });
  if (!source) throw new InsufficientStockError(productId, quantity);
  const fromBalance = await takeAvailable(tx, source.id, quantity);
  if (fromBalance === null) {
    const fresh = await tx.stockLevel.findUnique({ where: { id: source.id }, select: { quantityOnHand: true, quantityReserved: true } });
    throw new InsufficientStockError(productId, quantity - Math.max(0, (fresh?.quantityOnHand ?? 0) - (fresh?.quantityReserved ?? 0)));
  }
  const dest = await tx.stockLevel.upsert({
    where: { storeId_productId_warehouseId: { storeId, productId, warehouseId: toWarehouseId } },
    create: { storeId, productId, warehouseId: toWarehouseId, quantityOnHand: quantity, quantityReserved: 0 },
    update: { quantityOnHand: { increment: quantity } },
    select: { quantityOnHand: true },
  });
  const common = { storeId, productId, orderId: null, createdBy: input.actorId, note: input.note ?? null, documentType: input.documentType, documentId: input.documentId };
  await recordMovement(tx, { ...common, warehouseId: fromWarehouseId, delta: -quantity, type: "TRANSFER_OUT", balanceAfter: fromBalance });
  await recordMovement(tx, { ...common, warehouseId: toWarehouseId, delta: quantity, type: "TRANSFER_IN", balanceAfter: dest.quantityOnHand });
  return { fromBalance, toBalance: dest.quantityOnHand };
}

// ─────────────────────────── Rice Ops M3: trips between locations ───────────────────────────
//
// A trip holds stock at the source from approval (RESERVE), takes it out when it is
// signed out (RELEASE_OUT, and the hold is dropped in the same statement), and adds it
// where it is counted in (RECEIVE_IN at the destination, RETURN_IN back at the source).
// Every write is one guarded UPDATE, so no trip can create rice or push a row negative.
// Movements carry the trip as their document (never orderId — order reservations are
// settled by stock-settlement.ts, which must not see these).

export interface TripLeg {
  storeId: string;
  productId: string;
  warehouseId: string;
  actorId: string | null;
  documentType: string;
  documentId: string;
  note?: string | null;
}

async function levelFor(tx: MovementTx, leg: TripLeg) {
  return tx.stockLevel.findFirst({ where: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId }, select: { id: true } });
}

/** Hold `qty` of AVAILABLE stock at a location for a trip. Throws InsufficientStockError. */
export async function reserveForTrip(tx: MovementTx, leg: TripLeg, qty: number): Promise<number> {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("reserve quantity must be a positive whole number");
  const level = await levelFor(tx, leg);
  if (!level) throw new InsufficientStockError(leg.productId, qty);
  const rows = await tx.$queryRaw<{ quantityReserved: number }[]>`
    UPDATE "StockLevel" SET "quantityReserved" = "quantityReserved" + ${qty}::int, "updatedAt" = now()
     WHERE id = ${level.id} AND "quantityOnHand" - "quantityReserved" >= ${qty}::int
    RETURNING "quantityReserved"`;
  if (!rows[0]) {
    const fresh = await tx.stockLevel.findUnique({ where: { id: level.id }, select: { quantityOnHand: true, quantityReserved: true } });
    throw new InsufficientStockError(leg.productId, qty - Math.max(0, (fresh?.quantityOnHand ?? 0) - (fresh?.quantityReserved ?? 0)));
  }
  await recordMovement(tx, { ...leg, orderId: null, createdBy: leg.actorId, delta: qty, type: "RESERVE", balanceAfter: rows[0].quantityReserved });
  return rows[0].quantityReserved;
}

/** Drop a trip's hold (cancel). Never below zero. */
export async function unreserveForTrip(tx: MovementTx, leg: TripLeg, qty: number): Promise<void> {
  if (qty <= 0) return;
  const level = await levelFor(tx, leg);
  if (!level) return;
  const rows = await tx.$queryRaw<{ quantityReserved: number }[]>`
    UPDATE "StockLevel" SET "quantityReserved" = GREATEST(0, "quantityReserved" - ${qty}::int), "updatedAt" = now()
     WHERE id = ${level.id}
    RETURNING "quantityReserved"`;
  await recordMovement(tx, { ...leg, orderId: null, createdBy: leg.actorId, delta: qty, type: "RELEASE_RESERVATION", balanceAfter: rows[0]?.quantityReserved ?? null });
}

/**
 * Ilabas: drop the trip's hold and take `releaseQty` off the shelf in ONE statement.
 * The released units must be covered by the hold plus what else is available.
 */
export async function releaseForTrip(tx: MovementTx, leg: TripLeg, heldQty: number, releaseQty: number, type: "RELEASE_OUT" | "RESACK_OUT" | "CONSUME" | "WRITE_OFF" = "RELEASE_OUT"): Promise<number> {
  if (!Number.isInteger(releaseQty) || releaseQty <= 0) throw new Error("release quantity must be a positive whole number");
  const level = await levelFor(tx, leg);
  if (!level) throw new InsufficientStockError(leg.productId, releaseQty);
  const rows = await tx.$queryRaw<{ quantityOnHand: number; quantityReserved: number }[]>`
    UPDATE "StockLevel"
       SET "quantityReserved" = "quantityReserved" - ${heldQty}::int,
           "quantityOnHand"   = "quantityOnHand" - ${releaseQty}::int,
           "updatedAt" = now()
     WHERE id = ${level.id}
       AND "quantityReserved" >= ${heldQty}::int
       AND "quantityOnHand" - ("quantityReserved" - ${heldQty}::int) >= ${releaseQty}::int
    RETURNING "quantityOnHand", "quantityReserved"`;
  if (!rows[0]) {
    const fresh = await tx.stockLevel.findUnique({ where: { id: level.id }, select: { quantityOnHand: true, quantityReserved: true } });
    const avail = (fresh?.quantityOnHand ?? 0) - Math.max(0, (fresh?.quantityReserved ?? 0) - heldQty);
    throw new InsufficientStockError(leg.productId, releaseQty - Math.max(0, avail));
  }
  if (heldQty > 0) {
    await recordMovement(tx, { ...leg, orderId: null, createdBy: leg.actorId, delta: heldQty, type: "RELEASE_RESERVATION", balanceAfter: rows[0].quantityReserved });
  }
  await recordMovement(tx, { ...leg, orderId: null, createdBy: leg.actorId, delta: -releaseQty, type, balanceAfter: rows[0].quantityOnHand });
  return rows[0].quantityOnHand;
}

/** Tanggapin / Tanggapin pabalik / Ibinalik: add counted stock at a location (row created if new). */
export async function addForTrip(tx: MovementTx, leg: TripLeg, qty: number, type: "RECEIVE_IN" | "RETURN_IN" | "RESACK_IN" | "RESACK_RETURN" | "STOCK_IN" | "MERGE_IN" | "COUNT_ADJUST_IN"): Promise<number> {
  if (!Number.isInteger(qty) || qty < 0) throw new Error("quantity must be a whole number ≥ 0");
  if (qty === 0) return 0;
  const row = await tx.stockLevel.upsert({
    where: { storeId_productId_warehouseId: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId } },
    create: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId, quantityOnHand: qty, quantityReserved: 0 },
    update: { quantityOnHand: { increment: qty } },
    select: { quantityOnHand: true },
  });
  await recordMovement(tx, { ...leg, orderId: null, createdBy: leg.actorId, delta: qty, type, balanceAfter: row.quantityOnHand });
  return row.quantityOnHand;
}

/**
 * Rice Ops M8: post a count's difference (COUNT_ADJUST) in ONE guarded statement. A kulang
 * can never take the shelf below what is held for orders/trips; a sobra creates the row
 * when the location had none. Returns the new on-hand balance (0 when nothing was posted).
 */
export async function adjustForCount(tx: MovementTx, leg: TripLeg, delta: number): Promise<number> {
  if (!Number.isInteger(delta)) throw new Error("count adjustment must be a whole number");
  if (delta === 0) return 0; // Tama — nothing to post
  if (delta > 0) {
    const row = await tx.stockLevel.upsert({
      where: { storeId_productId_warehouseId: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId } },
      create: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId, quantityOnHand: delta, quantityReserved: 0 },
      update: { quantityOnHand: { increment: delta } },
      select: { quantityOnHand: true },
    });
    await recordMovement(tx, { ...leg, orderId: null, createdBy: leg.actorId, delta, type: "COUNT_ADJUST", balanceAfter: row.quantityOnHand });
    return row.quantityOnHand;
  }
  const level = await levelFor(tx, leg);
  if (!level) throw new InsufficientStockError(leg.productId, -delta);
  const rows = await tx.$queryRaw<{ quantityOnHand: number }[]>`
    UPDATE "StockLevel" SET "quantityOnHand" = "quantityOnHand" + ${delta}::int, "updatedAt" = now()
     WHERE id = ${level.id} AND "quantityOnHand" + ${delta}::int >= "quantityReserved"
    RETURNING "quantityOnHand"`;
  if (!rows[0]) {
    const fresh = await tx.stockLevel.findUnique({ where: { id: level.id }, select: { quantityOnHand: true, quantityReserved: true } });
    throw new InsufficientStockError(leg.productId, Math.max(0, (fresh?.quantityReserved ?? 0) - ((fresh?.quantityOnHand ?? 0) + delta)));
  }
  await recordMovement(tx, { ...leg, orderId: null, createdBy: leg.actorId, delta, type: "COUNT_ADJUST", balanceAfter: rows[0].quantityOnHand });
  return rows[0].quantityOnHand;
}

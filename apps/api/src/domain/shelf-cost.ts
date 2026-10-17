// Cost per location. The store chooses one of two ways to count cost:
//   SHARED        one cost per product, the same at every location (how it always worked)
//   PER_LOCATION  each location's shelf has its own cost, blended as stock arrives
// A shelf with no cost of its own uses the product cost, so nothing jumps when this is switched on.

import type { Prisma } from "@prisma/client";

export type CostMode = "SHARED" | "PER_LOCATION";

export function parseCostMode(v: string | null | undefined): CostMode {
  return v === "PER_LOCATION" ? "PER_LOCATION" : "SHARED";
}

/** Weighted average of what is on the shelf and what arrives, rounded to the centavo. */
export function blendedCost(oldQty: number, oldCostMinor: number, inQty: number, inCostMinor: number): number {
  const q = Math.max(0, oldQty) + inQty;
  if (inQty <= 0) return oldCostMinor;
  if (q <= 0) return inCostMinor;
  const value = BigInt(Math.max(0, oldQty)) * BigInt(oldCostMinor) + BigInt(inQty) * BigInt(inCostMinor);
  const qb = BigInt(q);
  return Number((value + qb / 2n) / qb);
}

/** The cost to use for one shelf: its own when the store counts per location, else the product cost. */
export function effectiveCost(mode: CostMode, shelfCostMinor: number | null | undefined, productCostMinor: number): number {
  if (mode === "PER_LOCATION" && typeof shelfCostMinor === "number") return shelfCostMinor;
  return productCostMinor;
}

type Db = Prisma.TransactionClient;

export async function costModeOf(db: Db, storeId: string): Promise<CostMode> {
  const s = await db.storeSettings.findUnique({ where: { storeId }, select: { costMode: true } });
  return parseCostMode(s?.costMode);
}

/** The cost of the stock on one location's shelf right now. */
export async function shelfCostFor(db: Db, storeId: string, productId: string, warehouseId: string | null | undefined): Promise<number> {
  const product = await db.product.findUnique({ where: { id: productId }, select: { costMinor: true } });
  const productCost = product?.costMinor ?? 0;
  if (!warehouseId) return productCost;
  const mode = await costModeOf(db, storeId);
  if (mode !== "PER_LOCATION") return productCost;
  const level = await db.stockLevel.findUnique({
    where: { storeId_productId_warehouseId: { storeId, productId, warehouseId } },
    select: { costMinor: true },
  });
  return effectiveCost(mode, level?.costMinor, productCost);
}

/**
 * Call BEFORE the stock is added. When the store counts per location, blends the incoming cost
 * into that shelf's cost. Does nothing in SHARED mode or when the incoming cost is unknown.
 */
export async function recordCostIn(
  db: Db,
  leg: { storeId: string; productId: string; warehouseId: string },
  qtyIn: number,
  unitCostMinor: number | null | undefined,
): Promise<void> {
  if (!unitCostMinor || unitCostMinor <= 0 || qtyIn <= 0) return;
  const mode = await costModeOf(db, leg.storeId);
  if (mode !== "PER_LOCATION") return;
  const [product, level] = await Promise.all([
    db.product.findUnique({ where: { id: leg.productId }, select: { costMinor: true } }),
    db.stockLevel.findUnique({
      where: { storeId_productId_warehouseId: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId } },
      select: { quantityOnHand: true, costMinor: true },
    }),
  ]);
  const oldQty = level?.quantityOnHand ?? 0;
  const oldCost = effectiveCost(mode, level?.costMinor, product?.costMinor ?? 0);
  const next = blendedCost(oldQty, oldCost, qtyIn, unitCostMinor);
  await db.stockLevel.upsert({
    where: { storeId_productId_warehouseId: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId } },
    create: { storeId: leg.storeId, productId: leg.productId, warehouseId: leg.warehouseId, quantityOnHand: 0, quantityReserved: 0, costMinor: next },
    update: { costMinor: next },
  });
}

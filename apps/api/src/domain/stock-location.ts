// Rice Ops M1 — which location a stock move uses. Pure functions (no DB) so the
// rules are unit-tested on their own and every writer applies the same ones.
//
// Rules:
//   1. A deduction takes stock from ONE location: the one asked for, else the
//      store's default location, else (legacy data only) the location-less row.
//      It never silently spreads a sale across other stores' shelves — taking
//      Store 2's rice is an explicit choice (a release), not a fallback.
//   2. "Enough stock" means AVAILABLE = on hand − reserved. Rice promised to an
//      approved order is not sold twice.
//   3. A restore (void, cancel, item edit) puts stock back where it came from,
//      read from the order's own ledger rows — not into whichever row is first.

export interface LevelView {
  id: string;
  warehouseId: string | null;
  quantityOnHand: number;
  quantityReserved: number;
}

export type PickResult =
  | { ok: true; level: LevelView }
  | { ok: false; reason: "untracked" }
  | { ok: false; reason: "no-stock-here"; elsewhere: number }
  | { ok: false; reason: "short"; available: number; elsewhere: number };

export function availableOf(level: Pick<LevelView, "quantityOnHand" | "quantityReserved">): number {
  return level.quantityOnHand - level.quantityReserved;
}

/**
 * Choose the single stock row a deduction of `quantity` uses.
 * `levels` = every row of the product in this store (any location).
 */
export function pickDeductionLevel(
  levels: LevelView[],
  quantity: number,
  opts: { warehouseId?: string | null; defaultWarehouseId?: string | null },
): PickResult {
  if (levels.length === 0) return { ok: false, reason: "untracked" };
  const targetId = opts.warehouseId ?? opts.defaultWarehouseId ?? null;
  let level = levels.find((l) => (l.warehouseId ?? null) === targetId) ?? null;
  // Legacy: a store whose stock predates locations keeps a location-less row.
  if (!level && !opts.warehouseId) level = levels.find((l) => l.warehouseId === null) ?? null;
  const elsewhere = levels
    .filter((l) => l !== level)
    .reduce((sum, l) => sum + Math.max(0, availableOf(l)), 0);
  if (!level) return { ok: false, reason: "no-stock-here", elsewhere };
  const available = availableOf(level);
  if (available < quantity) return { ok: false, reason: "short", available: Math.max(0, available), elsewhere };
  return { ok: true, level };
}

/** One ledger row of an order's earlier deduction (negative delta = stock taken). */
export interface TakenMovement {
  productId: string;
  warehouseId: string | null;
  delta: number;
}

/**
 * Split a restore of `quantity` units of a product back over the locations the
 * order took it from (most recent take first is not knowable from sums, so we
 * return to locations in the order they were first taken from). Anything beyond
 * what the ledger shows was taken goes to `fallbackWarehouseId`.
 */
export function allocateRestore(
  taken: TakenMovement[],
  productId: string,
  quantity: number,
  fallbackWarehouseId: string | null,
): { warehouseId: string | null; quantity: number }[] {
  if (!Number.isInteger(quantity) || quantity <= 0) return [];
  const net = new Map<string | null, number>();
  for (const m of taken) {
    if (m.productId !== productId) continue;
    // Taken = −delta; earlier restores (+delta) reduce what can still go back.
    net.set(m.warehouseId ?? null, (net.get(m.warehouseId ?? null) ?? 0) - m.delta);
  }
  const out: { warehouseId: string | null; quantity: number }[] = [];
  let remaining = quantity;
  for (const [warehouseId, stillTaken] of net) {
    if (remaining <= 0) break;
    if (stillTaken <= 0) continue;
    const give = Math.min(stillTaken, remaining);
    out.push({ warehouseId, quantity: give });
    remaining -= give;
  }
  if (remaining > 0) {
    const same = out.find((o) => o.warehouseId === fallbackWarehouseId);
    if (same) same.quantity += remaining;
    else out.push({ warehouseId: fallbackWarehouseId, quantity: remaining });
  }
  return out;
}

/** A location's selling price for a product: its own price if set, else the main price. */
export function effectivePrice(mainPriceMinor: number, locationPriceMinor: number | null | undefined): number {
  return locationPriceMinor ?? mainPriceMinor;
}

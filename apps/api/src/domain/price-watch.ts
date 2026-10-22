// Supplier price watch: pure helpers.
// What did this supplier charge last time for this item, and is today's cost higher or lower?

export interface CostRow {
  supplierId: string;
  productId: string;
  unitCostMinor: number;
  /** When the order was made (ms since 1970). */
  at: number;
}

export type MoveKind = "NEW" | "SAME" | "UP" | "DOWN";

export interface PriceMove {
  kind: MoveKind;
  /** Cost last time, if there was one. */
  lastMinor: number | null;
  /** New minus last (centavos). 0 when there was no last cost. */
  changeMinor: number;
  /** Change as a percent of the last cost, one decimal. 0 when there was no last cost. */
  pct: number;
  /** A move of 5% or more either way deserves a second look. */
  big: boolean;
}

export const BIG_MOVE_PCT = 5;

/** Compare a cost with the last one from the same supplier. */
export function priceMove(lastMinor: number | null | undefined, nowMinor: number): PriceMove {
  if (lastMinor === null || lastMinor === undefined || lastMinor <= 0) return { kind: "NEW", lastMinor: null, changeMinor: 0, pct: 0, big: false };
  const changeMinor = nowMinor - lastMinor;
  if (changeMinor === 0) return { kind: "SAME", lastMinor, changeMinor: 0, pct: 0, big: false };
  const pct = Math.round((changeMinor / lastMinor) * 1000) / 10;
  return { kind: changeMinor > 0 ? "UP" : "DOWN", lastMinor, changeMinor, pct, big: Math.abs(changeMinor) * 100 >= BIG_MOVE_PCT * lastMinor };
}

/** The newest row for each product from one supplier. `before` (ms) ignores rows made at or after that time. */
export function lastCostByProduct(rows: CostRow[], supplierId: string, before?: number): Map<string, CostRow> {
  const out = new Map<string, CostRow>();
  for (const r of rows) {
    if (r.supplierId !== supplierId) continue;
    if (before !== undefined && r.at >= before) continue;
    const cur = out.get(r.productId);
    if (!cur || r.at > cur.at) out.set(r.productId, r);
  }
  return out;
}

/** The newest earlier cost for one supplier and item (null when this is the first time). */
export function previousCost(rows: CostRow[], supplierId: string, productId: string, before: number): number | null {
  let best: CostRow | null = null;
  for (const r of rows) {
    if (r.supplierId !== supplierId || r.productId !== productId || r.at >= before) continue;
    if (!best || r.at > best.at) best = r;
  }
  return best ? best.unitCostMinor : null;
}

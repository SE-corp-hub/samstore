// Stock movement summary: pure helper (no DB).
// For every item at one place (or all places), over some days: what was there at the start, what came in and went
// out and why, and what is there at the end.
//
// The end is the stock now minus everything that moved after the period; the start is the end minus the period's moves,
// so Start + all the columns = End always holds. (Stock check says where the shelf and the ledger part ways.)

import { bucketOf, type Bucket } from "./stock-book.js";

export interface MoveGroup {
  productId: string;
  type: string;
  documentType: string | null;
  /** Sum of the signed changes in the group. */
  delta: number;
}

export interface SummaryProduct {
  id: string;
  name: string;
  loose: boolean;
  /** Grams in one stock unit (1 for loose rice, 25000 for a 25 kg sack); null if not a weight item. */
  unitGrams: number | null;
}

export const COLUMNS = ["bought", "movedIn", "movedOut", "sold", "resack", "countFix", "returns", "other"] as const;
export type Column = (typeof COLUMNS)[number];

const COLUMN_OF: Record<Bucket, Column> = {
  purchase: "bought", transfer_in: "movedIn", transfer_out: "movedOut", sale: "sold", resack: "resack",
  count_or_writeoff: "countFix", void_or_return: "returns", other: "other",
};

export type SummaryRow = { productId: string; name: string; loose: boolean; start: number; end: number } & Record<Column, number>;
export type KiloTotals = { start: number; end: number } & Record<Column, number>;

const zero = (): Record<Column, number> => ({ bought: 0, movedIn: 0, movedOut: 0, sold: 0, resack: 0, countFix: 0, returns: 0, other: 0 });

export function buildSummary(
  products: SummaryProduct[],
  /** Stock on hand now, by product (added over the places chosen). */
  onHand: Map<string, number>,
  /** Net change after the period, by product. */
  after: Map<string, number>,
  /** The period's moves, grouped by product, type and document type. */
  groups: MoveGroup[],
): { rows: SummaryRow[]; kilos: KiloTotals } {
  const byProduct = new Map<string, Record<Column, number>>();
  for (const g of groups) {
    const cols = byProduct.get(g.productId) ?? zero();
    cols[COLUMN_OF[bucketOf({ type: g.type, documentType: g.documentType, delta: g.delta })]] += g.delta;
    byProduct.set(g.productId, cols);
  }
  const rows: SummaryRow[] = [];
  const totals: KiloTotals = { start: 0, end: 0, ...zero() };
  for (const p of products) {
    const cols = byProduct.get(p.id) ?? zero();
    const end = (onHand.get(p.id) ?? 0) - (after.get(p.id) ?? 0);
    const moved = COLUMNS.reduce((s, c) => s + cols[c], 0);
    const start = end - moved;
    if (start === 0 && end === 0 && moved === 0) continue;
    rows.push({ productId: p.id, name: p.name, loose: p.loose, start, end, ...cols });
    if (p.unitGrams !== null) {
      const k = p.unitGrams / 1000;
      totals.start += start * k;
      totals.end += end * k;
      for (const c of COLUMNS) totals[c] += cols[c] * k;
    }
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  for (const key of ["start", "end", ...COLUMNS] as const) totals[key] = round(totals[key]);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, kilos: totals };
}

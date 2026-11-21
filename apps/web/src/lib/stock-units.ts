// Stock is kept in whole units: sacks/pieces, or GRAMS for loose (per kilo) rice.
// What people type is kilos for loose rice, so it is turned into grams here.

export interface UnitsOf { stockBaseUnit: string | null; stockBaseQuantity: number | null }

/** Loose rice: kept in grams (1 stock unit = 1 g), priced and typed in kilos. */
export const isLooseItem = (r: UnitsOf) => (r.stockBaseUnit ?? "").toLowerCase() === "g" && r.stockBaseQuantity === 1;

/** What was typed, in stock units: kilos → grams for loose rice, whole sacks/pieces otherwise. NaN = not a number. */
export function adjustUnits(r: UnitsOf, text: string): number {
  const t = text.trim().replace(",", ".");
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return Number.NaN;
  const n = Number(t);
  if (isLooseItem(r)) return Math.round(n * 1000);
  return Number.isInteger(n) ? n : Number.NaN;
}

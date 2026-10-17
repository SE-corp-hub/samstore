// Cost and price history: pure helper. Decides which changes deserve a history line.

export type PriceField = "COST" | "PRICE";
export type PriceSource = "MANUAL" | "PURCHASE" | "CONVERSION" | "LOCATION";

export interface PriceChange {
  field: PriceField;
  oldMinor: number;
  newMinor: number;
}

/** Compare before and after. Only real changes come back; an unset new value means "not edited". */
export function priceChanges(
  before: { costMinor: number; priceMinor: number },
  after: { costMinor?: number | null; priceMinor?: number | null },
): PriceChange[] {
  const out: PriceChange[] = [];
  if (typeof after.costMinor === "number" && after.costMinor !== before.costMinor) {
    out.push({ field: "COST", oldMinor: before.costMinor, newMinor: after.costMinor });
  }
  if (typeof after.priceMinor === "number" && after.priceMinor !== before.priceMinor) {
    out.push({ field: "PRICE", oldMinor: before.priceMinor, newMinor: after.priceMinor });
  }
  return out;
}

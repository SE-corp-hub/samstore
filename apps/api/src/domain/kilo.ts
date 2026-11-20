// Sell rice per kilo (2026-11-20, pure). A store with "Sell per kilo here" on sells a rice by the
// sack AND by the kilo. The kilo rice is its own item ("Sinandomeng · per kilo"), stocked in grams
// and priced per kilo, made from a sack rice the owner ticks "Also sell per kilo" on.
//
// The owner's decisions (plan doc, 2026-11-20):
//   * only sacks the owner ticks (5 kg packs stay packs)  -> canSellPerKilo
//   * starting kilo price = sack price ÷ kilos in the sack, rounded UP to a whole peso, + ₱2 for spill
//   * kilo cost = sack cost ÷ kilos in the sack (store payable and profit per kilo, like sacks)

/** Smallest sack that may also sell per kilo: 10 kg (the 5 kg packs stay packs). */
export const MIN_KILO_SACK_GRAMS = 10_000;
/** Added to the kilo price for rice spilled while scooping: ₱2. */
export const KILO_SPILL_MINOR = 200;

export interface SackLike {
  name: string;
  soldByWeight?: boolean | null;
  stockBaseUnit?: string | null;
  stockBaseQuantity?: number | null;
}

/** Loose rice: stocked in grams, one stock unit = 1 g. */
export function isKiloItem(p: Pick<SackLike, "stockBaseUnit" | "stockBaseQuantity">): boolean {
  return (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1;
}

/** Why this rice cannot also sell per kilo, or null when it can. */
export function kiloRefusal(p: SackLike): string | null {
  if (isKiloItem(p) || p.soldByWeight) return `${p.name} is already sold per kilo`;
  if ((p.stockBaseUnit ?? "").toLowerCase() !== "g" || !p.stockBaseQuantity) return `Set the sack size of ${p.name} first (for example 25 kg)`;
  if (p.stockBaseQuantity < MIN_KILO_SACK_GRAMS) return `${p.name} is a small pack. Only sacks of 10 kg or more can be sold per kilo`;
  return null;
}

/** "Samrice Sinandomeng 25kg" -> "Samrice Sinandomeng · per kilo". */
export function kiloName(sackName: string): string {
  const base = sackName
    .replace(/\(?\b\d+(?:[.,]\d+)?\s*(?:kg|kgs|kilos?)\b\)?/gi, " ")
    .replace(/\b(?:sack|sako|bag)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s·\-–]+$/, "")
    .trim();
  return `${base || sackName.trim()} · per kilo`;
}

/** Starting price per kilo: sack price ÷ kilos, rounded up to a whole peso, plus ₱2. */
export function kiloPriceFrom(sackPriceMinor: number, sackGrams: number): number {
  if (!(sackPriceMinor > 0) || !(sackGrams > 0)) return 0;
  const perKilo = (sackPriceMinor * 1000) / sackGrams;
  return Math.ceil(perKilo / 100 - 1e-9) * 100 + KILO_SPILL_MINOR;
}

/** Cost per kilo: sack cost ÷ kilos (to the centavo). */
export function kiloCostFrom(sackCostMinor: number, sackGrams: number): number {
  if (!(sackCostMinor > 0) || !(sackGrams > 0)) return 0;
  return Math.round((sackCostMinor * 1000) / sackGrams);
}

/**
 * A rack's cost per kilo after more rice goes in: the average of what is on the rack and what comes in,
 * by weight (a rack can hold Sinandomeng and Mikami at one price). Rice below zero on the rack counts as none.
 */
export function rackCostAfter(onRackGrams: number, onRackCostMinor: number, addGrams: number, addCostMinor: number): number {
  const have = Math.max(0, onRackGrams);
  if (!(addGrams > 0)) return onRackCostMinor;
  if (!(have > 0) || !(onRackCostMinor > 0)) return addCostMinor;
  return Math.round((have * onRackCostMinor + addGrams * addCostMinor) / (have + addGrams));
}

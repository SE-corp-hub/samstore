// Rice Ops — "a sack was opened and nobody recorded it", worked out from a count.
// When the sack went down and the loose rice of the same kind went up, that is a resack, not a
// shortage plus a surplus. Pure: the count lines in, the plan out.

import { varietyOf } from "./resack.js";

export interface OpenedLine {
  productId: string;
  expectedQty: number | null;
  countedQty: number | null;
  product: { name: string; variety?: string | null; stockBaseUnit: string | null; stockBaseQuantity: number | null };
}

export interface OpenedPlan {
  variety: string;
  sackProductId: string;
  sackName: string;
  looseProductId: string;
  looseName: string;
  /** Sacks opened. */
  sacks: number;
  /** Grams that moved from the sacks to the loose rice. */
  grams: number;
  /** Loose rice found beyond what the opened sacks explain (grams). */
  unexplainedGrams: number;
}

/** One plan per kind of rice where the sack count dropped and the loose rice rose. */
export function planOpenedSacks(lines: OpenedLine[]): OpenedPlan[] {
  const groups = new Map<string, OpenedLine[]>();
  for (const l of lines) {
    if (l.countedQty === null || l.expectedQty === null) continue;
    if ((l.product.stockBaseUnit ?? "").toLowerCase() !== "g" || !l.product.stockBaseQuantity) continue;
    const key = varietyOf(l.product);
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const plans: OpenedPlan[] = [];
  for (const [variety, group] of groups) {
    const loose = group.find((l) => l.product.stockBaseQuantity === 1);
    const sack = group.filter((l) => (l.product.stockBaseQuantity ?? 0) > 1).sort((a, b) => b.product.stockBaseQuantity! - a.product.stockBaseQuantity!)[0];
    if (!loose || !sack) continue;
    const surplus = loose.countedQty! - loose.expectedQty!;
    const sackGone = sack.expectedQty! - sack.countedQty!;
    if (surplus <= 0 || sackGone <= 0) continue;
    const grams = sack.product.stockBaseQuantity!;
    const k = Math.min(sackGone, Math.ceil(surplus / grams));
    plans.push({ variety, sackProductId: sack.productId, sackName: sack.product.name, looseProductId: loose.productId, looseName: loose.product.name, sacks: k, grams: k * grams, unexplainedGrams: Math.max(0, surplus - k * grams) });
  }
  return plans;
}

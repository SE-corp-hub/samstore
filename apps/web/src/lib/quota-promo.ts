// Quota promo (the owner's pricelist): when one sale or pre-order has at least `minSacks` sacks of
// the chosen groups (e.g. Local and Premium), each of those sacks is `offMinor` cheaper.
// The owner turns it on or off in Settings. The tablet applies it (also offline) and sends it as a
// price change with the reason "Quota promo", so the receipt and the owner's report show it.

export type QuotaPromo = { on: boolean; minSacks: number; offMinor: number; categoryIds: string[] };

export const PROMO_REASON = "Quota promo";
export const PROMO_OFF: QuotaPromo = { on: false, minSacks: 10, offMinor: 2000, categoryIds: [] };

export type PromoLine = {
  /** The product's group (Products → category). */
  categoryId: string | null | undefined;
  /** Whole sacks or packs (not loose rice by the kilo). */
  isSack: boolean;
  /** How many sacks on this line. */
  quantity: number;
  /** The usual price of one sack here. */
  listMinor: number;
  /** Someone typed a price on this line: it is left alone and does not count. */
  manualPrice: boolean;
};

/** The sacks that count toward the promo. */
export function promoSacks(lines: PromoLine[], promo: QuotaPromo | null | undefined): number {
  if (!promo?.on || !promo.categoryIds.length) return 0;
  return lines.reduce((n, l) => n + (counts(l, promo) ? Math.max(0, Math.floor(l.quantity)) : 0), 0);
}

/** The promo price of each line (null = no promo on that line), in the same order as `lines`. */
export function promoPrices(lines: PromoLine[], promo: QuotaPromo | null | undefined): (number | null)[] {
  const reached = !!promo && promo.on && promo.offMinor > 0 && promo.minSacks > 0 && promoSacks(lines, promo) >= promo.minSacks;
  return lines.map((l) => (reached && counts(l, promo!) ? Math.max(0, l.listMinor - promo!.offMinor) : null));
}

const counts = (l: PromoLine, promo: QuotaPromo) =>
  l.isSack && !l.manualPrice && !!l.categoryId && promo.categoryIds.includes(l.categoryId);

/** Settings → the promo the tablet uses (missing or odd values = off). */
export function promoFrom(s: { quotaPromoEnabled?: boolean; quotaPromoMinSacks?: number; quotaPromoOffMinor?: number; quotaPromoCategoryIds?: string[] } | null | undefined): QuotaPromo {
  if (!s) return PROMO_OFF;
  return {
    on: s.quotaPromoEnabled === true,
    minSacks: Number.isInteger(s.quotaPromoMinSacks) && s.quotaPromoMinSacks! > 0 ? s.quotaPromoMinSacks! : 10,
    offMinor: Number.isInteger(s.quotaPromoOffMinor) && s.quotaPromoOffMinor! > 0 ? s.quotaPromoOffMinor! : 2000,
    categoryIds: Array.isArray(s.quotaPromoCategoryIds) ? s.quotaPromoCategoryIds.filter((x) => typeof x === "string") : [],
  };
}

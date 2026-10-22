// Reorder suggestions: pure helper.
// From what is left, how fast it sells and what is already on order, decide which items to buy and how much.

/** Items that would run out within this many days (counting what is already on order) are listed. */
export const SOON_DAYS = 7;
/** Under this many days of stock left (not counting orders) the item is marked "Order now". */
export const NOW_DAYS = 3;
/** The suggested amount is enough for this many days of selling. */
export const COVER_DAYS = 14;
/** Loose rice is suggested in whole kilos (stock is kept in grams). */
const KILO = 1000;

export type Urgency = "OUT" | "NOW" | "SOON";

export interface ReorderInput {
  /** On the shelves in all places, minus reserved (may be negative). Same unit as the sales: pieces, or grams for loose rice. */
  available: number;
  /** Average sold per day over the last 2 weeks. */
  perDay: number;
  /** Ordered from suppliers and not yet delivered. */
  onOrder: number;
  loose: boolean;
}

export interface ReorderAdvice {
  /** Days the shelves last at the recent pace (null = nothing sold lately, so unknown). */
  daysLeft: number | null;
  urgency: Urgency | null;
  suggested: number;
}

export function reorderAdvice(i: ReorderInput): ReorderAdvice {
  if (!(i.perDay > 0)) return { daysLeft: null, urgency: null, suggested: 0 };
  const have = Math.max(0, i.available);
  const daysLeft = Math.round((have / i.perDay) * 10) / 10;
  const covered = (have + Math.max(0, i.onOrder)) / i.perDay;
  if (covered >= SOON_DAYS) return { daysLeft, urgency: null, suggested: 0 };
  const urgency: Urgency = have <= 0 ? "OUT" : have / i.perDay < NOW_DAYS ? "NOW" : "SOON";
  const want = i.perDay * COVER_DAYS - have - Math.max(0, i.onOrder);
  let suggested = Math.max(1, Math.ceil(want));
  if (i.loose) suggested = Math.max(KILO, Math.ceil(suggested / KILO) * KILO);
  return { daysLeft, urgency, suggested };
}

const ORDER: Record<Urgency, number> = { OUT: 0, NOW: 1, SOON: 2 };
/** Most urgent first, then the fewest days left, then by name. */
export function byUrgency<T extends { urgency: Urgency; daysLeft: number | null; name: string }>(a: T, b: T): number {
  return ORDER[a.urgency] - ORDER[b.urgency] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.name.localeCompare(b.name);
}

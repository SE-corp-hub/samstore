// Loyalty rules — pure, unit-testable.

/** Default points earned per ₱1 (100 minor units) of order total. */
export const POINTS_PER_PESO = 1; // 1 point per ₱1
const MINOR_PER_PESO = 100;

/** Points earned for an order total at a given rate (floor). Rate = points per ₱1. */
export function pointsEarnedFor(totalMinor: number, pointsPerPeso: number = POINTS_PER_PESO): number {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) return 0;
  if (!Number.isInteger(pointsPerPeso) || pointsPerPeso < 1) return 0;
  return Math.floor((totalMinor / MINOR_PER_PESO) * pointsPerPeso);
}

/** Points earned for an order total at the default rate (backward compatible). */
export function pointsEarned(totalMinor: number): number {
  return pointsEarnedFor(totalMinor, POINTS_PER_PESO);
}

/** Discount (minor units) for redeeming `points` points. Rate: 100 points = ₱1. */
export function redeemDiscountMinor(points: number): number {
  if (!Number.isInteger(points) || points <= 0) return 0;
  return Math.floor(points / 100) * MINOR_PER_PESO; // 100 pts → ₱1
}

/** Minimum points for a meaningful redemption. */
export function isRedeemable(points: number): boolean {
  return redeemDiscountMinor(points) > 0;
}

/** Points needed for a given discount (rounds up to the nearest 100-block). */
export function pointsForDiscountMinor(discountMinor: number): number {
  if (!Number.isInteger(discountMinor) || discountMinor <= 0) return 0;
  return Math.ceil(discountMinor / MINOR_PER_PESO) * 100;
}

/** A ledger row for FIFO expiry math. */
export interface LoyaltyLedgerRow {
  type: string;
  points: number; // + earn/welcome, − redeem/reverse/expire/adjust(-)
  createdAt: Date;
}

/**
 * FIFO expiry: walk the ledger OLDEST→NEWEST; each debit (redeem/reverse/expire/
 * negative adjust) consumes points from the OLDEST pool first. Returns how many
 * points are still outstanding from entries OLDER than `cutoff` — those are the
 * expirable points for the customer (never exceeds what is on the balance).
 */
export function expirablePoints(entries: LoyaltyLedgerRow[], cutoff: Date): number {
  let aged = 0; // outstanding points from entries older than cutoff (not yet consumed)
  let fresh = 0; // outstanding points from entries at/after cutoff
  for (const e of entries) {
    if (e.points > 0) {
      if (e.createdAt < cutoff) aged += e.points;
      else fresh += e.points;
    } else {
      let need = -e.points;
      const fromAged = Math.min(aged, need);
      aged -= fromAged;
      need -= fromAged;
      const fromFresh = Math.min(fresh, need);
      fresh -= fromFresh;
    }
  }
  return aged;
}
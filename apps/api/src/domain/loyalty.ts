// Loyalty rules — pure, unit-testable.

/** Points earned per ₱1 (100 minor units) of order total. */
export const POINTS_PER_PESO = 1; // 1 point per ₱1
const MINOR_PER_PESO = 100;

/** Points earned for an order total (floor). */
export function pointsEarned(totalMinor: number): number {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) return 0;
  return Math.floor(totalMinor / MINOR_PER_PESO);
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
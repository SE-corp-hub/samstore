// Track stock on/off — the one rule every screen and every stock writer shares.
//
//   Track stock ON  (default): the shelf is counted, a sale is refused when the shelf is short.
//   Track stock OFF:           the product sells at any time. No stock check, no stock
//                              movement, shown as "not tracked". Its sale cost still uses the
//                              product cost, so profit reports keep working.
//
// Pure functions (no database) so the rule is unit-tested on its own.

/** What an untracked product reports as "available" so every existing "enough stock?" check passes. */
export const UNLIMITED_STOCK = 999_999;

/** A product with no trackStock value (older rows, test fixtures) is tracked. */
export function isTracked(p: { trackStock?: boolean | null } | null | undefined): boolean {
  return p?.trackStock !== false;
}

/** Quantity to show/check as available: the real number when tracked, UNLIMITED_STOCK when not. */
export function availableOf(p: { trackStock?: boolean | null }, onHand: number, reserved: number): number {
  return isTracked(p) ? onHand - reserved : UNLIMITED_STOCK;
}

/** Rice that is weighed into sacks and resacked must be tracked — resack works from the shelf. */
export function mustBeTracked(p: { stockBaseUnit?: string | null; stockBaseQuantity?: number | null; stockConversionFamily?: string | null }): boolean {
  return p.stockBaseUnit === "g" && (p.stockBaseQuantity ?? 0) > 0;
}

/** Why Track stock cannot be switched off for this product (null = it can). */
export function trackOffRefusal(p: { stockBaseUnit?: string | null; stockBaseQuantity?: number | null; stockConversionFamily?: string | null }): string | null {
  return mustBeTracked(p) ? "Rice with a sack weight must keep Track stock on — resack works from the shelf" : null;
}

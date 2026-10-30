// Selling below cost: one rule for every screen where a selling price or a unit cost is set.
// A price is "below cost" when the store would get less than it paid for the same piece or kilo.
// No cost on record (0 or unknown) never warns: there is nothing to compare with.
// Pure helpers so the rule is unit-tested without a browser.

/** True when selling at `priceMinor` loses money against `costMinor` (both per piece, or both per kilo). */
export function isBelowCost(priceMinor: number | null | undefined, costMinor: number | null | undefined): boolean {
  if (typeof priceMinor !== "number" || typeof costMinor !== "number") return false;
  if (!Number.isFinite(priceMinor) || !Number.isFinite(costMinor)) return false;
  return priceMinor > 0 && costMinor > 0 && priceMinor < costMinor;
}

/** What is lost on each piece (or kilo); 0 when the price covers the cost. */
export function lossEach(priceMinor: number, costMinor: number): number {
  return isBelowCost(priceMinor, costMinor) ? costMinor - priceMinor : 0;
}

/** A typed peso amount ("1,250.50") as centavos; null when blank or not a number. */
export function pesoToMinor(text: string | null | undefined): number | null {
  const t = (text ?? "").trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Remembers the prices someone already chose to keep, so the same line does not ask twice. */
export const okKey = (productId: string, priceMinor: number, costMinor: number) => `${productId}:${priceMinor}:${costMinor}`;

/** Owner and manager see costs (the same rule as the server's seesCost). */
export const seesCostRole = (role: string | undefined): boolean => role === "OWNER" || role === "MANAGER" || role === "PLATFORM_ADMIN" || role === "STORE_OWNER";

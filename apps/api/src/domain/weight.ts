// Rice Ops M1 — weight and peso arithmetic for loose rice.
//
// Loose rice is stocked in whole GRAMS (integers — no float drift in the ledger)
// and priced per KILO in whole centavos. Every conversion lives here so POS,
// resack, counts and reports all round the same way:
//
//   * by peso   — the customer pays exactly the pesos asked; grams round DOWN, so
//                 the store never hands over rice it was not paid for (< 1 g/sale).
//   * by weight — the line amount is computed from grams and rounded half-up ONCE
//                 per line (never per gram, never summed from rounded pieces).

export const GRAMS_PER_KG = 1000;

/** Largest value a Postgres INTEGER column holds (StockLevel, StockMovement). */
const INT_MAX = 2_147_483_647;

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive whole number (got ${value})`);
  if (value > INT_MAX) throw new RangeError(`${name} is too large (got ${value})`);
}

/**
 * Grams a customer receives for an amount of money: floor(amount × 1000 ÷ price per kg).
 * ₱100.00 at ₱52.00/kg → 10000 × 1000 ÷ 5200 = 1923.07… → 1923 g.
 */
export function gramsForAmount(amountMinor: number, pricePerKgMinor: number): number {
  assertPositiveInt("amountMinor", amountMinor);
  assertPositiveInt("pricePerKgMinor", pricePerKgMinor);
  // BigInt keeps amount × 1000 exact for any realistic price.
  const grams = Number((BigInt(amountMinor) * BigInt(GRAMS_PER_KG)) / BigInt(pricePerKgMinor));
  if (grams <= 0) throw new RangeError("amount is too small to buy any rice at this price");
  return grams;
}

/**
 * Line amount for a weight: grams × price per kg ÷ 1000, rounded half-up once.
 * 1250 g at ₱52.00/kg → 1250 × 5200 ÷ 1000 = 6500 → ₱65.00.
 */
export function amountForGrams(grams: number, pricePerKgMinor: number): number {
  assertPositiveInt("grams", grams);
  assertPositiveInt("pricePerKgMinor", pricePerKgMinor);
  const scaled = BigInt(grams) * BigInt(pricePerKgMinor);
  const whole = scaled / BigInt(GRAMS_PER_KG);
  const remainder = scaled % BigInt(GRAMS_PER_KG);
  return Number(remainder * 2n >= BigInt(GRAMS_PER_KG) ? whole + 1n : whole);
}

/**
 * Parse what staff type on the number pad ("1.25", "2", "0.5", "1,5") into grams.
 * Up to 3 decimals (1 g); anything finer, negative, zero or non-numeric is refused.
 */
export function parseKilos(input: string): number {
  const text = String(input ?? "").trim().replace(",", ".");
  const m = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) throw new RangeError(`"${input}" is not a weight in kilos (up to 3 decimals, e.g. 1.25)`);
  const grams = Number(m[1]) * GRAMS_PER_KG + Number((m[2] ?? "").padEnd(3, "0") || 0);
  assertPositiveInt("weight", grams);
  return grams;
}

/** 1923 → "1.923 kg"; 25000 → "25 kg"; 500 → "0.5 kg". Trailing zeros dropped. */
export function formatKilos(grams: number): string {
  if (!Number.isInteger(grams)) throw new RangeError(`grams must be a whole number (got ${grams})`);
  const sign = grams < 0 ? "-" : "";
  const abs = Math.abs(grams);
  const kg = Math.floor(abs / GRAMS_PER_KG);
  const rest = String(abs % GRAMS_PER_KG).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${kg}${rest ? `.${rest}` : ""} kg`;
}

/**
 * Loss of a resack or transfer as basis points of what went in (1% = 100 bp),
 * rounded half-up. Negative when more came out than went in (a "sobra").
 */
export function lossBasisPoints(gramsIn: number, gramsOut: number): number {
  assertPositiveInt("gramsIn", gramsIn);
  if (!Number.isInteger(gramsOut) || gramsOut < 0) throw new RangeError(`gramsOut must be a whole number ≥ 0 (got ${gramsOut})`);
  const loss = gramsIn - gramsOut;
  return Math.round((loss * 10_000) / gramsIn);
}

/** Default loss tolerance for resack/transfer: 1% (operator decision 2026-10-14). */
export const DEFAULT_LOSS_TOLERANCE_BP = 100;

/** True when a loss needs the store owner's approval. */
export function lossNeedsApproval(gramsIn: number, gramsOut: number, toleranceBp = DEFAULT_LOSS_TOLERANCE_BP): boolean {
  return lossBasisPoints(gramsIn, gramsOut) > toleranceBp;
}

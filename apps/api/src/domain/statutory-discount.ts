// P3b: statutory 20% discount for Senior Citizens (RA 9994) and PWDs (RA 10754).
// Pure, unit-testable. The 20% applies to the purchase amount (delivery fee excluded);
// the ID + cardholder name are captured for BIR/monitoring records.

export type StatutoryType = "senior" | "pwd";

/** 20% of the subtotal (integer minor units, floored — never fractional centavos). */
export function statutoryDiscountMinor(subtotalMinor: number): number {
  if (!Number.isInteger(subtotalMinor) || subtotalMinor < 0) {
    throw new Error(`statutoryDiscountMinor expects a non-negative integer, got ${subtotalMinor}`);
  }
  return Math.floor((subtotalMinor * 20) / 100);
}

const STATUTORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;

/** Validate a statutory claim's inputs. Returns field errors (empty = valid). */
export function validateStatutoryClaim(input: {
  statutoryType?: string;
  statutoryId?: string;
  statutoryName?: string;
}): string[] {
  const errors: string[] = [];
  const type = input.statutoryType;
  if (type !== "senior" && type !== "pwd") {
    errors.push("statutoryType must be 'senior' or 'pwd'");
  }
  const id = input.statutoryId?.trim() ?? "";
  if (!STATUTORY_ID_RE.test(id)) {
    errors.push("A valid ID number is required (3–32 letters/digits/dashes)");
  }
  const name = input.statutoryName?.trim() ?? "";
  if (name.length < 3 || name.length > 80) {
    errors.push("Cardholder name is required (3–80 characters)");
  }
  return errors;
}

/** Normalize the captured ID (trimmed, upper-cased). */
export function normalizeStatutoryId(id: string): string {
  return id.trim().toUpperCase();
}
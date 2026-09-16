// M4 — PH VAT engine (BIR-style breakdown).
//
// Operator decisions (locked 2026-09-14):
//   1. catalogue prices are VAT-INCLUSIVE by default; the store owner can HIDE the VAT lines on
//      the printed slip (`vatShowOnReceipt`) — hiding changes the display, never a total;
//   2. the delivery fee is NOT VAT-able (it is not part of the taxable base);
//   3. a voucher/loyalty discount is applied BEFORE tax — it reduces the VATable base.
//
// All amounts are integer minor units (centavos). Money never uses floats here.

export interface TaxLine {
  /** Line total after any line-level adjustment, still VAT-inclusive when `pricesIncludeVat`. */
  lineTotalMinor: number;
  /** M4: per-product VAT exemption (basic/zero-rated goods). */
  taxExempt?: boolean;
}

export interface TaxConfig {
  /** Master switch. When false the engine returns a zero-VAT, all-exempt-free breakdown. */
  vatEnabled: boolean;
  /** Basis points — 1200 = 12% PH VAT. */
  vatRateBp: number;
  /** true: catalogue prices already contain the VAT (PH retail norm). */
  pricesIncludeVat: boolean;
}

export interface TaxBreakdown {
  /** Net-of-VAT (inclusive mode) or pre-VAT (exclusive mode) base that carries VAT. */
  vatableMinor: number;
  /** The VAT amount itself. */
  vatMinor: number;
  /** VAT-exempt sales (exempt products; the delivery fee is reported here too, untaxed). */
  vatExemptMinor: number;
  /** The rate actually applied — snapshotted on the order, 0 when not taxed. */
  vatRateBp: number;
  /** Amount added on top of the catalogue prices in exclusive mode (0 in inclusive mode). */
  taxAddedMinor: number;
}

/** Half-up integer division — money rounding, never bankers'. */
function divRound(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  return sign * Math.floor((abs + denominator / 2) / denominator);
}

/**
 * Extract (inclusive) or add (exclusive) VAT for ONE line, rounded per line so the printed
 * breakdown always adds up to the line total.
 */
export function lineTax(lineTotalMinor: number, cfg: TaxConfig, taxExempt = false): TaxBreakdown {
  const zero: TaxBreakdown = { vatableMinor: 0, vatMinor: 0, vatExemptMinor: lineTotalMinor, vatRateBp: 0, taxAddedMinor: 0 };
  if (!cfg.vatEnabled || cfg.vatRateBp <= 0) {
    // VAT off: everything is simply not taxed. Totals are untouched (kill switch).
    return { ...zero, vatExemptMinor: 0, vatableMinor: lineTotalMinor };
  }
  if (taxExempt) return zero;

  if (cfg.pricesIncludeVat) {
    // base = total * 10000 / (10000 + rate); vat = total - base
    const vatable = divRound(lineTotalMinor * 10_000, 10_000 + cfg.vatRateBp);
    return { vatableMinor: vatable, vatMinor: lineTotalMinor - vatable, vatExemptMinor: 0, vatRateBp: cfg.vatRateBp, taxAddedMinor: 0 };
  }
  const vat = divRound(lineTotalMinor * cfg.vatRateBp, 10_000);
  return { vatableMinor: lineTotalMinor, vatMinor: vat, vatExemptMinor: 0, vatRateBp: cfg.vatRateBp, taxAddedMinor: vat };
}

/**
 * Tax for a whole sale.
 *
 * Order of operations (decision 3): the discount comes off the VATable portion FIRST, then the
 * exempt portion, so a voucher cannot be used to shrink VAT that was never going to be charged
 * and the taxable base shrinks the moment a discount is applied. The delivery fee is excluded
 * from the taxable base entirely (decision 2) and reported as non-VAT sales.
 */
export function computeTax(
  lines: TaxLine[],
  cfg: TaxConfig,
  opts: { discountMinor?: number; deliveryFeeMinor?: number } = {},
): TaxBreakdown {
  const discount = Math.max(0, Math.floor(opts.discountMinor ?? 0));
  const delivery = Math.max(0, Math.floor(opts.deliveryFeeMinor ?? 0));

  // 1. Vatable lines share the discount pro-rata to their own totals (largest-remainder is
  //    overkill here: any per-line centavo lands in the same total because the base is summed
  //    from the same rounded lines the customer is charged for).
  const vatableLines = lines.filter((l) => !l.taxExempt).map((l) => Math.max(0, Math.floor(l.lineTotalMinor)));
  const exemptLines = lines.filter((l) => l.taxExempt).map((l) => Math.max(0, Math.floor(l.lineTotalMinor)));
  const vatableTotal = vatableLines.reduce((a, b) => a + b, 0);
  const exemptTotal = exemptLines.reduce((a, b) => a + b, 0);

  // 2. Allocate the discount: VATable first, then exempt (never below zero).
  const discountOnVatable = Math.min(discount, vatableTotal);
  const discountOnExempt = Math.min(discount - discountOnVatable, exemptTotal);

  const vatableAfterDiscount = vatableTotal - discountOnVatable;
  const exemptAfterDiscount = exemptTotal - discountOnExempt;

  if (!cfg.vatEnabled || cfg.vatRateBp <= 0) {
    return {
      vatableMinor: vatableAfterDiscount,
      vatMinor: 0,
      // The delivery fee stays reported as non-VAT sales so the slip's arithmetic —
      // net + VAT + non-VAT == subtotal + fee − discount — holds in EVERY mode, kill switch
      // included. That invariant is what makes the frozen snapshot reconcilable.
      vatExemptMinor: exemptAfterDiscount + delivery,
      vatRateBp: 0,
      taxAddedMinor: 0,
    };
  }

  // 3. VAT on the DISCOUNTED base, rounded once for the whole sale so the slip's arithmetic is
  //    exact: vat = round(base * rate / 10000) in exclusive mode, base = round(total * 10000 /
  //    (10000 + rate)) in inclusive mode.
  let vatableMinor: number;
  let vatMinor: number;
  let taxAddedMinor = 0;
  if (cfg.pricesIncludeVat) {
    vatableMinor = divRound(vatableAfterDiscount * 10_000, 10_000 + cfg.vatRateBp);
    vatMinor = vatableAfterDiscount - vatableMinor;
  } else {
    vatableMinor = vatableAfterDiscount;
    vatMinor = divRound(vatableAfterDiscount * cfg.vatRateBp, 10_000);
    taxAddedMinor = vatMinor;
  }

  return {
    vatableMinor,
    vatMinor,
    vatExemptMinor: exemptAfterDiscount + delivery, // the delivery fee is never VAT-able (decision 2)
    vatRateBp: cfg.vatRateBp,
    taxAddedMinor,
  };
}

export function taxConfigFrom(settings: Partial<TaxConfig> | null | undefined): TaxConfig {
  return {
    vatEnabled: settings?.vatEnabled ?? DEFAULT_TAX_CONFIG.vatEnabled,
    vatRateBp: settings?.vatRateBp ?? DEFAULT_TAX_CONFIG.vatRateBp,
    pricesIncludeVat: settings?.pricesIncludeVat ?? DEFAULT_TAX_CONFIG.pricesIncludeVat,
  };
}

/** The four columns frozen on an order — keep this list identical to the Order model. */
export function taxColumns(t: TaxBreakdown): {
  vatableMinor: number;
  vatMinor: number;
  vatExemptMinor: number;
  vatRateBp: number;
} {
  return { vatableMinor: t.vatableMinor, vatMinor: t.vatMinor, vatExemptMinor: t.vatExemptMinor, vatRateBp: t.vatRateBp };
}

/** Default configuration — what a store gets before it ever opens the tax settings. */
export const DEFAULT_TAX_CONFIG: TaxConfig = { vatEnabled: true, vatRateBp: 1200, pricesIncludeVat: true };
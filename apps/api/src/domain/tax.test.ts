// M4 — the tax engine's contract. Every decision the operator locked is a test here.
import test from "node:test";
import assert from "node:assert/strict";
import { computeTax, lineTax, type TaxConfig } from "./tax.js";

const INCLUSIVE: TaxConfig = { vatEnabled: true, vatRateBp: 1200, pricesIncludeVat: true };
const EXCLUSIVE: TaxConfig = { vatEnabled: true, vatRateBp: 1200, pricesIncludeVat: false };
const OFF: TaxConfig = { vatEnabled: false, vatRateBp: 1200, pricesIncludeVat: true };

const pesos = (minor: number) => (minor / 100).toFixed(2);

test("tax: inclusive ₱112.00 extracts ₱100.00 net + ₱12.00 VAT", () => {
  const b = computeTax([{ lineTotalMinor: 11_200 }], INCLUSIVE);
  assert.equal(b.vatableMinor, 10_000, "base");
  assert.equal(b.vatMinor, 1_200, "vat");
  assert.equal(b.vatExemptMinor, 0);
  assert.equal(b.vatRateBp, 1200);
  assert.equal(b.taxAddedMinor, 0, "inclusive mode never adds anything on top");
});

test("tax: exclusive ₱100.00 adds ₱12.00 VAT on top of the base", () => {
  const b = computeTax([{ lineTotalMinor: 10_000 }], EXCLUSIVE);
  assert.equal(b.vatableMinor, 10_000);
  assert.equal(b.vatMinor, 1_200);
  assert.equal(b.taxAddedMinor, 1_200);
});

test("tax: an exempt product is reported as exempt sales, never taxed", () => {
  const b = computeTax([{ lineTotalMinor: 5_000, taxExempt: true }], INCLUSIVE);
  assert.equal(b.vatMinor, 0);
  assert.equal(b.vatableMinor, 0);
  assert.equal(b.vatExemptMinor, 5_000);
});

test("tax: mixed cart splits taxable and exempt sales", () => {
  const b = computeTax([{ lineTotalMinor: 11_200 }, { lineTotalMinor: 5_000, taxExempt: true }], INCLUSIVE);
  assert.equal(b.vatableMinor, 10_000);
  assert.equal(b.vatMinor, 1_200);
  assert.equal(b.vatExemptMinor, 5_000);
});

test("tax: per-line rounding keeps the breakdown equal to what the customer pays", () => {
  // ₱33.33 × 3 = ₱99.99 inclusive at 12%
  const lines = [3333, 3333, 3333].map((lineTotalMinor) => ({ lineTotalMinor }));
  const b = computeTax(lines, INCLUSIVE);
  assert.equal(pesos(b.vatableMinor), "89.28");
  assert.equal(pesos(b.vatMinor), "10.71");
  assert.equal(b.vatableMinor + b.vatMinor, 9999, "no centavo is created or lost");
});

test("tax: the voucher discount comes off the VATable base BEFORE tax (decision 3)", () => {
  // ₱100 sale − ₱20 voucher = ₱80.00 base → ₱8.57 VAT
  const b = computeTax([{ lineTotalMinor: 10_000 }], INCLUSIVE, { discountMinor: 2_000 });
  assert.equal(b.vatableMinor, 7_143, "net of VAT on the discounted amount");
  assert.equal(b.vatMinor, 857);
  assert.equal(pesos(b.vatMinor), "8.57");
});

test("tax: the delivery fee is NOT VAT-able (decision 2)", () => {
  const b = computeTax([{ lineTotalMinor: 10_000 }], INCLUSIVE, { deliveryFeeMinor: 5_000 });
  assert.equal(b.vatableMinor, 8_929);
  assert.equal(b.vatMinor, 1_071, "VAT is computed on the goods only");
  assert.equal(b.vatExemptMinor, 5_000, "the fee is reported as non-VAT sales");
});

test("tax: discount + delivery — the discount never eats the untaxed delivery fee first", () => {
  const b = computeTax([{ lineTotalMinor: 10_000 }], INCLUSIVE, { discountMinor: 2_000, deliveryFeeMinor: 5_000 });
  assert.equal(b.vatMinor, 857, "same VAT as without a delivery fee");
  assert.equal(b.vatExemptMinor, 5_000);
  // The identity that prints on the BIR slip: net + VAT + non-VAT == subtotal + fee − discount.
  assert.equal(b.vatableMinor + b.vatMinor + b.vatExemptMinor, 10_000 + 5_000 - 2_000);
});

test("tax: an over-large discount spills onto exempt goods and never makes VAT negative", () => {
  const b = computeTax(
    [{ lineTotalMinor: 10_000 }, { lineTotalMinor: 5_000, taxExempt: true }],
    INCLUSIVE,
    { discountMinor: 12_000 },
  );
  assert.equal(b.vatableMinor, 0);
  assert.equal(b.vatMinor, 0);
  assert.equal(b.vatExemptMinor, 3_000, "₱50 exempt − the ₱20 left over");
});

test("tax: vatEnabled=false is a true kill switch — no VAT, no display, totals untouched", () => {
  const b = computeTax([{ lineTotalMinor: 10_000 }], OFF, { discountMinor: 2_000, deliveryFeeMinor: 5_000 });
  assert.equal(b.vatMinor, 0);
  assert.equal(b.vatRateBp, 0);
  assert.equal(b.vatableMinor, 8_000);
  assert.equal(b.vatExemptMinor, 5_000);
  assert.equal(b.vatableMinor + b.vatMinor + b.vatExemptMinor, 10_000 + 5_000 - 2_000, "totals are identical to the pre-M4 behaviour");
});

test("tax: a rate of 0 is treated as 'not taxed' rather than dividing by zero", () => {
  const b = computeTax([{ lineTotalMinor: 10_000 }], { ...INCLUSIVE, vatRateBp: 0 });
  assert.equal(b.vatMinor, 0);
  assert.equal(b.vatableMinor, 10_000);
});

test("tax: the identity holds in inclusive AND exclusive mode across a mixed cart", () => {
  const lines = [
    { lineTotalMinor: 11_200 }, // ₱112 inclusive → ₱100 + ₱12
    { lineTotalMinor: 5_000, taxExempt: true },
    { lineTotalMinor: 3_333 },
  ];
  const subtotal = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
  const discount = 1_500;
  const delivery = 4_900;

  const inc = computeTax(lines, INCLUSIVE, { discountMinor: discount, deliveryFeeMinor: delivery });
  assert.equal(inc.vatableMinor + inc.vatMinor + inc.vatExemptMinor, subtotal + delivery - discount);

  const exc = computeTax(lines, EXCLUSIVE, { discountMinor: discount, deliveryFeeMinor: delivery });
  // in exclusive mode the customer pays the VAT on top, so the identity includes it
  assert.equal(exc.vatableMinor + exc.vatMinor + exc.vatExemptMinor, subtotal + exc.vatMinor + delivery - discount);
});

test("tax: lineTax rounds half-up and never returns a negative VAT", () => {
  assert.equal(lineTax(5_600, INCLUSIVE).vatMinor, 600, "₱56 inclusive → ₱6 VAT");
  assert.equal(lineTax(1, INCLUSIVE).vatMinor, 0, "a single centavo carries no VAT");
  assert.equal(lineTax(1, INCLUSIVE).vatableMinor + lineTax(1, INCLUSIVE).vatMinor, 1);
  assert.equal(lineTax(0, INCLUSIVE).vatMinor, 0);
});
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOrderTotals,
  InvalidPriceInputError,
  formatMinorUnits,
} from "./pricing.js";

test("subtotal sums lines in integer minor units", () => {
  const t = computeOrderTotals({
    lines: [
      { unitPriceMinor: 1500, quantity: 2 }, // 30.00
      { unitPriceMinor: 499, quantity: 1 }, //  4.99
    ],
  });
  assert.equal(t.subtotalMinor, 3499);
  assert.equal(t.deliveryFeeMinor, 0);
  assert.equal(t.discountMinor, 0);
  assert.equal(t.totalMinor, 3499);
});

test("delivery fee adds to total, discount subtracts", () => {
  const t = computeOrderTotals({
    lines: [{ unitPriceMinor: 1000, quantity: 1 }],
    deliveryFeeMinor: 500,
    discountMinor: 250,
  });
  assert.equal(t.subtotalMinor, 1000);
  assert.equal(t.totalMinor, 1000 - 250 + 500);
});

test("rejects empty order", () => {
  assert.throws(() => computeOrderTotals({ lines: [] }), InvalidPriceInputError);
});

test("rejects negative unit price", () => {
  assert.throws(
    () => computeOrderTotals({ lines: [{ unitPriceMinor: -1, quantity: 1 }] }),
    InvalidPriceInputError,
  );
});

test("rejects zero/negative quantity", () => {
  assert.throws(
    () => computeOrderTotals({ lines: [{ unitPriceMinor: 100, quantity: 0 }] }),
    InvalidPriceInputError,
  );
  assert.throws(
    () => computeOrderTotals({ lines: [{ unitPriceMinor: 100, quantity: -3 }] }),
    InvalidPriceInputError,
  );
});

test("rejects non-integer price", () => {
  assert.throws(
    () => computeOrderTotals({ lines: [{ unitPriceMinor: 10.5, quantity: 1 }] }),
    InvalidPriceInputError,
  );
});

test("rejects negative delivery fee and negative discount", () => {
  assert.throws(
    () => computeOrderTotals({ lines: [{ unitPriceMinor: 100, quantity: 1 }], deliveryFeeMinor: -1 }),
    InvalidPriceInputError,
  );
  assert.throws(
    () => computeOrderTotals({ lines: [{ unitPriceMinor: 100, quantity: 1 }], discountMinor: -5 }),
    InvalidPriceInputError,
  );
});

test("rejects discount exceeding subtotal (no negative totals)", () => {
  assert.throws(
    () => computeOrderTotals({ lines: [{ unitPriceMinor: 100, quantity: 1 }], discountMinor: 500 }),
    InvalidPriceInputError,
  );
});

test("formatMinorUnits renders two decimals", () => {
  assert.equal(formatMinorUnits(3499), "34.99");
  assert.equal(formatMinorUnits(5), "0.05");
  assert.equal(formatMinorUnits(100), "1.00");
});
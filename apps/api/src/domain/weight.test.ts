// Rice Ops M1 — pure weight/peso arithmetic (no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountForGrams,
  formatKilos,
  gramsForAmount,
  lossBasisPoints,
  lossNeedsApproval,
  parseKilos,
} from "./weight.js";

test("M1 weight: ₱100 at ₱52/kg buys 1923 g (rounded down, store never over-gives)", () => {
  assert.equal(gramsForAmount(10_000, 5_200), 1923);
});

test("M1 weight: exact pesos give exact grams", () => {
  assert.equal(gramsForAmount(5_200, 5_200), 1000);
  assert.equal(gramsForAmount(2_600, 5_200), 500);
});

test("M1 weight: an amount too small for 1 g is refused, not silently zero", () => {
  assert.throws(() => gramsForAmount(1, 5_200), /too small/);
  assert.throws(() => gramsForAmount(0, 5_200), /positive/);
  assert.throws(() => gramsForAmount(100, 0), /positive/);
  assert.throws(() => gramsForAmount(10.5, 5_200), /whole/);
});

test("M1 weight: line amount from grams rounds half-up once", () => {
  assert.equal(amountForGrams(1250, 5_200), 6_500); // 1.25 kg × ₱52 = ₱65.00
  assert.equal(amountForGrams(1923, 5_200), 10_000); // 9999.6 → 10000: the by-peso sale prices back to ₱100
  assert.equal(amountForGrams(1, 5_250), 5); // 5.25 → 5
  assert.equal(amountForGrams(1, 5_500), 6); // 5.5 → 6 (half-up)
  assert.equal(amountForGrams(25_000, 4_800), 120_000); // a full 25 kg at ₱48/kg
});

test("M1 weight: number-pad kilos parse to grams", () => {
  assert.equal(parseKilos("1.25"), 1250);
  assert.equal(parseKilos("2"), 2000);
  assert.equal(parseKilos("0.5"), 500);
  assert.equal(parseKilos(" 1,5 "), 1500);
  assert.equal(parseKilos("0.001"), 1);
  for (const bad of ["", "0", "-1", "1.2345", "abc", "1.2.3", "0.000"]) {
    assert.throws(() => parseKilos(bad), RangeError, bad);
  }
});

test("M1 weight: kilos format without trailing zeros", () => {
  assert.equal(formatKilos(1923), "1.923 kg");
  assert.equal(formatKilos(25_000), "25 kg");
  assert.equal(formatKilos(500), "0.5 kg");
  assert.equal(formatKilos(1050), "1.05 kg");
  assert.equal(formatKilos(-200), "-0.2 kg");
  assert.equal(formatKilos(0), "0 kg");
});

test("M1 weight: resack loss in basis points and the 1% approval rule", () => {
  assert.equal(lossBasisPoints(25_000, 24_800), 80); // 0.8%
  assert.equal(lossNeedsApproval(25_000, 24_800), false);
  assert.equal(lossBasisPoints(25_000, 24_750), 100); // exactly 1% — within tolerance
  assert.equal(lossNeedsApproval(25_000, 24_750), false);
  assert.equal(lossNeedsApproval(25_000, 24_700), true); // 1.2% → owner approves
  assert.equal(lossBasisPoints(25_000, 25_100), -40); // more out than in = sobra
  assert.equal(lossNeedsApproval(25_000, 25_100), false);
});

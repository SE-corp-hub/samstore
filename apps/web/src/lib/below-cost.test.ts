import { test } from "node:test";
import assert from "node:assert/strict";
import { isBelowCost, lossEach, okKey, pesoToMinor } from "./below-cost";

test("a price under the cost is below cost", () => {
  assert.equal(isBelowCost(120_000, 125_000), true);
  assert.equal(lossEach(120_000, 125_000), 5_000);
});

test("selling at cost or above is fine", () => {
  assert.equal(isBelowCost(125_000, 125_000), false);
  assert.equal(isBelowCost(130_000, 125_000), false);
  assert.equal(lossEach(130_000, 125_000), 0);
});

test("no cost on record, no price yet, or a hidden cost never warns", () => {
  assert.equal(isBelowCost(5_000, 0), false);
  assert.equal(isBelowCost(0, 5_000), false);
  assert.equal(isBelowCost(5_000, null), false);
  assert.equal(isBelowCost(undefined, 5_000), false);
  assert.equal(isBelowCost(Number.NaN, 5_000), false);
});

test("typed pesos become centavos", () => {
  assert.equal(pesoToMinor("1,250.50"), 125_050);
  assert.equal(pesoToMinor("52"), 5_200);
  assert.equal(pesoToMinor(""), null);
  assert.equal(pesoToMinor("abc"), null);
});

test("a kept price is remembered per product, price and cost", () => {
  assert.equal(okKey("p1", 100, 120), "p1:100:120");
  assert.notEqual(okKey("p1", 100, 120), okKey("p1", 100, 130));
});

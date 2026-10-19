import { test } from "node:test";
import assert from "node:assert/strict";
import { UNLIMITED_STOCK, availableOf, isTracked, mustBeTracked, trackOffRefusal } from "./stock-tracking.js";

test("a product is tracked unless trackStock is exactly false", () => {
  assert.equal(isTracked({ trackStock: true }), true);
  assert.equal(isTracked({}), true, "older rows have no value: tracked");
  assert.equal(isTracked({ trackStock: null }), true);
  assert.equal(isTracked(undefined), true);
  assert.equal(isTracked({ trackStock: false }), false);
});

test("available is on hand minus reserved when tracked, unlimited when not", () => {
  assert.equal(availableOf({ trackStock: true }, 10, 3), 7);
  assert.equal(availableOf({ trackStock: false }, 0, 0), UNLIMITED_STOCK);
  assert.equal(availableOf({ trackStock: false }, -5, 2), UNLIMITED_STOCK, "even a negative shelf sells");
});

test("rice with a sack weight cannot be switched off, other items can", () => {
  const sack = { stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" };
  const loose = { stockBaseUnit: "g", stockBaseQuantity: 1 };
  const piece = { stockBaseUnit: null, stockBaseQuantity: null };
  assert.equal(mustBeTracked(sack), true);
  assert.equal(mustBeTracked(loose), true);
  assert.equal(mustBeTracked(piece), false);
  assert.match(trackOffRefusal(sack) ?? "", /must keep Track stock on/);
  assert.equal(trackOffRefusal(piece), null);
});

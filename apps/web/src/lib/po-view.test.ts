import test from "node:test";
import assert from "node:assert/strict";
import { costMove, draftFromReorder, moveText } from "./po-view.js";

const money = (m: number) => `₱${(m / 100).toFixed(2)}`;

test("no earlier cost: nothing to say", () => {
  assert.equal(costMove(null, 5000).kind, "NEW");
  assert.equal(moveText(costMove(undefined, 5000), money), "");
});

test("same, up and down read in plain words", () => {
  assert.equal(moveText(costMove(5000, 5000), money), "Same as last time (₱50.00)");
  assert.equal(moveText(costMove(5000, 5250), money), "Up ₱2.50 (5%) from ₱50.00");
  assert.equal(moveText(costMove(5000, 4900), money), "Down ₱1.00 (2%) from ₱50.00");
});

test("5% or more is a big move, under that is not (same rule as the server)", () => {
  assert.equal(costMove(10000, 10500).big, true);
  assert.equal(costMove(10000, 10499).big, false);
  assert.equal(costMove(10000, 9400).big, true);
});

test("a draft takes kilos for loose rice and pieces for sacks, and the last cost first", () => {
  const d = draftFromReorder([
    { productId: "a", loose: false, suggestedQty: 55, supplierId: "s1", lastCostMinor: 101_000, productCostMinor: 99_000 },
    { productId: "b", loose: true, suggestedQty: 155_000, supplierId: "s1", lastCostMinor: null, productCostMinor: 4_600 },
  ]);
  assert.deepEqual(d.rows, [{ productId: "a", qty: "55", cost: "1010" }, { productId: "b", qty: "155", cost: "46" }]);
  assert.equal(d.supplierId, "s1");
});

test("the supplier is left empty when the picks have different or unknown suppliers", () => {
  const base = { loose: false, suggestedQty: 1, lastCostMinor: null, productCostMinor: 100 };
  assert.equal(draftFromReorder([{ ...base, productId: "a", supplierId: "s1" }, { ...base, productId: "b", supplierId: "s2" }]).supplierId, "");
  assert.equal(draftFromReorder([{ ...base, productId: "a", supplierId: "s1" }, { ...base, productId: "b", supplierId: null }]).supplierId, "");
  assert.equal(draftFromReorder([{ ...base, productId: "a", supplierId: null }]).supplierId, "");
  assert.equal(draftFromReorder([]).supplierId, "");
});

test("a cost of zero leaves the cost box empty", () => {
  const d = draftFromReorder([{ productId: "a", loose: false, suggestedQty: 3, supplierId: null, lastCostMinor: null, productCostMinor: 0 }]);
  assert.equal(d.rows[0]?.cost, "");
});

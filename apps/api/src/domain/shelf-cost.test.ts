import test from "node:test";
import assert from "node:assert/strict";
import { blendedCost, effectiveCost, parseCostMode } from "./shelf-cost.js";

test("an empty shelf takes the incoming cost", () => {
  assert.equal(blendedCost(0, 0, 10, 5000), 5000);
  assert.equal(blendedCost(0, 4000, 10, 5000), 5000);
});

test("stock on the shelf and new stock are averaged by quantity", () => {
  assert.equal(blendedCost(10, 4000, 10, 5000), 4500);
  assert.equal(blendedCost(30, 4000, 10, 5000), 4250);
});

test("rounds to the nearest centavo", () => {
  assert.equal(blendedCost(1, 100, 2, 101), 101);
  assert.equal(blendedCost(2, 100, 1, 101), 100);
});

test("nothing arriving leaves the cost alone", () => {
  assert.equal(blendedCost(10, 4000, 0, 9999), 4000);
});

test("a negative shelf is treated as empty", () => {
  assert.equal(blendedCost(-3, 4000, 10, 5000), 5000);
});

test("shared mode always uses the product cost", () => {
  assert.equal(effectiveCost("SHARED", 4800, 5000), 5000);
});

test("per location uses the shelf cost, and falls back to the product cost when unset", () => {
  assert.equal(effectiveCost("PER_LOCATION", 4800, 5000), 4800);
  assert.equal(effectiveCost("PER_LOCATION", null, 5000), 5000);
  assert.equal(effectiveCost("PER_LOCATION", undefined, 5000), 5000);
  assert.equal(effectiveCost("PER_LOCATION", 0, 5000), 0);
});

test("unknown mode text means shared", () => {
  assert.equal(parseCostMode(null), "SHARED");
  assert.equal(parseCostMode("whatever"), "SHARED");
  assert.equal(parseCostMode("PER_LOCATION"), "PER_LOCATION");
});

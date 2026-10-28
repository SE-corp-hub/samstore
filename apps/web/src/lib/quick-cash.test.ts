import { test } from "node:test";
import assert from "node:assert/strict";
import { quickCash } from "./quick-cash";

test("exact total first, then the next ₱100, ₱500 and ₱1,000", () => {
  assert.deepEqual(quickCash(127_550), [127_550, 130_000, 150_000, 200_000]);
});

test("a round total is not repeated", () => {
  assert.deepEqual(quickCash(100_000), [100_000]);
  assert.deepEqual(quickCash(32_000), [32_000, 40_000, 50_000, 100_000]);
});

test("nothing to suggest for an empty sale", () => {
  assert.deepEqual(quickCash(0), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { priceChanges } from "./price-history.js";

test("no change gives no history line", () => {
  assert.deepEqual(priceChanges({ costMinor: 100, priceMinor: 150 }, { costMinor: 100, priceMinor: 150 }), []);
});

test("an unset value means not edited", () => {
  assert.deepEqual(priceChanges({ costMinor: 100, priceMinor: 150 }, {}), []);
  assert.deepEqual(priceChanges({ costMinor: 100, priceMinor: 150 }, { costMinor: null, priceMinor: undefined }), []);
});

test("cost and price are logged separately", () => {
  assert.deepEqual(priceChanges({ costMinor: 100, priceMinor: 150 }, { costMinor: 120, priceMinor: 150 }), [{ field: "COST", oldMinor: 100, newMinor: 120 }]);
  assert.deepEqual(priceChanges({ costMinor: 100, priceMinor: 150 }, { costMinor: 90, priceMinor: 160 }), [
    { field: "COST", oldMinor: 100, newMinor: 90 },
    { field: "PRICE", oldMinor: 150, newMinor: 160 },
  ]);
});

test("a change to zero still counts", () => {
  assert.deepEqual(priceChanges({ costMinor: 100, priceMinor: 150 }, { costMinor: 0 }), [{ field: "COST", oldMinor: 100, newMinor: 0 }]);
});

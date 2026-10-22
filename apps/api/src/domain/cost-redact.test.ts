import { test } from "node:test";
import assert from "node:assert/strict";
import { redactCost, seesCost } from "./cost-redact.js";

test("redactCost removes cost and profit at any depth and leaves the original alone", () => {
  const src = { products: [{ id: "p", name: "Rice", priceMinor: 100, costMinor: 80, variants: [{ id: "v", costMinor: 70, priceMinor: 90 }] }], totalValueMinor: 5, when: new Date(0) };
  const out = redactCost(src);
  assert.deepEqual(out.products, [{ id: "p", name: "Rice", priceMinor: 100, variants: [{ id: "v", priceMinor: 90 }] }]);
  assert.equal("totalValueMinor" in out, false);
  assert.ok(out.when instanceof Date);
  assert.equal(src.products[0]!.costMinor, 80, "the cached original is untouched");
});

test("only owner and manager see cost", () => {
  assert.equal(seesCost("OWNER"), true);
  assert.equal(seesCost("MANAGER"), true);
  assert.equal(seesCost("STAFF"), false);
  assert.equal(seesCost("SALES_AGENT"), false);
  assert.equal(seesCost(undefined), false);
});

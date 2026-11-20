// Staff may change a price at the counter only down to the lowest price; the owner and a manager: any price.
import { test } from "node:test";
import assert from "node:assert/strict";
import { belowLowestRefusal } from "./lowest-price.js";

const line = (unitPriceMinor: number, overridden = true) => ({ name: "Dinorado 25 kg", unitPriceMinor, overridden });

test("the owner and a manager sell at any price", () => {
  for (const role of ["OWNER", "MANAGER", "STORE_OWNER"]) assert.equal(belowLowestRefusal(role, line(1), 115_000), null);
});

test("staff, a sales agent and a login with no role cannot go under the lowest price", () => {
  for (const role of ["STAFF", "SALES_AGENT", "", undefined]) {
    assert.match(belowLowestRefusal(role, line(114_999), 115_000) ?? "", /lowest price is ₱1,150\.00/);
    assert.equal(belowLowestRefusal(role, line(115_000), 115_000), null, "the lowest price itself is allowed");
    assert.equal(belowLowestRefusal(role, line(140_000), 115_000), null, "a higher price is allowed");
  }
});

test("a price that was not changed is never refused, even when the list price is under the cost", () => {
  assert.equal(belowLowestRefusal("STAFF", line(100_000, false), 115_000), null);
});

test("staff cannot give rice for free, also when no cost is on record", () => {
  assert.match(belowLowestRefusal("STAFF", line(0), 0) ?? "", /only the owner/);
  assert.equal(belowLowestRefusal("STAFF", line(5_000), 0), null, "no cost on record: nothing to compare with");
});

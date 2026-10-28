import { test } from "node:test";
import assert from "node:assert/strict";
import { cashNote } from "./delivery-proof.js";
import { ruleFor } from "./people.js";

test("cash collected equal to the total: no short/over text", () => {
  assert.equal(cashNote(125000, 125000), "Cash collected ₱1,250");
});

test("cash short or over the total says by how much", () => {
  assert.equal(cashNote(120000, 125000), "Cash collected ₱1,200 (short ₱50 of ₱1,250)");
  assert.equal(cashNote(130000, 125000), "Cash collected ₱1,300 (over ₱50 of ₱1,250)");
});

test("the receiver of an online order can sign on the courier page", () => {
  assert.deepEqual(ruleFor("ORDER", "DELIVERED"), { always: ["CUSTOMER"] });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { addedStores, addedWords, matchesAddedAt } from "./added-where";

const lipa = { addedAt: { id: "s3", name: "Lipa" }, addedVia: "POS", addedBy: "Juan" };
const owner = { addedAt: null, addedVia: "PRODUCTS", addedBy: "Sam" };
const old = { addedAt: null, addedVia: null, addedBy: null };

test("plain words for where a row was made", () => {
  assert.equal(addedWords(lipa), "Lipa · POS · Juan");
  assert.equal(addedWords(owner), "Products · Sam");
  assert.equal(addedWords({ addedAt: null, addedVia: "IMPORT", addedBy: null }), "From Excel");
  assert.equal(addedWords(old), "Unknown");
  assert.equal(addedWords({}), "Unknown");
});

test("the Made at filter", () => {
  assert.deepEqual([lipa, owner, old].map((r) => matchesAddedAt(r, "")), [true, true, true]);
  assert.deepEqual([lipa, owner, old].map((r) => matchesAddedAt(r, "s3")), [true, false, false]);
  assert.deepEqual([lipa, owner, old].map((r) => matchesAddedAt(r, "none")), [false, true, false]);
  assert.deepEqual([lipa, owner, old].map((r) => matchesAddedAt(r, "unknown")), [false, false, true]);
  assert.deepEqual(addedStores([lipa, owner, { ...lipa, addedAt: { id: "s2", name: "Bahay Tindahan" } }, lipa]), [{ id: "s2", name: "Bahay Tindahan" }, { id: "s3", name: "Lipa" }]);
});

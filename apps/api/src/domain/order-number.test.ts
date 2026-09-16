import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOrderNumber, InvalidOrderSeqError } from "./order-number.js";

test("formats a store-scoped order number", () => {
  assert.equal(formatOrderNumber("sam-store", 1), "SAMSTO-000001");
});

test("pads sequences to six digits", () => {
  assert.equal(formatOrderNumber("sam-store", 42), "SAMSTO-000042");
  assert.equal(formatOrderNumber("sam-store", 999999), "SAMSTO-999999");
});

test("slug prefix is upper-cased and truncated to 6 chars", () => {
  assert.equal(formatOrderNumber("mega-hyper-store-name", 7), "MEGAHY-000007");
});

test("non-alphanumeric slug chars are stripped", () => {
  assert.equal(formatOrderNumber("sam's store!", 3), "SAMSST-000003");
});

test("rejects zero and negative sequence", () => {
  assert.throws(() => formatOrderNumber("sam-store", 0), InvalidOrderSeqError);
  assert.throws(() => formatOrderNumber("sam-store", -1), InvalidOrderSeqError);
});

test("rejects slug that produces an empty prefix", () => {
  assert.throws(() => formatOrderNumber("!!!", 1), InvalidOrderSeqError);
});
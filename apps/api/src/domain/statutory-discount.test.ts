import { test } from "node:test";
import assert from "node:assert/strict";
import { statutoryDiscountMinor, validateStatutoryClaim, normalizeStatutoryId } from "./statutory-discount.js";

test("statutory discount is 20% of the subtotal, floored", () => {
  assert.equal(statutoryDiscountMinor(10000), 2000); // ₱100 → ₱20
  assert.equal(statutoryDiscountMinor(15000), 3000); // ₱150 → ₱30
  assert.equal(statutoryDiscountMinor(105), 21); // ₱1.05 → ₱0.21 (floor)
  assert.equal(statutoryDiscountMinor(0), 0);
});

test("statutory discount rejects bad inputs", () => {
  assert.throws(() => statutoryDiscountMinor(-1));
  assert.throws(() => statutoryDiscountMinor(1.5));
});

test("validateStatutoryClaim accepts valid senior/pwd claims", () => {
  assert.deepEqual(validateStatutoryClaim({ statutoryType: "senior", statutoryId: "SC-123-456", statutoryName: "Maria Santos" }), []);
  assert.deepEqual(validateStatutoryClaim({ statutoryType: "pwd", statutoryId: "PWD12345", statutoryName: "Juan Dela Cruz" }), []);
});

test("validateStatutoryClaim rejects missing/invalid fields", () => {
  const badType = validateStatutoryClaim({ statutoryType: "student", statutoryId: "X123", statutoryName: "A B" });
  assert.ok(badType.length > 0 && badType.some((m) => /statutoryType/.test(m)));
  const badId = validateStatutoryClaim({ statutoryType: "senior", statutoryId: "ab", statutoryName: "Maria Santos" });
  assert.ok(badId.some((m) => /ID number/.test(m)));
  const badName = validateStatutoryClaim({ statutoryType: "senior", statutoryId: "SC123", statutoryName: "A" });
  assert.ok(badName.some((m) => /name/.test(m)));
});

test("normalizeStatutoryId trims + uppercases", () => {
  assert.equal(normalizeStatutoryId("  sc-123 "), "SC-123");
});
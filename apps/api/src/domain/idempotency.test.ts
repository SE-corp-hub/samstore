import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIdempotencyKey, InvalidIdempotencyKeyError } from "./idempotency.js";

test("same raw key maps to the same canonical key (retry-safe)", () => {
  const a = normalizeIdempotencyKey("order-123-abc");
  const b = normalizeIdempotencyKey("order-123-abc");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("surrounding whitespace is ignored", () => {
  assert.equal(
    normalizeIdempotencyKey("  order-123-abc  "),
    normalizeIdempotencyKey("order-123-abc"),
  );
});

test("different keys map to different canonical keys", () => {
  assert.notEqual(
    normalizeIdempotencyKey("order-123-abc"),
    normalizeIdempotencyKey("order-123-abd"),
  );
});

test("rejects empty and too-short keys", () => {
  assert.throws(() => normalizeIdempotencyKey(""), InvalidIdempotencyKeyError);
  assert.throws(() => normalizeIdempotencyKey("short"), InvalidIdempotencyKeyError);
  assert.throws(() => normalizeIdempotencyKey("   "), InvalidIdempotencyKeyError);
});

test("rejects keys longer than 128 characters", () => {
  assert.throws(
    () => normalizeIdempotencyKey("x".repeat(129)),
    InvalidIdempotencyKeyError,
  );
});
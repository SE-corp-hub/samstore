// Offline queue — which failures keep a waiting sale on the phone (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryableStatus, keepInQueue, MAX_SERVER_TRIES } from "./retryable.js";

test("queue: an expired login (401) keeps the sale, however many times", () => {
  assert.equal(keepInQueue(401, 0), true);
  assert.equal(keepInQueue(401, 10_000), true);
});

test("queue: a busy or down server (5xx, 408, 425, 429) keeps the sale", () => {
  for (const s of [500, 502, 503, 504, 408, 425, 429]) assert.equal(isRetryableStatus(s), true, String(s));
  assert.equal(keepInQueue(503, 0), true);
});

test("queue: a server that keeps failing stops blocking the steps behind it after a limit", () => {
  assert.equal(keepInQueue(500, MAX_SERVER_TRIES - 2), true);
  assert.equal(keepInQueue(500, MAX_SERVER_TRIES - 1), false);
});

test("queue: a clear refusal of the step itself is final (listed as not sent)", () => {
  for (const s of [400, 403, 404, 409, 422]) assert.equal(keepInQueue(s, 0), false, String(s));
});

test("queue: success and redirects are not retried", () => {
  for (const s of [200, 201, 204, 304]) assert.equal(isRetryableStatus(s), false, String(s));
});

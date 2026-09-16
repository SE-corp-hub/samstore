// Idempotency keys — the checkout retry barrier.
// Same raw key on retry must yield the same canonical key and the SAME order (no duplicates).
// Keys are HMAC-prefixed SHA-256, stored as the unique order idempotency_key.

import { createHash } from "node:crypto";

const KEY_PREFIX = "sam-store:checkout:v1:";

export class InvalidIdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdempotencyKeyError";
  }
}

export function normalizeIdempotencyKey(raw: string): string {
  if (typeof raw !== "string") {
    throw new InvalidIdempotencyKeyError("idempotencyKey must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 128) {
    throw new InvalidIdempotencyKeyError(
      "idempotencyKey must be between 8 and 128 characters",
    );
  }
  return createHash("sha256").update(KEY_PREFIX + trimmed).digest("hex");
}
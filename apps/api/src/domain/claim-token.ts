// Single-use signed order-claim tokens.
// A guest who checks out receives a token that can reopen their order.
// Structure: <orderId>.<base64url(HMAC-SHA256(orderId, secret))>
// Verified server-side; one successful verify marks it used (persistence layer enforces single-use).

import { createHmac, timingSafeEqual } from "node:crypto";

export class InvalidClaimTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClaimTokenError";
  }
}

export function signClaimToken(orderId: string, secret: string): string {
  if (!orderId || orderId.length < 1) {
    throw new InvalidClaimTokenError("orderId is required");
  }
  if (!secret || secret.length < 16) {
    throw new InvalidClaimTokenError("claim secret must be at least 16 characters");
  }
  const sig = createHmac("sha256", secret).update(orderId).digest("base64url");
  return `${orderId}.${sig}`;
}

/** Returns the orderId when the token is authentic; throws otherwise. */
export function verifyClaimToken(token: string, secret: string): string {
  if (typeof token !== "string" || !token.includes(".")) {
    throw new InvalidClaimTokenError("malformed claim token");
  }
  const [orderId, providedSig] = token.split(".");
  if (!orderId || !providedSig) {
    throw new InvalidClaimTokenError("malformed claim token");
  }
  const expected = createHmac("sha256", secret).update(orderId).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidClaimTokenError("invalid claim token signature");
  }
  return orderId;
}
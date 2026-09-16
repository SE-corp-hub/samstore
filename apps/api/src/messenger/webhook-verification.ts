// Meta webhook signature verification (X-Hub-Signature-256) — implementable and
// testable without any live Meta access. Per the master prompt: verification
// using the app secret, constant-time comparison, secrets from env only.

import { createHmac, timingSafeEqual } from "node:crypto";

export class InvalidSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "InvalidSignatureError";
  }
}

/** Verify a Meta `X-Hub-Signature-256` header against the raw body + app secret. */
export function verifyHubSignature(header: string | undefined, rawBody: string, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The standard Meta webhook GET challenge handshake. */
export function verifyWebhookChallenge(
  query: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string },
  verifyToken: string,
): string | null {
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === verifyToken && query["hub.challenge"]) {
    return query["hub.challenge"];
  }
  return null;
}
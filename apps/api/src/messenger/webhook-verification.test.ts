import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyHubSignature, verifyWebhookChallenge } from "./webhook-verification.js";

function makeSig(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("valid signature verifies (constant-time)", () => {
  assert.equal(verifyHubSignature(makeSig("app_secret_123", '{"object":"page"}'), '{"object":"page"}', "app_secret_123"), true);
});

test("tampered body fails", () => {
  const sig = makeSig("app_secret_123", '{"object":"page"}');
  assert.equal(verifyHubSignature(sig, '{"object":"page2"}', "app_secret_123"), false);
});

test("wrong secret fails", () => {
  const sig = makeSig("secretA", "body");
  assert.equal(verifyHubSignature(sig, "body", "secretB"), false);
});

test("missing or malformed header fails", () => {
  assert.equal(verifyHubSignature(undefined, "body", "secret"), false);
  assert.equal(verifyHubSignature("", "body", "secret"), false);
  assert.equal(verifyHubSignature("sha256=zzz", "body", "secret"), false);
});

test("webhook challenge handshake", () => {
  assert.equal(
    verifyWebhookChallenge({ "hub.mode": "subscribe", "hub.verify_token": "token", "hub.challenge": "12345" }, "token"),
    "12345",
  );
  assert.equal(verifyWebhookChallenge({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" }, "token"), null);
  assert.equal(verifyWebhookChallenge({}, "token"), null);
});
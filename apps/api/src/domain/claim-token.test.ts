import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signClaimToken,
  verifyClaimToken,
  InvalidClaimTokenError,
} from "./claim-token.js";

const SECRET = "test-claim-secret-0123456789";

test("sign then verify round-trips the order id", () => {
  const token = signClaimToken("order-42", SECRET);
  assert.equal(verifyClaimToken(token, SECRET), "order-42");
});

test("tampered token is rejected", () => {
  const token = signClaimToken("order-42", SECRET);
  const [id, sig] = token.split(".");
  const tampered = `${id}.${sig!.slice(0, -1)}${sig!.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifyClaimToken(tampered, SECRET), InvalidClaimTokenError);
});

test("token signed with a different secret is rejected", () => {
  const token = signClaimToken("order-42", SECRET);
  assert.throws(
    () => verifyClaimToken(token, "another-secret-0123456789"),
    InvalidClaimTokenError,
  );
});

test("malformed tokens are rejected", () => {
  assert.throws(() => verifyClaimToken("no-dot-here", SECRET), InvalidClaimTokenError);
  assert.throws(() => verifyClaimToken("", SECRET), InvalidClaimTokenError);
  assert.throws(() => verifyClaimToken("a.", SECRET), InvalidClaimTokenError);
});

test("short secret is rejected at signing time", () => {
  assert.throws(() => signClaimToken("order-42", "short"), InvalidClaimTokenError);
});
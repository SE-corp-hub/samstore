import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditService } from "./credit.service.js";

const svc = new CreditService();

test("approveCredit rejects negative limit", async () => {
  const r = await svc.approveCredit("s1", "sc1", -1, "a");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("approveCredit unknown customer → not_found", async () => {
  const r = await svc.approveCredit("s1", "nope", 1000, "a");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("checkCredit unknown customer → not ok", async () => {
  const r = await svc.checkCredit("s1", "nope", 100);
  assert.equal(r.ok, false);
});

test("recordPayment rejects non-positive", async () => {
  const r = await svc.recordPayment("s1", "sc1", 0, "x", "a");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("recordPayment unknown customer → not_found", async () => {
  const r = await svc.recordPayment("s1", "nope", 100, "x", "a", "data:image/png;base64,abc");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("recordPayment requires signature (v4)", async () => {
  for (const bad of [undefined, "", "   ", "not-an-image"]) {
    const r = await svc.recordPayment("s1", "sc1", 100, "x", "a", bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(JSON.stringify(r.error).includes("Signature is required"));
  }
});
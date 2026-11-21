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

test("the old credit pay door is gone: no service method clears credit without money", () => {
  assert.equal((svc as unknown as Record<string, unknown>).recordPayment, undefined);
});

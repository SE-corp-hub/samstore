import { test } from "node:test";
import assert from "node:assert/strict";
import { TeamService, INVITABLE_STORE_ROLES } from "./team.service.js";

const svc = new TeamService();

test("invitable roles are manager/staff/sales-agent/delivery", () => {
  assert.deepEqual([...INVITABLE_STORE_ROLES], ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"]);
});

test("invite rejects invalid email", async () => {
  const r = await svc.invite("cmtifdks2000094ic1j9w8th7", "not-an-email", null, "STAFF");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("invite rejects non-invitable role", async () => {
  const r = await svc.invite("cmtifdks2000094ic1j9w8th7", "x@y.com", null, "OWNER");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("invite rejects unknown store", async () => {
  const r = await svc.invite("store-does-not-exist", "x@y.com", null, "STAFF");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});
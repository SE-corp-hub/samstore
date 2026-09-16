import { test } from "node:test";
import assert from "node:assert/strict";
import { SuppliersService } from "./suppliers.service.js";

const svc = new SuppliersService();

test("create rejects short name", async () => {
  const r = await svc.create("s1", "A");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("upsertByName rejects empty name", async () => {
  const r = await svc.upsertByName("s1", "");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("upsertByName rejects short name", async () => {
  const r = await svc.upsertByName("s1", "X");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});
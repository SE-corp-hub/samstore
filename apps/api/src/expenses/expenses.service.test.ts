import { test } from "node:test";
import assert from "node:assert/strict";
import { ExpensesService } from "./expenses.service.js";

const svc = new ExpensesService();

test("create rejects invalid category", async () => {
  const r = await svc.create("s1", "a", { category: "bribery", amountMinor: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("create rejects non-positive amount", async () => {
  const r = await svc.create("s1", "a", { category: "rent", amountMinor: 0 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("remove unknown expense → not_found", async () => {
  const r = await svc.remove("s1", "nope");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});
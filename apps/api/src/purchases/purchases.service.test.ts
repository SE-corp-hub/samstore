import { test } from "node:test";
import assert from "node:assert/strict";
import { PurchasesService } from "./purchases.service.js";

const svc = new PurchasesService();

test("create rejects empty items", async () => {
  const r = await svc.create("s1", "a", { items: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("create rejects invalid quantity", async () => {
  const r = await svc.create("s1", "a", { items: [{ productId: "p", quantity: -1, costMinor: 100 }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("create rejects negative cost", async () => {
  const r = await svc.create("s1", "a", { items: [{ productId: "p", quantity: 1, costMinor: -5 }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("create rejects unknown product", async () => {
  const r = await svc.create("s1", "a", { items: [{ productId: "nope", quantity: 1, costMinor: 100 }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});
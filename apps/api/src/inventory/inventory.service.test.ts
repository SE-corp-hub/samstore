import { test } from "node:test";
import assert from "node:assert/strict";
import { InventoryService } from "./inventory.service.js";

const svc = new InventoryService();

test("inventory list rejects nothing server-side (filters optional)", async () => {
  const data = await svc.list("nope-store");
  assert.ok(Array.isArray(data.items));
  assert.equal(typeof data.totalValueMinor, "number");
});
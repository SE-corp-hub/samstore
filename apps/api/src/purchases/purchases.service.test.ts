import { test } from "node:test";
import assert from "node:assert/strict";
import { PURCHASES_CLOSED, PurchasesService } from "./purchases.service.js";

const svc = new PurchasesService();

// 2026-11-21: Purchases no longer adds stock (it always went to the main store). Stock in does, store by store.
test("recording a new purchase is refused with a plain answer, nothing is written", async () => {
  const r = await svc.create("s1", "a", { items: [{ productId: "p", quantity: 1, costMinor: 100 }] });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.type, "conflict");
    assert.equal((r.error as { message?: string }).message, PURCHASES_CLOSED);
  }
});

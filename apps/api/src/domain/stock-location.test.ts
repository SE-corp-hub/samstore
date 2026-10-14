// Rice Ops M1 — location rules for stock moves (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateRestore, effectivePrice, pickDeductionLevel, type LevelView } from "./stock-location.js";

const lv = (id: string, warehouseId: string | null, onHand: number, reserved = 0): LevelView => ({
  id, warehouseId, quantityOnHand: onHand, quantityReserved: reserved,
});

test("M1 location: a sale with no location given uses the store's default location", () => {
  const r = pickDeductionLevel([lv("s2", "S2", 50), lv("s1", "S1", 5)], 3, { defaultWarehouseId: "S1" });
  assert.equal(r.ok && r.level.id, "s1", "Store 1's sale takes Store 1's rice, not the first row found");
});

test("M1 location: an explicit location wins over the default", () => {
  const r = pickDeductionLevel([lv("s1", "S1", 5), lv("s2", "S2", 50)], 10, { warehouseId: "S2", defaultWarehouseId: "S1" });
  assert.equal(r.ok && r.level.id, "s2");
});

test("M1 location: never spreads silently — short here is an error that says what is elsewhere", () => {
  const r = pickDeductionLevel([lv("s1", "S1", 2), lv("s2", "S2", 50), lv("wh", "WH", 7, 7)], 5, { defaultWarehouseId: "S1" });
  assert.deepEqual(r, { ok: false, reason: "short", available: 2, elsewhere: 50 }, "WH's 7 are all reserved, so only S2's 50 count");
});

test("M1 location: reserved stock is not available", () => {
  const r = pickDeductionLevel([lv("s1", "S1", 10, 8)], 3, { defaultWarehouseId: "S1" });
  assert.deepEqual(r, { ok: false, reason: "short", available: 2, elsewhere: 0 });
  const ok = pickDeductionLevel([lv("s1", "S1", 10, 8)], 2, { defaultWarehouseId: "S1" });
  assert.equal(ok.ok, true);
});

test("M1 location: product with no row at the location vs. an untracked product", () => {
  assert.deepEqual(pickDeductionLevel([], 1, { defaultWarehouseId: "S1" }), { ok: false, reason: "untracked" });
  assert.deepEqual(
    pickDeductionLevel([lv("s2", "S2", 4)], 1, { defaultWarehouseId: "S1" }),
    { ok: false, reason: "no-stock-here", elsewhere: 4 },
  );
});

test("M1 location: legacy location-less row is used only when no location was asked for", () => {
  const legacy = [lv("old", null, 9)];
  const def = pickDeductionLevel(legacy, 1, { defaultWarehouseId: "S1" });
  assert.equal(def.ok && def.level.id, "old");
  const explicit = pickDeductionLevel(legacy, 1, { warehouseId: "S1", defaultWarehouseId: "S1" });
  assert.equal(explicit.ok, false);
});

test("M1 location: a void returns stock to the location it came from", () => {
  const taken = [
    { productId: "p", warehouseId: "S2", delta: -2 },
    { productId: "q", warehouseId: "S1", delta: -9 },
  ];
  assert.deepEqual(allocateRestore(taken, "p", 2, "S1"), [{ warehouseId: "S2", quantity: 2 }]);
});

test("M1 location: a restore split across two origins, earlier partial restores respected", () => {
  const taken = [
    { productId: "p", warehouseId: "S1", delta: -3 },
    { productId: "p", warehouseId: "S2", delta: -4 },
    { productId: "p", warehouseId: "S1", delta: 1 }, // one already given back to S1
  ];
  assert.deepEqual(allocateRestore(taken, "p", 6, "S1"), [
    { warehouseId: "S1", quantity: 2 },
    { warehouseId: "S2", quantity: 4 },
  ]);
});

test("M1 location: restoring more than the ledger shows sends the excess to the fallback", () => {
  assert.deepEqual(allocateRestore([], "p", 3, "S1"), [{ warehouseId: "S1", quantity: 3 }]);
  assert.deepEqual(
    allocateRestore([{ productId: "p", warehouseId: "S1", delta: -1 }], "p", 3, "S1"),
    [{ warehouseId: "S1", quantity: 3 }],
  );
  assert.deepEqual(allocateRestore([], "p", 0, "S1"), []);
});

test("M1 location: a location price overrides the main price; no row = main price", () => {
  assert.equal(effectivePrice(5_200, 5_400), 5_400);
  assert.equal(effectivePrice(5_200, null), 5_200);
  assert.equal(effectivePrice(5_200, undefined), 5_200);
});

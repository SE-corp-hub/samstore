import { test } from "node:test";
import assert from "node:assert/strict";
import { isLowShelf, lowShelves } from "./low-stock.js";

const at = (warehouseId: string, onHand: number, level: number, held = 0) => ({ warehouseId, quantityOnHand: onHand, quantityReserved: held, reorderThreshold: level });

test("a store is low on its own level, whatever the other stores hold", () => {
  // Bodega has 40, Lipa has 1 with a level of 3: Lipa is low (the old total check said "in stock").
  const rows = [at("WH", 40, 0), at("S3", 1, 3), at("S1", 10, 5)];
  assert.deepEqual(lowShelves(rows).map((r) => r.warehouseId), ["S3"]);
});

test("no level = never low; held for orders counts against what is free", () => {
  assert.equal(isLowShelf(at("S1", 0, 0)), false);
  assert.equal(isLowShelf(at("S1", 8, 5, 3)), true);
  assert.equal(isLowShelf(at("S1", 9, 5, 3)), false);
});

test("several low stores come emptiest first", () => {
  assert.deepEqual(lowShelves([at("S1", 4, 5), at("S2", 0, 2), at("S3", 2, 2)]).map((r) => r.warehouseId), ["S2", "S3", "S1"]);
});

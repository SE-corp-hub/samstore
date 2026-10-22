import test from "node:test";
import assert from "node:assert/strict";
import { lastCostByProduct, previousCost, priceMove, type CostRow } from "./price-watch.js";

const rows: CostRow[] = [
  { supplierId: "s1", productId: "p1", unitCostMinor: 5000, at: 100 },
  { supplierId: "s1", productId: "p1", unitCostMinor: 5200, at: 200 },
  { supplierId: "s1", productId: "p2", unitCostMinor: 900, at: 150 },
  { supplierId: "s2", productId: "p1", unitCostMinor: 4800, at: 300 },
];

test("no earlier cost means NEW", () => {
  assert.equal(priceMove(null, 5000).kind, "NEW");
  assert.equal(priceMove(undefined, 5000).big, false);
  assert.equal(priceMove(0, 5000).kind, "NEW");
});

test("same cost is SAME", () => {
  const m = priceMove(5000, 5000);
  assert.equal(m.kind, "SAME");
  assert.equal(m.changeMinor, 0);
  assert.equal(m.pct, 0);
});

test("higher and lower costs show the change and the percent", () => {
  const up = priceMove(5000, 5250);
  assert.deepEqual([up.kind, up.changeMinor, up.pct, up.big], ["UP", 250, 5, true]);
  const down = priceMove(5000, 4900);
  assert.deepEqual([down.kind, down.changeMinor, down.pct, down.big], ["DOWN", -100, -2, false]);
});

test("a move under 5% is not flagged as big, 5% and over is", () => {
  assert.equal(priceMove(10000, 10499).big, false);
  assert.equal(priceMove(10000, 10500).big, true);
  assert.equal(priceMove(10000, 9500).big, true);
});

test("the percent keeps one decimal", () => {
  assert.equal(priceMove(3000, 3100).pct, 3.3);
});

test("last cost per product is the newest one from that supplier only", () => {
  const m = lastCostByProduct(rows, "s1");
  assert.equal(m.get("p1")?.unitCostMinor, 5200);
  assert.equal(m.get("p2")?.unitCostMinor, 900);
  assert.equal(m.size, 2);
  assert.equal(lastCostByProduct(rows, "s2").get("p1")?.unitCostMinor, 4800);
  assert.equal(lastCostByProduct(rows, "nobody").size, 0);
});

test("'before' ignores the order itself and anything later", () => {
  assert.equal(lastCostByProduct(rows, "s1", 200).get("p1")?.unitCostMinor, 5000);
  assert.equal(lastCostByProduct(rows, "s1", 100).has("p1"), false);
});

test("previousCost finds the earlier order of the same item from the same supplier", () => {
  assert.equal(previousCost(rows, "s1", "p1", 200), 5000);
  assert.equal(previousCost(rows, "s1", "p1", 1000), 5200);
  assert.equal(previousCost(rows, "s1", "p1", 100), null);
  assert.equal(previousCost(rows, "s2", "p2", 1000), null);
});

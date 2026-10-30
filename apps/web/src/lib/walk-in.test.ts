import { test } from "node:test";
import assert from "node:assert/strict";
import { bestSellers, lineTotal, type WalkInItem } from "./walk-in";

test("a sack line is pieces × price", () => {
  assert.equal(lineTotal({ loose: false, priceMinor: 135_000 }, 3), 405_000);
});

test("loose rice rounds half a centavo up, like the server", () => {
  assert.equal(lineTotal({ loose: true, priceMinor: 5_200 }, 1000), 5_200);
  assert.equal(lineTotal({ loose: true, priceMinor: 5_250 }, 500), 2_625);
  assert.equal(lineTotal({ loose: true, priceMinor: 5_201 }, 500), 2_601); // 2600.5 → 2601
});

test("best sellers: most tapped first, then the fullest shelves here", () => {
  const items: WalkInItem[] = [
    { id: "a", loose: false, priceMinor: 1, stock: { s1: 1 } },
    { id: "b", loose: false, priceMinor: 1, stock: { s1: 50 } },
    { id: "c", loose: false, priceMinor: 1, stock: { s1: 9, s2: 99 } },
    { id: "d", loose: false, priceMinor: 1, stock: {} },
  ];
  assert.deepEqual(bestSellers(items, ["a", "gone"], "s1", 3).map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(bestSellers(items, [], "s2", 2).map((i) => i.id), ["c", "a"]);
});

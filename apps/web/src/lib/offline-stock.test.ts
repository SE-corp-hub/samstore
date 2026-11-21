import { test } from "node:test";
import assert from "node:assert/strict";
import { takeOffShelf } from "./offline-stock";

test("an offline sale takes its sacks and kilos off this tablet's shelf numbers", () => {
  const items: { id: string; stock: Record<string, number> }[] = [
    { id: "sack", stock: { s1: 5, s2: 3 } },
    { id: "kilo", stock: { s1: 2_500 } },
    { id: "other", stock: { s1: 1 } },
  ];
  const after = takeOffShelf(items, [
    { productId: "sack", units: 2, at: "s1" },
    { productId: "sack", units: 1, at: "s2" },
    { productId: "kilo", units: 1_500, at: "s1" },
  ]);
  assert.deepEqual(after.map((i) => i.stock), [{ s1: 3, s2: 2 }, { s1: 1_000 }, { s1: 1 }]);
  assert.equal(after[2], items[2], "untouched items stay the same object");
  assert.deepEqual(items[0]!.stock, { s1: 5, s2: 3 }, "the old list is not changed");
});

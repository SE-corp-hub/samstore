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

test("sales and opened sacks still waiting on the tablet come off the store they were made at", async () => {
  const { waitingShelf } = await import("./offline-stock");
  const items: { id: string; stock: Record<string, number>; priceMinor: number; gramsPerUnit?: number; loose?: boolean }[] = [
    { id: "sack", stock: { s1: 5, s2: 3 }, priceMinor: 130_000, gramsPerUnit: 25_000 },
    { id: "kilo", stock: { s1: 2_000 }, priceMinor: 5_000, loose: true },
  ];
  const steps = [
    { path: "/admin/benta", body: { locationId: "s1", lines: [{ productId: "sack", quantity: 2 }, { productId: "sack", quantity: 1, sourceLocationId: "s2" }, { productId: "kilo", kilos: "0.5" }, { productId: "kilo", amountMinor: 10_000 }] } },
    { path: "/admin/resacks/open-for-kilos", body: { locationId: "s1", kiloProductId: "kilo", sackProductId: "sack", sacks: 1 } },
    { path: "/admin/moves", body: { fromLocationId: "s1", toLocationId: "s2", productId: "sack", quantity: 1 } },
  ];
  const after = takeOffShelf(items, waitingShelf(steps, items));
  assert.deepEqual(after.map((i) => i.stock), [{ s1: 2, s2: 2 }, { s1: 2_000 - 500 - 2_000 + 25_000 }]);
});

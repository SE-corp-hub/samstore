import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeOrderItems, OPEN_ITEM_STATUSES } from "./order-items-summary.js";

const o = (id: string, status: string, createdAt = "2026-11-11T01:00:00.000Z") => ({ id, orderNumber: `N-${id}`, customerName: `C${id}`, status, createdAt });

test("items add up per product and per stage; cancelled items never count as still to give", () => {
  const { products, totals } = summarizeOrderItems([
    { productId: "alsa", productName: "Alsa 25kg", quantity: 2, order: o("1", "RECEIVED") },
    { productId: "alsa", productName: "Alsa 25kg", quantity: 1, order: o("2", "OUT_FOR_DELIVERY") },
    { productId: "alsa", productName: "Alsa 25kg", quantity: 3, order: o("3", "COMPLETED") },
    { productId: "alsa", productName: "Alsa 25kg", quantity: 4, order: o("4", "CANCELLED") },
    { productId: "aroma", productName: "Aroma 5kg", quantity: 5, order: o("5", "ON_HOLD") },
    { productId: "aroma", productName: "Aroma 5kg", quantity: 1, order: o("5", "ON_HOLD") },
  ]);
  const alsa = products.find((p) => p.productId === "alsa")!;
  assert.deepEqual(alsa.stages, { toReceive: 2, inProgress: 0, outForDelivery: 1, done: 3, void: 4 });
  assert.equal(alsa.toGive, 3);
  const aroma = products.find((p) => p.productId === "aroma")!;
  assert.equal(aroma.stages.inProgress, 6);
  assert.equal(aroma.orders.length, 1, "two lines of one order show as one order");
  assert.equal(aroma.orders[0]!.quantity, 6);
  assert.equal(products[0]!.productId, "aroma", "most still to give first");
  assert.deepEqual(totals, { toReceive: 2, inProgress: 6, outForDelivery: 1, done: 3, void: 4, toGive: 9 });
  assert.deepEqual(alsa.orders.map((x) => x.id), ["1", "2", "3", "4"], "open stages first");
});

test("open statuses are the three still-to-give stages", () => {
  assert.deepEqual([...OPEN_ITEM_STATUSES].sort(), ["CONFIRMED", "ON_HOLD", "OUT_FOR_DELIVERY", "PREPARING", "READY", "RECEIVED"]);
});

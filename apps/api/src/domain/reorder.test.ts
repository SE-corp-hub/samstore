import test from "node:test";
import assert from "node:assert/strict";
import { byUrgency, reorderAdvice } from "./reorder.js";

test("nothing sold lately: no advice", () => {
  const a = reorderAdvice({ available: 0, perDay: 0, onOrder: 0, loose: false });
  assert.deepEqual(a, { daysLeft: null, urgency: null, suggested: 0 });
});

test("plenty left: not listed", () => {
  const a = reorderAdvice({ available: 100, perDay: 5, onOrder: 0, loose: false });
  assert.equal(a.urgency, null);
  assert.equal(a.daysLeft, 20);
  assert.equal(a.suggested, 0);
});

test("out of stock but selling: OUT, enough for 2 weeks", () => {
  const a = reorderAdvice({ available: 0, perDay: 4, onOrder: 0, loose: false });
  assert.equal(a.urgency, "OUT");
  assert.equal(a.suggested, 56);
});

test("negative stock counts as none", () => {
  const a = reorderAdvice({ available: -3, perDay: 2, onOrder: 0, loose: false });
  assert.equal(a.urgency, "OUT");
  assert.equal(a.suggested, 28);
});

test("under 3 days left is NOW, 3 to 7 days is SOON", () => {
  assert.equal(reorderAdvice({ available: 8, perDay: 4, onOrder: 0, loose: false }).urgency, "NOW");
  assert.equal(reorderAdvice({ available: 12, perDay: 4, onOrder: 0, loose: false }).urgency, "SOON");
  assert.equal(reorderAdvice({ available: 28, perDay: 4, onOrder: 0, loose: false }).urgency, null);
});

test("what is already on order is taken off, and can cover the item completely", () => {
  const part = reorderAdvice({ available: 8, perDay: 4, onOrder: 10, loose: false });
  assert.equal(part.urgency, "NOW");
  assert.equal(part.suggested, 56 - 8 - 10);
  const covered = reorderAdvice({ available: 8, perDay: 4, onOrder: 30, loose: false });
  assert.equal(covered.urgency, null);
  assert.equal(covered.suggested, 0);
});

test("loose rice is in grams and suggested in whole kilos", () => {
  // sells 12.5 kg a day, 20 kg left
  const a = reorderAdvice({ available: 20_000, perDay: 12_500, onOrder: 0, loose: true });
  assert.equal(a.urgency, "NOW");
  assert.equal(a.daysLeft, 1.6);
  assert.equal(a.suggested, 155_000);
  assert.equal(a.suggested % 1000, 0);
});

test("an order that nearly covers it still leaves a small suggestion", () => {
  const a = reorderAdvice({ available: 5, perDay: 1, onOrder: 1, loose: false });
  assert.equal(a.urgency, "SOON");
  assert.equal(a.suggested, 8);
});

test("sorted: OUT first, then NOW, then SOON, fewest days first", () => {
  const rows = [
    { name: "C", urgency: "SOON" as const, daysLeft: 5 },
    { name: "B", urgency: "NOW" as const, daysLeft: 2 },
    { name: "A", urgency: "OUT" as const, daysLeft: 0 },
    { name: "D", urgency: "NOW" as const, daysLeft: 1 },
  ];
  assert.deepEqual(rows.sort(byUrgency).map((r) => r.name), ["A", "D", "B", "C"]);
});

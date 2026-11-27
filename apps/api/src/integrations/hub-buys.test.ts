import { test } from "node:test";
import assert from "node:assert/strict";
import { RECENT_DAYS, RECENT_MAX, summariseBuys, type BuyOrder } from "./hub-buys.js";

const order = (day: string, over: Partial<BuyOrder> = {}): BuyOrder => ({
  status: "COMPLETED",
  totalMinor: 130000,
  createdAt: new Date(`${day}T03:00:00Z`),
  occurredAt: null,
  location: "S1",
  items: [{ productName: "Dinorado 25kg", quantity: 1, soldBy: "PIECE", grams: null }],
  ...over,
});
const now = new Date("2026-11-27T00:00:00Z");

test("a customer's line, one part per location: how many times, first and last, paid, purchases and top items", () => {
  const got = summariseBuys(
    "sc1",
    new Date("2026-11-26T05:00:00Z"),
    [
      order("2026-11-20"),
      order("2026-10-01", { occurredAt: new Date("2026-09-30T23:00:00Z"), location: "S3" }),
      order("2026-11-25", { status: "RECEIVED", totalMinor: 290000, items: [{ productName: "Dinorado 25kg", quantity: 2, soldBy: "PIECE", grams: null }] }),
      order("2026-11-10", { items: [{ productName: "Dinorado · per kilo", quantity: 3000, soldBy: "KILO", grams: 3000 }], totalMinor: 18600 }),
      order("2026-11-11", { location: null }),
    ],
    now,
  );
  assert.equal(got.id, "sc1");
  assert.equal(got.changedAt, "2026-11-26T05:00:00.000Z");
  assert.deepEqual(got.places.map((p) => [p.location, p.orders, p.paidOrders]), [["", 1, 1], ["S1", 3, 2], ["S3", 1, 1]], "by location code");
  const s1 = got.places[1];
  assert.ok(s1);
  assert.equal(s1.firstAt, "2026-11-10T03:00:00.000Z");
  assert.equal(s1.lastAt, "2026-11-25T03:00:00.000Z");
  assert.equal(s1.spentMinor, 130000 + 18600, "an order not yet handed over is bought, not paid");
  assert.deepEqual(
    s1.recent.map((r) => [r.at.slice(0, 10), r.totalMinor, r.done]),
    [
      ["2026-11-10", 18600, true],
      ["2026-11-20", 130000, true],
      ["2026-11-25", 290000, false],
    ],
    "oldest first",
  );
  assert.deepEqual(s1.items, [
    { name: "Dinorado 25kg", kilo: false, total: 3, orders: 2 },
    { name: "Dinorado · per kilo", kilo: true, total: 3000, orders: 1 },
  ]);
  assert.equal(got.places[2]?.firstAt, "2026-09-30T23:00:00.000Z", "a paper slip counts on the day it really happened");
});

test("only the last 180 days of purchases travel (at most 300); a customer with no orders has no places", () => {
  const days = Array.from({ length: 200 }, (_, i) => order(new Date(now.getTime() - (i + 1) * 86_400_000).toISOString().slice(0, 10)));
  const got = summariseBuys("sc2", now, days, now);
  const p = got.places[0];
  assert.ok(p);
  assert.equal(p.orders, 200);
  assert.equal(p.recent.length, RECENT_DAYS, "one a day: the last 180 days");
  const many = Array.from({ length: RECENT_MAX + 20 }, (_, i) => order("2026-11-01", { createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)) }));
  const lots = summariseBuys("sc3", now, many, now).places[0];
  assert.equal(lots?.recent.length, RECENT_MAX);
  assert.equal(lots?.recent[0]?.at, new Date(Date.UTC(2026, 10, 1, 0, 20)).toISOString(), "the latest ones");
  assert.deepEqual(summariseBuys("sc4", now, [], now).places, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsEarned, pointsEarnedFor, redeemDiscountMinor, isRedeemable, pointsForDiscountMinor, expirablePoints } from "./loyalty.js";

test("points earned: 1 point per peso", () => {
  assert.equal(pointsEarned(18000), 180); // ₱180 → 180 pts
  assert.equal(pointsEarned(12000), 120);
  assert.equal(pointsEarned(0), 0);
  assert.equal(pointsEarned(-5), 0);
  assert.equal(pointsEarned(199), 1); // ₱1.99 → 1 pt
});

test("redeem: 100 points = ₱1 (100 minor)", () => {
  assert.equal(redeemDiscountMinor(100), 100);
  assert.equal(redeemDiscountMinor(250), 200);
  assert.equal(redeemDiscountMinor(50), 0); // not enough
  assert.equal(redeemDiscountMinor(0), 0);
  assert.equal(redeemDiscountMinor(-10), 0);
});

test("isRedeemable", () => {
  assert.equal(isRedeemable(100), true);
  assert.equal(isRedeemable(50), false);
});

test("pointsForDiscountMinor rounds up to 100-block", () => {
  assert.equal(pointsForDiscountMinor(100), 100);
  assert.equal(pointsForDiscountMinor(200), 200);
  assert.equal(pointsForDiscountMinor(150), 200);
  assert.equal(pointsForDiscountMinor(0), 0);
});

// P3h — configurable rate + FIFO expiry
test("pointsEarnedFor uses the store's rate", () => {
  assert.equal(pointsEarnedFor(18000, 1), 180);
  assert.equal(pointsEarnedFor(18000, 2), 360); // 2 pts per ₱1
  assert.equal(pointsEarnedFor(18000, 5), 900);
  assert.equal(pointsEarnedFor(199, 2), 3); // ₱1.99 → floor(1.99×2) = 3 pts
  assert.equal(pointsEarnedFor(18000, 0), 0); // invalid rate → no earn
  assert.equal(pointsEarnedFor(-5, 1), 0);
});

test("expirablePoints: FIFO — redemptions consume the oldest points first", () => {
  const now = Date.now();
  const old = (days: number) => new Date(now - days * 86_400_000);
  const cutoff = old(30);
  const entries = [
    { type: "EARN", points: 100, createdAt: old(60) }, // aged, unconsumed
    { type: "EARN", points: 50, createdAt: old(10) }, // fresh
    { type: "REDEEM", points: -30, createdAt: old(5) }, // consumes aged first
  ];
  // aged 100 → 30 redeemed → 70 aged remains expirable.
  assert.equal(expirablePoints(entries, cutoff), 70);
});

test("expirablePoints: a big redemption can consume all aged points", () => {
  const now = Date.now();
  const old = (days: number) => new Date(now - days * 86_400_000);
  const cutoff = old(30);
  const entries = [
    { type: "EARN", points: 100, createdAt: old(60) },
    { type: "REDEEM", points: -120, createdAt: old(5) }, // eats 100 aged + 20 fresh
  ];
  assert.equal(expirablePoints(entries, cutoff), 0);
});

test("expirablePoints: nothing older than cutoff → nothing expirable", () => {
  const now = Date.now();
  const old = (days: number) => new Date(now - days * 86_400_000);
  const cutoff = old(30);
  const entries = [
    { type: "EARN", points: 200, createdAt: old(10) },
  ];
  assert.equal(expirablePoints(entries, cutoff), 0);
});

test("expirablePoints: never more than what is on the balance", () => {
  const now = Date.now();
  const old = (days: number) => new Date(now - days * 86_400_000);
  const cutoff = old(30);
  const entries = [
    { type: "EARN", points: 100, createdAt: old(60) },
    { type: "EARN", points: 40, createdAt: old(50) },
    { type: "REDEEM", points: -100, createdAt: old(20) }, // 140 aged → 100 consumed → 40 left
  ];
  assert.equal(expirablePoints(entries, cutoff), 40);
});
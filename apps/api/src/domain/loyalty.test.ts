import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsEarned, redeemDiscountMinor, isRedeemable, pointsForDiscountMinor } from "./loyalty.js";

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
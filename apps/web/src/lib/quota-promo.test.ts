import { test } from "node:test";
import assert from "node:assert/strict";
import { promoFrom, promoPrices, promoSacks, type PromoLine } from "./quota-promo";

const promo = { on: true, minSacks: 10, offMinor: 2000, categoryIds: ["local", "premium"] };
const line = (over: Partial<PromoLine>): PromoLine => ({ categoryId: "local", isSack: true, quantity: 1, listMinor: 115_000, manualPrice: false, ...over });

test("10 sacks of Local and Premium together: each is ₱20 cheaper", () => {
  const lines = [line({ quantity: 6 }), line({ categoryId: "premium", quantity: 4, listMinor: 140_000 }), line({ categoryId: "imported", quantity: 3 })];
  assert.equal(promoSacks(lines, promo), 10);
  assert.deepEqual(promoPrices(lines, promo), [113_000, 138_000, null]);
});

test("9 sacks: no promo; loose rice, typed prices and other groups do not count", () => {
  const lines = [line({ quantity: 9 }), line({ isSack: false, quantity: 5 }), line({ manualPrice: true, quantity: 5 }), line({ categoryId: "special", quantity: 5 })];
  assert.equal(promoSacks(lines, promo), 9);
  assert.deepEqual(promoPrices(lines, promo), [null, null, null, null]);
});

test("switched off in Settings: nothing changes", () => {
  assert.deepEqual(promoPrices([line({ quantity: 20 })], { ...promo, on: false }), [null]);
});

test("settings become a promo; odd values fall back to 10 sacks and ₱20", () => {
  assert.deepEqual(promoFrom({ quotaPromoEnabled: true, quotaPromoMinSacks: 0, quotaPromoCategoryIds: ["a"] }), { on: true, minSacks: 10, offMinor: 2000, categoryIds: ["a"] });
  assert.equal(promoFrom(null).on, false);
});

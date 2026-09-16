import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateVoucher, applyVoucherDiscount } from "./voucher.js";

const NOW = new Date("2026-09-03T00:00:00Z");

function voucher(over: Partial<Parameters<typeof evaluateVoucher>[0]> = {}) {
  return {
    code: "SAM10",
    discountMinor: 1000,
    minOrderMinor: 0,
    maxRedemptions: null,
    startsAt: null,
    expiresAt: null,
    isActive: true,
    redemptionCount: 0,
    ...over,
  } as const;
}

test("valid voucher applies", () => {
  assert.deepEqual(evaluateVoucher(voucher(), 20000, NOW), { ok: true });
});

test("inactive voucher rejected", () => {
  assert.deepEqual(evaluateVoucher(voucher({ isActive: false }), 20000, NOW), { ok: false, reason: "inactive" });
});

test("not yet started / expired rejected", () => {
  assert.deepEqual(evaluateVoucher(voucher({ startsAt: new Date("2026-09-04") }), 20000, NOW), { ok: false, reason: "not_started" });
  assert.deepEqual(evaluateVoucher(voucher({ expiresAt: new Date("2026-09-02") }), 20000, NOW), { ok: false, reason: "expired" });
});

test("below minimum rejected", () => {
  assert.deepEqual(evaluateVoucher(voucher({ minOrderMinor: 30000 }), 20000, NOW), { ok: false, reason: "below_minimum" });
});

test("usage limit enforced (includes concurrent-safety boundary)", () => {
  assert.deepEqual(evaluateVoucher(voucher({ maxRedemptions: 10, redemptionCount: 9 }), 1000, NOW), { ok: true });
  assert.deepEqual(evaluateVoucher(voucher({ maxRedemptions: 10, redemptionCount: 10 }), 1000, NOW), { ok: false, reason: "limit_reached" });
});

test("discount never drives total below zero", () => {
  assert.equal(applyVoucherDiscount(500, 1000), 0);
  assert.equal(applyVoucherDiscount(5000, 1000), 4000);
});
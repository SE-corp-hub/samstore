import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateVoucher,
  computeVoucherDiscount,
  applyVoucherDiscount,
  type VoucherSnapshot,
  type VoucherContext,
} from "./voucher.js";

const NOW = new Date("2026-09-03T00:00:00Z");

function voucher(over: Partial<VoucherSnapshot> = {}): VoucherSnapshot {
  return {
    code: "SAM10",
    discountMinor: 1000,
    minOrderMinor: 0,
    maxRedemptions: null,
    startsAt: null,
    expiresAt: null,
    isActive: true,
    redemptionCount: 0,
    type: "fixed",
    percentBp: null,
    firstOrderOnly: false,
    perCustomerLimit: null,
    scopeType: "all",
    scopeRefId: null,
    stackable: false,
    ...over,
  };
}

function ctx(over: Partial<VoucherContext> = {}): VoucherContext {
  return {
    subtotalMinor: 20000,
    orderTotalMinor: 25000,
    deliveryFeeMinor: 5000,
    storeCustomerId: null,
    isFirstOrder: null,
    customerRedemptionCount: 0,
    productIds: [],
    categoryIds: [],
    ...over,
  };
}

test("valid voucher applies", () => {
  assert.deepEqual(evaluateVoucher(voucher(), ctx(), NOW), { ok: true });
});

test("inactive voucher rejected", () => {
  assert.deepEqual(evaluateVoucher(voucher({ isActive: false }), ctx(), NOW), { ok: false, reason: "inactive" });
});

test("not yet started / expired rejected", () => {
  assert.deepEqual(evaluateVoucher(voucher({ startsAt: new Date("2026-09-04") }), ctx(), NOW), { ok: false, reason: "not_started" });
  assert.deepEqual(evaluateVoucher(voucher({ expiresAt: new Date("2026-09-02") }), ctx(), NOW), { ok: false, reason: "expired" });
});

test("below minimum rejected", () => {
  assert.deepEqual(evaluateVoucher(voucher({ minOrderMinor: 30000 }), ctx(), NOW), { ok: false, reason: "below_minimum" });
});

test("usage limit enforced (includes concurrent-safety boundary)", () => {
  assert.deepEqual(evaluateVoucher(voucher({ maxRedemptions: 10, redemptionCount: 9 }), ctx(), NOW), { ok: true });
  assert.deepEqual(evaluateVoucher(voucher({ maxRedemptions: 10, redemptionCount: 10 }), ctx(), NOW), { ok: false, reason: "limit_reached" });
});

test("first-order-only: guests and repeat customers rejected, first-timer allowed", () => {
  const v = voucher({ firstOrderOnly: true });
  assert.deepEqual(evaluateVoucher(v, ctx({ storeCustomerId: null, isFirstOrder: null }), NOW), { ok: false, reason: "first_order_only" });
  assert.deepEqual(evaluateVoucher(v, ctx({ storeCustomerId: "sc1", isFirstOrder: false }), NOW), { ok: false, reason: "first_order_only" });
  assert.deepEqual(evaluateVoucher(v, ctx({ storeCustomerId: "sc1", isFirstOrder: true }), NOW), { ok: true });
});

test("per-customer limit enforced", () => {
  const v = voucher({ perCustomerLimit: 2 });
  assert.deepEqual(evaluateVoucher(v, ctx({ storeCustomerId: "sc1", customerRedemptionCount: 1 }), NOW), { ok: true });
  assert.deepEqual(evaluateVoucher(v, ctx({ storeCustomerId: "sc1", customerRedemptionCount: 2 }), NOW), { ok: false, reason: "per_customer_limit" });
});

test("product scope requires the product in the cart", () => {
  const v = voucher({ scopeType: "product", scopeRefId: "prod-1" });
  assert.deepEqual(evaluateVoucher(v, ctx({ productIds: ["prod-2"] }), NOW), { ok: false, reason: "scope_mismatch" });
  assert.deepEqual(evaluateVoucher(v, ctx({ productIds: ["prod-1", "prod-2"] }), NOW), { ok: true });
});

test("category scope requires a matching category", () => {
  const v = voucher({ scopeType: "category", scopeRefId: "cat-9" });
  assert.deepEqual(evaluateVoucher(v, ctx({ categoryIds: ["cat-1"] }), NOW), { ok: false, reason: "scope_mismatch" });
  assert.deepEqual(evaluateVoucher(v, ctx({ categoryIds: ["cat-9"] }), NOW), { ok: true });
});

test("free-delivery voucher needs a delivery fee (pickup rejected)", () => {
  const v = voucher({ type: "free_delivery", discountMinor: 0 });
  assert.deepEqual(evaluateVoucher(v, ctx({ deliveryFeeMinor: 5000 }), NOW), { ok: true });
  assert.deepEqual(evaluateVoucher(v, ctx({ deliveryFeeMinor: 0 }), NOW), { ok: false, reason: "no_delivery_fee" });
});

test("computeVoucherDiscount: fixed / percent / free-delivery", () => {
  assert.equal(computeVoucherDiscount(voucher({ type: "fixed", discountMinor: 1500 }), ctx()), 1500);
  // 10% of the 20000 subtotal
  assert.equal(computeVoucherDiscount(voucher({ type: "percent", percentBp: 1000, discountMinor: 0 }), ctx()), 2000);
  // percent never exceeds the subtotal
  assert.equal(computeVoucherDiscount(voucher({ type: "percent", percentBp: 10000, discountMinor: 0 }), ctx()), 20000);
  // free delivery = the fee
  assert.equal(computeVoucherDiscount(voucher({ type: "free_delivery", discountMinor: 0 }), ctx({ deliveryFeeMinor: 5000 })), 5000);
  // fixed never exceeds the order total
  assert.equal(computeVoucherDiscount(voucher({ type: "fixed", discountMinor: 999999 }), ctx()), 25000);
});

test("discount never drives total below zero", () => {
  assert.equal(applyVoucherDiscount(500, 1000), 0);
  assert.equal(applyVoucherDiscount(5000, 1000), 4000);
});
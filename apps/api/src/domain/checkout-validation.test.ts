import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCheckoutInput } from "./checkout-validation.js";
import type { CheckoutRequest } from "@sam-store/contracts";

const VALID: CheckoutRequest = {
  cartToken: "cart-token-123",
  customerName: "Sam Buyer",
  customerPhone: "+60123456789",
  deliveryAddressLine1: "12 Jalan Merdeka",
  landmark: "Near the masjid",
  deliverySchedule: "Tomorrow 2pm-5pm",
  notes: "Please call on arrival",
  paymentMethod: "cod",
  idempotencyKey: "checkout-abc-123",
};

test("valid checkout input passes", () => {
  assert.deepEqual(validateCheckoutInput(VALID), { ok: true });
});

test("missing name fails", () => {
  const r = validateCheckoutInput({ ...VALID, customerName: "A" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("customerName")));
});

test("invalid phone fails", () => {
  const r = validateCheckoutInput({ ...VALID, customerPhone: "not-a-phone!!!" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("customerPhone")));
});

test("too-short address fails", () => {
  const r = validateCheckoutInput({ ...VALID, deliveryAddressLine1: "No 1" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("deliveryAddressLine1")));
});

test("non-COD payment method is rejected (slice scope)", () => {
  const r = validateCheckoutInput({
    ...VALID,
    paymentMethod: "card" as CheckoutRequest["paymentMethod"],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("paymentMethod")));
});

test("missing idempotency key fails", () => {
  const r = validateCheckoutInput({ ...VALID, idempotencyKey: "short" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("idempotencyKey")));
});

test("missing cart token fails", () => {
  const r = validateCheckoutInput({ ...VALID, cartToken: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("cartToken")));
});

test("over-long notes fail", () => {
  const r = validateCheckoutInput({ ...VALID, notes: "x".repeat(501) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("notes")));
});

test("multiple failures are all reported", () => {
  const r = validateCheckoutInput({
    ...VALID,
    customerName: "A",
    customerPhone: "bad",
    paymentMethod: "card" as CheckoutRequest["paymentMethod"],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.length >= 3);
});
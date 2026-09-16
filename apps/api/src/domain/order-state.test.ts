import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  assertTransition,
  isTerminal,
  requiresReason,
  paymentEffectFor,
  InvalidTransitionError,
} from "./order-state.js";

test("forward transitions are allowed", () => {
  assert.equal(canTransition("RECEIVED", "CONFIRMED"), true);
  assert.equal(canTransition("CONFIRMED", "PREPARING"), true);
  assert.equal(canTransition("PREPARING", "READY"), true);
  assert.equal(canTransition("READY", "OUT_FOR_DELIVERY"), true);
  assert.equal(canTransition("OUT_FOR_DELIVERY", "DELIVERED"), true);
});

test("ready-for-pickup step: CONFIRMED→READY, READY→COMPLETED (pickup), READY→OUT_FOR_DELIVERY (delivery)", () => {
  assert.equal(canTransition("CONFIRMED", "READY"), true);
  assert.equal(canTransition("READY", "COMPLETED"), true);
  assert.equal(canTransition("READY", "OUT_FOR_DELIVERY"), true);
  // Delivery invariant: READY→COMPLETED is allowed at state level but guarded server-side for delivery-type orders.
  assert.equal(canTransition("COMPLETED", "READY"), false);
});

test("skipping states is rejected", () => {
  assert.equal(canTransition("RECEIVED", "DELIVERED"), false);
  assert.equal(canTransition("RECEIVED", "OUT_FOR_DELIVERY"), false);
});

test("backwards transitions are rejected", () => {
  assert.equal(canTransition("DELIVERED", "READY"), false);
  assert.equal(canTransition("CONFIRMED", "RECEIVED"), false);
});

test("terminal states have no transitions", () => {
  assert.equal(isTerminal("DELIVERED"), true);
  assert.equal(isTerminal("COMPLETED"), true);
  assert.equal(isTerminal("CANCELLED"), true);
  assert.equal(isTerminal("RECEIVED"), false);
  assert.equal(isTerminal("ON_HOLD"), false);
});

test("ON_HOLD (POS) transitions: only complete or cancel", () => {
  assert.equal(canTransition("ON_HOLD", "COMPLETED"), true);
  assert.equal(canTransition("ON_HOLD", "CANCELLED"), true);
  assert.equal(canTransition("ON_HOLD", "PREPARING"), false);
  assert.equal(canTransition("RECEIVED", "ON_HOLD"), true);
});

test("payment effect for completed POS sale", () => {
  assert.equal(paymentEffectFor("DELIVERED", "PENDING"), "COLLECTED");
  assert.equal(paymentEffectFor("COMPLETED", "PENDING"), "COLLECTED");
  assert.equal(paymentEffectFor("CANCELLED", "COLLECTED"), "CANCELLED_REFUND");
});

test("cancellation and failed delivery require a reason", () => {
  assert.equal(requiresReason("CANCELLED"), true);
  assert.equal(requiresReason("FAILED_DELIVERY"), true);
  assert.equal(requiresReason("CONFIRMED"), false);
});

test("assertTransition throws without a reason for cancellation", () => {
  assert.throws(() => assertTransition("RECEIVED", "CANCELLED"), InvalidTransitionError);
  assert.throws(() => assertTransition("RECEIVED", "CANCELLED", "x"), InvalidTransitionError);
  assert.doesNotThrow(() => assertTransition("RECEIVED", "CANCELLED", "Customer request"));
});

test("invalid transition throws", () => {
  assert.throws(() => assertTransition("RECEIVED", "DELIVERED"), InvalidTransitionError);
  assert.throws(() => assertTransition("DELIVERED", "CONFIRMED"), InvalidTransitionError);
});

test("COD payment is collected on delivery", () => {
  assert.equal(paymentEffectFor("DELIVERED", "PENDING"), "COLLECTED");
  assert.equal(paymentEffectFor("CANCELLED", "PENDING"), "CANCELLED_REFUND");
  assert.equal(paymentEffectFor("CONFIRMED", "PENDING"), "PENDING");
});
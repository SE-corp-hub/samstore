import { test } from "node:test";
import assert from "node:assert/strict";
import { DeliveryService } from "./delivery.service.js";

const svc = new DeliveryService();

test("markStatus unknown order → not_found", async () => {
  const r = await svc.markStatus("s1", "nope", "DELIVERED");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("markStatus wrong store → not_found (tenant scope)", async () => {
  const r = await svc.markStatus("other", "some-order", "DELIVERED");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("retryDelivery unknown order → not_found", async () => {
  const r = await svc.retryDelivery("s1", "nope");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("retryDelivery wrong store → not_found (tenant scope)", async () => {
  const r = await svc.retryDelivery("other", "some-order");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("cancelPostDispatch unknown order → not_found", async () => {
  const r = await svc.cancelPostDispatch("s1", "nope");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("cancelPostDispatch wrong store → not_found (tenant scope)", async () => {
  const r = await svc.cancelPostDispatch("other", "some-order");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});
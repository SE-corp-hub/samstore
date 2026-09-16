import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccessStore, assertStoreAccess, AccessDeniedError } from "./tenant.js";
import type { Principal } from "./tenant.js";

test("platform admin can access any store", () => {
  const p: Principal = { type: "platform_admin" };
  assert.equal(canAccessStore(p, "store-a"), true);
  assert.equal(canAccessStore(p, "store-zzz"), true);
});

test("store member can access their own stores", () => {
  const p: Principal = { type: "store_member", storeIds: ["store-a", "store-c"] };
  assert.equal(canAccessStore(p, "store-a"), true);
  assert.equal(canAccessStore(p, "store-c"), true);
});

test("store member CANNOT access another store (cross-tenant)", () => {
  const p: Principal = { type: "store_member", storeIds: ["store-a"] };
  assert.equal(canAccessStore(p, "store-b"), false);
});

test("store member with no stores can access nothing", () => {
  const p: Principal = { type: "store_member", storeIds: [] };
  assert.equal(canAccessStore(p, "store-a"), false);
});

test("assertStoreAccess throws for cross-tenant access", () => {
  const p: Principal = { type: "store_member", storeIds: ["store-a"] };
  assert.throws(() => assertStoreAccess(p, "store-b"), AccessDeniedError);
});

test("assertStoreAccess passes for authorized access", () => {
  const p: Principal = { type: "store_member", storeIds: ["store-a"] };
  assert.doesNotThrow(() => assertStoreAccess(p, "store-a"));
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { productEditRefusal, OWNER_ONLY_PRODUCT_MESSAGE } from "./product-edit-rights.js";

test("the owner may change anything on a product", () => {
  for (const role of ["OWNER", "STORE_OWNER", "PLATFORM_ADMIN"]) {
    assert.equal(productEditRefusal(role, "owner-only"), null);
    assert.equal(productEditRefusal(role, "edit", { name: "New name", costMinor: 100 }), null);
  }
});

test("a manager may change only the selling price, reorder level and picture", () => {
  assert.equal(productEditRefusal("MANAGER", "edit", { priceMinor: 150000 }), null);
  assert.equal(productEditRefusal("MANAGER", "edit", { priceMinor: 150000, reorderThreshold: 3, name: undefined }), null);
  assert.equal(productEditRefusal("MANAGER", "price-or-photo"), null);
  assert.equal(productEditRefusal("MANAGER", "edit", { name: "Renamed" }), OWNER_ONLY_PRODUCT_MESSAGE);
  assert.equal(productEditRefusal("MANAGER", "edit", { priceMinor: 1, costMinor: 1 }), OWNER_ONLY_PRODUCT_MESSAGE);
  assert.equal(productEditRefusal("MANAGER", "edit", { isActive: false }), OWNER_ONLY_PRODUCT_MESSAGE);
  assert.equal(productEditRefusal("MANAGER", "owner-only"), OWNER_ONLY_PRODUCT_MESSAGE);
});

test("a manager may add a new product (2026-11-22: a Lipa manager could not add rice)", () => {
  assert.equal(productEditRefusal("MANAGER", "add"), null);
  assert.equal(productEditRefusal("OWNER", "add"), null);
});

test("staff and others may not change products", () => {
  for (const role of ["STAFF", "SALES_AGENT", "DELIVERY", undefined]) {
    assert.notEqual(productEditRefusal(role, "edit", { priceMinor: 1 }), null);
    assert.notEqual(productEditRefusal(role, "price-or-photo"), null);
    assert.notEqual(productEditRefusal(role, "add"), null);
  }
});

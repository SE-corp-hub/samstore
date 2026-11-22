import { test } from "node:test";
import assert from "node:assert/strict";
import { productEditRefusal, OWNER_ONLY_PRODUCT_MESSAGE } from "./product-edit-rights.js";

test("the owner may change anything on a product", () => {
  for (const role of ["OWNER", "STORE_OWNER", "PLATFORM_ADMIN"]) {
    assert.equal(productEditRefusal(role, "owner-only"), null);
    assert.equal(productEditRefusal(role, "edit", { name: "New name", costMinor: 100 }), null);
  }
});

test("a manager may change the picture and the name only (2026-11-22: the main price and reorder level change every store)", () => {
  assert.equal(productEditRefusal("MANAGER", "edit", { priceMinor: 150000 }), OWNER_ONLY_PRODUCT_MESSAGE);
  assert.equal(productEditRefusal("MANAGER", "edit", { reorderThreshold: 3, name: undefined }), OWNER_ONLY_PRODUCT_MESSAGE);
  assert.equal(productEditRefusal("MANAGER", "price-or-photo"), null);
  // 2026-11-22, owner's choice "Yes, any rice": a manager may rename, nothing else on the same save.
  assert.equal(productEditRefusal("MANAGER", "edit", { name: "Renamed" }), null);
  assert.equal(productEditRefusal("MANAGER", "edit", { name: "Renamed", sku: "X" }), OWNER_ONLY_PRODUCT_MESSAGE);
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

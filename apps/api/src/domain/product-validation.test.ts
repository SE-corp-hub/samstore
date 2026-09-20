import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProductInput, slugify } from "./product-validation.js";

test("valid product input passes", () => {
  assert.deepEqual(
    validateProductInput({ name: "Kape Barako", sku: "KAPE-001", priceMinor: 12000, stock: 10 }),
    { ok: true },
  );
});

test("name too short or empty fails", () => {
  assert.equal(validateProductInput({ name: "A", sku: "SKU-1", priceMinor: 100 }).ok, false);
  assert.equal(validateProductInput({ name: "", sku: "SKU-1", priceMinor: 100 }).ok, false);
});

test("missing sku fails", () => {
  const r = validateProductInput({ name: "Kape", sku: "", priceMinor: 100 });
  assert.equal(r.ok, false);
});

test("negative or fractional price fails", () => {
  assert.equal(validateProductInput({ name: "Kape", sku: "SKU-1", priceMinor: -1 }).ok, false);
  assert.equal(validateProductInput({ name: "Kape", sku: "SKU-1", priceMinor: 10.5 }).ok, false);
});

test("negative stock fails", () => {
  assert.equal(validateProductInput({ name: "Kape", sku: "SKU-1", priceMinor: 100, stock: -1 }).ok, false);
});

test("slugify normalizes names", () => {
  assert.equal(slugify("Kape Barako"), "kape-barako");
  assert.equal(slugify("Turon (4 pcs)!!"), "turon-4-pcs");
  assert.equal(slugify("  UPPER  Case  "), "upper-case");
});

// M5 — barcode / unit / soldByWeight
test("valid barcode + unit pass", () => {
  assert.deepEqual(
    validateProductInput({ name: "Coke", sku: "COKE-1", priceMinor: 5000, barcode: "4801234567890", unit: "bottle", soldByWeight: false }),
    { ok: true },
  );
});

test("blank barcode fails", () => {
  const r = validateProductInput({ name: "Coke", sku: "COKE-1", priceMinor: 5000, barcode: "   " });
  assert.equal(r.ok, false);
});

test("barcode with illegal characters fails", () => {
  const r = validateProductInput({ name: "Coke", sku: "COKE-1", priceMinor: 5000, barcode: "123 456" });
  assert.equal(r.ok, false);
});

test("over-long barcode fails", () => {
  const r = validateProductInput({ name: "Coke", sku: "COKE-1", priceMinor: 5000, barcode: "1".repeat(65) });
  assert.equal(r.ok, false);
});

test("unit clears to null and is optional", () => {
  assert.deepEqual(
    validateProductInput({ name: "Coke", sku: "COKE-1", priceMinor: 5000, unit: null }),
    { ok: true },
  );
});

test("soldByWeight must be boolean", () => {
  const r = validateProductInput({ name: "Rice", sku: "RICE-1", priceMinor: 5200, soldByWeight: "yes" as unknown as boolean });
  assert.equal(r.ok, false);
});

// P3d — merchandising: featured / tags / related / upsell
test("featured + tags + relation ids pass", () => {
  assert.deepEqual(
    validateProductInput({
      name: "Kape", sku: "KAPE-1", priceMinor: 100,
      featured: true,
      tags: ["new", "best seller"],
      relatedProductIds: ["prod-aaaaaaaa", "prod-bbbbbbbb"],
      upsellProductIds: ["prod-cccccccc"],
    }),
    { ok: true },
  );
});

test("featured must be boolean", () => {
  const r = validateProductInput({ name: "Kape", sku: "KAPE-1", priceMinor: 100, featured: "yes" as unknown as boolean });
  assert.equal(r.ok, false);
});

test("too many tags fails", () => {
  const r = validateProductInput({ name: "Kape", sku: "KAPE-1", priceMinor: 100, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) });
  assert.equal(r.ok, false);
});

test("blank or over-long tag fails", () => {
  assert.equal(validateProductInput({ name: "Kape", sku: "KAPE-1", priceMinor: 100, tags: ["  "] }).ok, false);
  assert.equal(validateProductInput({ name: "Kape", sku: "KAPE-1", priceMinor: 100, tags: ["x".repeat(41)] }).ok, false);
});

test("too many related/upsell ids fails", () => {
  const many = Array.from({ length: 13 }, (_, i) => `prod-${String(i).padStart(8, "0")}`);
  assert.equal(validateProductInput({ name: "Kape", sku: "KAPE-1", priceMinor: 100, relatedProductIds: many }).ok, false);
  assert.equal(validateProductInput({ name: "Kape", sku: "KAPE-1", priceMinor: 100, upsellProductIds: many }).ok, false);
});

test("invalid relation id format fails", () => {
  assert.equal(validateProductInput({ name: "Kape", sku: "KAPE-1", priceMinor: 100, relatedProductIds: ["short"] }).ok, false);
});
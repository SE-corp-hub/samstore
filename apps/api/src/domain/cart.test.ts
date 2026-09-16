import { test } from "node:test";
import assert from "node:assert/strict";
import {
  revalidateCartLines,
  CartRevalidationError,
} from "./cart.js";
import type { PricedCartLine, FreshProduct } from "./cart.js";

function fresh(id: string, priceMinor: number, isActive = true): FreshProduct {
  return { id, priceMinor, isActive };
}

test("unchanged cart passes through with zero changes", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 2, unitPriceMinor: 1500 },
  ];
  const r = revalidateCartLines(lines, new Map([["p1", fresh("p1", 1500)]]));
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0]?.unitPriceMinor, 1500);
  assert.deepEqual(r.priceChanges, []);
  assert.deepEqual(r.removedProductIds, []);
  assert.equal(r.subtotalMinor, 3000);
});

test("price increase is applied and reported", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 1, unitPriceMinor: 1000 },
  ];
  const r = revalidateCartLines(lines, new Map([["p1", fresh("p1", 1250)]]));
  assert.equal(r.lines[0]?.unitPriceMinor, 1250);
  assert.deepEqual(r.priceChanges, [
    { productId: "p1", fromMinor: 1000, toMinor: 1250 },
  ]);
  assert.equal(r.subtotalMinor, 1250);
});

test("price decrease is applied and reported", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 3, unitPriceMinor: 2000 },
  ];
  const r = revalidateCartLines(lines, new Map([["p1", fresh("p1", 1500)]]));
  assert.equal(r.lines[0]?.unitPriceMinor, 1500);
  assert.equal(r.subtotalMinor, 4500);
  assert.deepEqual(r.priceChanges, [
    { productId: "p1", fromMinor: 2000, toMinor: 1500 },
  ]);
});

test("inactive product is dropped from the cart", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 1, unitPriceMinor: 1000 },
    { productId: "p2", quantity: 1, unitPriceMinor: 500 },
  ];
  const r = revalidateCartLines(
    lines,
    new Map([
      ["p1", fresh("p1", 1000)],
      ["p2", fresh("p2", 500, false)],
    ]),
  );
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0]?.productId, "p1");
  assert.deepEqual(r.removedProductIds, ["p2"]);
});

test("vanished product is dropped", () => {
  const lines: PricedCartLine[] = [
    { productId: "ghost", quantity: 1, unitPriceMinor: 999 },
  ];
  const r = revalidateCartLines(lines, new Map());
  assert.equal(r.lines.length, 0);
  assert.deepEqual(r.removedProductIds, ["ghost"]);
});

test("empty cart is a revalidation error", () => {
  assert.throws(() => revalidateCartLines([], new Map()), CartRevalidationError);
});
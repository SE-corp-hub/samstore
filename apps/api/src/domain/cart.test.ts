import { test } from "node:test";
import assert from "node:assert/strict";
import {
  revalidateCartLines,
  CartRevalidationError,
} from "./cart.js";
import type { PricedCartLine, FreshProduct, FreshAddonOption, CartAddonSnapshot } from "./cart.js";

function fresh(id: string, priceMinor: number, isActive = true): FreshProduct {
  return { id, priceMinor, isActive };
}

function addonOpt(optionId: string, addonId: string, priceMinor: number): FreshAddonOption {
  return { addonId, name: `Opt ${optionId}`, priceMinor };
}

function addonSnap(optionId: string, addonId: string, priceMinor: number): CartAddonSnapshot {
  return { addonId, optionId, name: `Opt ${optionId}`, priceMinor };
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

test("P3c: add-on option price change is re-priced and reported", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 2, unitPriceMinor: 1500, addonsTotalMinor: 1000, addons: [addonSnap("opt1", "g1", 1000)] },
  ];
  const r = revalidateCartLines(
    lines,
    new Map([["p1", fresh("p1", 1500)]]),
    new Map(),
    new Map([["opt1", addonOpt("opt1", "g1", 1250)]]),
  );
  assert.equal(r.lines[0]?.addonsTotalMinor, 1250);
  assert.equal(r.subtotalMinor, (1500 + 1250) * 2);
  assert.deepEqual(r.addonPriceChanges, [
    { productId: "p1", optionId: "opt1", name: "Opt opt1", fromMinor: 1000, toMinor: 1250 },
  ]);
  assert.deepEqual(r.removedAddonOptionIds, []);
});

test("P3c: deactivated add-on option is dropped and its cost removed", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 1, unitPriceMinor: 1500, addonsTotalMinor: 500, addons: [addonSnap("opt1", "g1", 500)] },
  ];
  // opt1 no longer in the live groups (deactivated/vanished) → dropped.
  const r = revalidateCartLines(lines, new Map([["p1", fresh("p1", 1500)]]), new Map(), new Map());
  assert.equal(r.lines[0]?.addonsTotalMinor, 0);
  assert.deepEqual(r.lines[0]?.addons, []);
  assert.equal(r.subtotalMinor, 1500);
  assert.deepEqual(r.removedAddonOptionIds, ["opt1"]);
  assert.deepEqual(r.addonPriceChanges, []);
});

test("P3c: option moved to a different add-on group is dropped", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 1, unitPriceMinor: 1500, addonsTotalMinor: 500, addons: [addonSnap("opt1", "g1", 500)] },
  ];
  // opt1 now lives in group g2 — the snapshot's group (g1) no longer matches.
  const r = revalidateCartLines(
    lines,
    new Map([["p1", fresh("p1", 1500)]]),
    new Map(),
    new Map([["opt1", addonOpt("opt1", "g2", 500)]]),
  );
  assert.equal(r.lines[0]?.addonsTotalMinor, 0);
  assert.deepEqual(r.removedAddonOptionIds, ["opt1"]);
});

test("P3c: mixed add-on set — one re-priced, one dropped, one unchanged", () => {
  const lines: PricedCartLine[] = [
    {
      productId: "p1",
      quantity: 1,
      unitPriceMinor: 1500,
      addonsTotalMinor: 700,
      addons: [addonSnap("opt1", "g1", 500), addonSnap("opt2", "g1", 200), addonSnap("opt3", "g1", 300)],
    },
  ];
  const r = revalidateCartLines(
    lines,
    new Map([["p1", fresh("p1", 1500)]]),
    new Map(),
    new Map([
      ["opt1", addonOpt("opt1", "g1", 600)], // price up
      ["opt3", addonOpt("opt3", "g1", 300)], // unchanged
      // opt2 missing → dropped
    ]),
  );
  assert.equal(r.lines[0]?.addonsTotalMinor, 900);
  assert.equal(r.subtotalMinor, 1500 + 900);
  assert.deepEqual(r.removedAddonOptionIds, ["opt2"]);
  assert.deepEqual(r.addonPriceChanges, [
    { productId: "p1", optionId: "opt1", name: "Opt opt1", fromMinor: 500, toMinor: 600 },
  ]);
});

test("P3c: line without add-ons is untouched when no live groups are passed", () => {
  const lines: PricedCartLine[] = [
    { productId: "p1", quantity: 2, unitPriceMinor: 1500 },
  ];
  const r = revalidateCartLines(lines, new Map([["p1", fresh("p1", 1500)]]), new Map(), new Map());
  assert.equal(r.lines[0]?.addonsTotalMinor, 0);
  assert.equal(r.lines[0]?.addons, undefined);
  assert.equal(r.subtotalMinor, 3000);
  assert.deepEqual(r.addonPriceChanges, []);
  assert.deepEqual(r.removedAddonOptionIds, []);
});

test("P3c: variant line add-ons re-priced against the live groups", () => {
  const lines: PricedCartLine[] = [
    {
      productId: "p1",
      variantId: "v1",
      quantity: 1,
      unitPriceMinor: 2000,
      addonsTotalMinor: 500,
      addons: [addonSnap("opt1", "g1", 500)],
    },
  ];
  const r = revalidateCartLines(
    lines,
    new Map([["p1", fresh("p1", 2000)]]),
    new Map([["v1", { id: "v1", productId: "p1", priceMinor: 2100, isActive: true }]]),
    new Map([["opt1", addonOpt("opt1", "g1", 750)]]),
  );
  assert.equal(r.lines[0]?.unitPriceMinor, 2100);
  assert.equal(r.lines[0]?.addonsTotalMinor, 750);
  assert.equal(r.subtotalMinor, 2100 + 750);
  assert.deepEqual(r.addonPriceChanges, [
    { productId: "p1", optionId: "opt1", name: "Opt opt1", fromMinor: 500, toMinor: 750 },
  ]);
});
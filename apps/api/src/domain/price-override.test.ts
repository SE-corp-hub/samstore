// Counter price override (POS review + pre-order edit).
//
// The catalog price is server-authoritative by default. A counter override is
// allowed only as an explicit, bounded, REASONED deviation, and the fact that it
// happened must be recorded so a receipt or a later audit can explain the price.
// Pure rules — no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLinePrice,
  PriceOverrideError,
  MAX_OVERRIDE_PRICE_MINOR,
  MAX_REASON_LENGTH,
} from "./price-override.js";

const CATALOG = 10_000; // ₱100.00

test("no override keeps the catalog price and records no deviation", () => {
  const r = resolveLinePrice({ catalogUnitPriceMinor: CATALOG });
  assert.equal(r.unitPriceMinor, CATALOG);
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("an undefined or null override is the same as no override", () => {
  for (const override of [undefined, null]) {
    const r = resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override, reason: "whatever" });
    assert.equal(r.unitPriceMinor, CATALOG);
    assert.equal(r.overridden, false, "a stray reason must not mark the line as overridden");
    assert.equal(r.reason, null);
  }
});

test("an override equal to the catalog price needs no reason and is not an override", () => {
  const r = resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: CATALOG });
  assert.equal(r.unitPriceMinor, CATALOG);
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("a deviating override is applied and stores the trimmed reason", () => {
  const r = resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 9_500, reason: "  neighbor shop price  " });
  assert.equal(r.unitPriceMinor, 9_500);
  assert.equal(r.catalogUnitPriceMinor, CATALOG);
  assert.equal(r.overridden, true);
  assert.equal(r.reason, "neighbor shop price");
});

test("a deviating override without a reason is refused", () => {
  assert.throws(
    () => resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 9_500 }),
    (e: unknown) => e instanceof PriceOverrideError && /reason/i.test((e as Error).message),
  );
  // Whitespace-only and too-short reasons are refused too.
  assert.throws(() => resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 9_500, reason: "   " }), PriceOverrideError);
  assert.throws(() => resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 9_500, reason: "ab" }), PriceOverrideError);
});

test("a reason longer than the cap is refused rather than silently truncated", () => {
  assert.throws(
    () => resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 9_500, reason: "x".repeat(MAX_REASON_LENGTH + 1) }),
    PriceOverrideError,
  );
  // Exactly at the cap is allowed.
  const r = resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 9_500, reason: "x".repeat(MAX_REASON_LENGTH) });
  assert.equal(r.overridden, true);
});

test("a free line (₱0) is allowed when it carries a reason", () => {
  const r = resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 0, reason: "complimentary sample" });
  assert.equal(r.unitPriceMinor, 0);
  assert.equal(r.overridden, true);
  assert.equal(r.reason, "complimentary sample");
});

test("prices outside the allowed band are refused", () => {
  assert.throws(() => resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: -1, reason: "typo" }), PriceOverrideError);
  assert.throws(() => resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: 10.5, reason: "typo" }), PriceOverrideError);
  assert.throws(
    () => resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: MAX_OVERRIDE_PRICE_MINOR + 1, reason: "typo" }),
    (e: unknown) => e instanceof PriceOverrideError && /1,000,000/.test((e as Error).message),
  );
  // The cap itself is allowed.
  const r = resolveLinePrice({ catalogUnitPriceMinor: CATALOG, override: MAX_OVERRIDE_PRICE_MINOR, reason: "bulk" });
  assert.equal(r.unitPriceMinor, MAX_OVERRIDE_PRICE_MINOR);
});

test("a non-integer catalog price is a programming error, not an override", () => {
  assert.throws(() => resolveLinePrice({ catalogUnitPriceMinor: 10.5 }), PriceOverrideError);
  assert.throws(() => resolveLinePrice({ catalogUnitPriceMinor: -100 }), PriceOverrideError);
});

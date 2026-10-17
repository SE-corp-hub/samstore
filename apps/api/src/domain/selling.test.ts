// Rice Ops M5 — Benta arithmetic and rules (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPaperSlip, isLoose, mergeQuantity, planManualItem, priceAt, priceLine, saleKey, SellingError, shortMessage } from "./selling.js";

const sack = { name: "Sinandomeng 25 kg", priceMinor: 130_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 };
const loose = { name: "Sinandomeng (per kilo)", priceMinor: 5_200, stockBaseUnit: "g", stockBaseQuantity: 1 };
const kape = { name: "Kape", priceMinor: 1_000, stockBaseUnit: null, stockBaseQuantity: null };

test("M5: a sack sells by piece; its grams are known", () => {
  assert.deepEqual(priceLine(sack, 130_000, { quantity: 2 }), { soldBy: "PIECE", stockQty: 2, grams: 50_000, unitPriceMinor: 130_000, lineTotalMinor: 260_000, enteredAmountMinor: null });
  assert.equal(priceLine(kape, 1_000, { quantity: 3 }).grams, null);
  assert.throws(() => priceLine(sack, 130_000, { quantity: 0 }), SellingError);
  assert.throws(() => priceLine(sack, 130_000, { quantity: 1.5 }), SellingError);
  assert.throws(() => priceLine(sack, 130_000, { kilos: "2" }), /by the piece/);
});

test("M5: ₱100 at ₱52/kg = 1.923 kg, and the customer pays exactly ₱100", () => {
  const l = priceLine(loose, 5_200, { amountMinor: 10_000 });
  assert.deepEqual([l.soldBy, l.stockQty, l.grams, l.lineTotalMinor, l.enteredAmountMinor], ["PESO", 1_923, 1_923, 10_000, 10_000]);
  assert.throws(() => priceLine(loose, 5_200, { amountMinor: 1 }), /not enough/, "1 centavo buys no rice");
});

test("M5: loose by kilo — line from grams, rounded once", () => {
  const l = priceLine(loose, 5_200, { kilos: "1.25" });
  assert.deepEqual([l.soldBy, l.stockQty, l.lineTotalMinor], ["KILO", 1_250, 6_500]);
  assert.equal(priceLine(loose, 5_201, { grams: 1 }).lineTotalMinor, 5, "5.201 → 5 centavos, half-up");
  assert.equal(priceLine(loose, 5_200, { kilos: "0,5" }).stockQty, 500, "a comma works too");
  assert.throws(() => priceLine(loose, 5_200, { kilos: "1.2345" }), SellingError);
  assert.throws(() => priceLine(loose, 5_200, {}), /kilos or pesos/);
  assert.throws(() => priceLine(loose, 5_200, { kilos: "1", amountMinor: 100 }), /Enter only one/);
});

test("M5: isLoose only for gram-stocked products of 1 g", () => {
  assert.equal(isLoose(loose), true);
  assert.equal(isLoose(sack), false);
  assert.equal(isLoose(kape), false);
});

test("M5: the location's own price wins; no row = the main price", () => {
  assert.equal(priceAt(5_200, 5_400), 5_400);
  assert.equal(priceAt(5_200, null), 5_200);
  assert.equal(priceAt(5_200, undefined), 5_200);
});

test("M5: the sale key is store-scoped and never the raw key", () => {
  const a = saleKey("store-a", "tap-12345678");
  assert.equal(a, saleKey("store-a", "  tap-12345678 "));
  assert.notEqual(a, saleKey("store-b", "tap-12345678"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.throws(() => saleKey("s", "short"), SellingError);
  assert.throws(() => saleKey("s", undefined), SellingError);
});

test("M5: a paper slip keeps its real time — not in the future, not older than 31 days", () => {
  const now = new Date("2026-10-16T10:00:00+08:00");
  const ok = checkPaperSlip({ slipNo: " 0123 ", occurredAt: "2026-10-15T15:30:00+08:00" }, now);
  assert.equal(ok.slipNo, "0123");
  assert.equal(ok.occurredAt.toISOString(), "2026-10-15T07:30:00.000Z");
  assert.throws(() => checkPaperSlip({ slipNo: "0123", occurredAt: "2026-10-17T10:00:00+08:00" }, now), /in the future/);
  assert.throws(() => checkPaperSlip({ slipNo: "0123", occurredAt: "2026-09-01T10:00:00+08:00" }, now), /31 days/);
  assert.throws(() => checkPaperSlip({ slipNo: "", occurredAt: "2026-10-15T10:00:00+08:00" }, now), /paper slip number/);
  assert.throws(() => checkPaperSlip({ slipNo: "12", occurredAt: "kahapon" }, now), /date and time/);
});

test("M5: Bagong item — rice joins Bigas; it needs what is on hand to be sellable", () => {
  const s = planManualItem({ name: " Jasmine  25 kg ", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 150_000, costMinor: 120_000, openingQty: 3 });
  assert.deepEqual([s.name, s.stockBaseUnit, s.stockBaseQuantity, s.stockConversionFamily, s.soldByWeight], ["Jasmine 25 kg", "g", 25_000, "Bigas", false]);
  const k = planManualItem({ name: "Jasmine tingi", soldAs: "KILO", priceMinor: 6_000, costMinor: 0, openingQty: 10_000 });
  assert.deepEqual([k.stockBaseQuantity, k.soldByWeight], [1, true]);
  const p = planManualItem({ name: "Asin", soldAs: "PIECE", priceMinor: 2_000, costMinor: 1_500, openingQty: 12 });
  assert.equal(p.stockConversionFamily, null);
  assert.throws(() => planManualItem({ name: "X", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 1, costMinor: 0, openingQty: 1 }), /Enter the name/);
  assert.throws(() => planManualItem({ name: "Jasmine", soldAs: "SACK", priceMinor: 1, costMinor: 0, openingQty: 1 }), /kilos in one sack/);
  assert.throws(() => planManualItem({ name: "Jasmine", soldAs: "KILO", priceMinor: 1, costMinor: 0, openingQty: 0 }), /on hand/);
});

test("M5: merging converts stock by weight and refuses broken sacks", () => {
  const manual25 = { name: "Jasmine 25 kg (bago)", stockBaseUnit: "g", stockBaseQuantity: 25_000 };
  const jas25 = { name: "Jasmine 25 kg", stockBaseUnit: "g", stockBaseQuantity: 25_000 };
  const jas5 = { name: "Jasmine 5 kg", stockBaseUnit: "g", stockBaseQuantity: 5_000 };
  const jasKilo = { name: "Jasmine kilo", stockBaseUnit: "g", stockBaseQuantity: 1 };
  assert.equal(mergeQuantity(manual25, jas25, 3), 3);
  assert.equal(mergeQuantity(manual25, jas5, 3), 15);
  assert.equal(mergeQuantity(manual25, jasKilo, 1), 25_000);
  assert.throws(() => mergeQuantity(jasKilo, jas25, 1_000), /resack/);
  assert.throws(() => mergeQuantity({ name: "Asin", stockBaseUnit: null, stockBaseQuantity: null }, jas25, 1), /same measure/);
  assert.equal(mergeQuantity({ name: "A", stockBaseUnit: null, stockBaseQuantity: null }, { name: "B", stockBaseUnit: null, stockBaseQuantity: null }, 4), 4);
});

test("M5: a short sale says what to do and where stock remains", () => {
  assert.equal(
    shortMessage({ productName: "Sinandomeng 25 kg", loose: false, available: 1, here: "Store 2", elsewhere: [{ name: "Store 3", available: 2 }, { name: "WH", available: 40 }] }),
    "Only 1 Sinandomeng 25 kg left at Store 2. Lower the amount, or take from WH (has 40).",
  );
  assert.equal(
    shortMessage({ productName: "Tingi", loose: true, available: 0, here: "Store 1", elsewhere: [] }),
    "No Tingi left at Store 1. Lower the amount, or count again.",
  );
});

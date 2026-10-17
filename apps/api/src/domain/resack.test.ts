// Rice Ops M4 — resack arithmetic (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gramsOf, planResack, valueOf, varietyOf, ResackError } from "./resack.js";

const sack25 = { name: "Sinandomeng 25 kg", stockBaseUnit: "g", stockBaseQuantity: 25_000 };
const sack5 = { name: "Sinandomeng 5kg", stockBaseUnit: "g", stockBaseQuantity: 5_000 };
const loose = { name: "Sinandomeng (per kilo)", stockBaseUnit: "g", stockBaseQuantity: 1 };

test("M4: grams come from the product's grams per unit", () => {
  assert.equal(gramsOf(sack25, 2), 50_000);
  assert.equal(gramsOf(loose, 1_250), 1_250);
  assert.throws(() => gramsOf({ name: "Kape", stockBaseUnit: null, stockBaseQuantity: null }, 1), ResackError);
  assert.throws(() => gramsOf(sack25, 0), ResackError);
});

test("M4: the variety is the name without the weight words", () => {
  assert.equal(varietyOf({ name: "Sinandomeng 25 kg" }), "sinandomeng");
  assert.equal(varietyOf({ name: "Sinandomeng 5kg" }), "sinandomeng");
  assert.equal(varietyOf({ name: "Sinandomeng (per kilo)" }), "sinandomeng");
  assert.equal(varietyOf({ name: "Dinorado 25 kg" }), "dinorado");
  assert.equal(varietyOf({ name: "Anything", variety: "Jasmine" }), "jasmine", "an explicit variety wins");
});

test("M4: 1 × 25 kg → 5 × 5 kg balances: no loss, no approval, same variety, cost carried in full", () => {
  const plan = planResack({
    input: { productId: "s25", name: sack25.name, grams: 25_000, valueMinor: 110_000 },
    outputs: [{ productId: "s5", name: sack5.name, grams: 25_000 }],
  });
  assert.deepEqual(
    { lossGrams: plan.lossGrams, lossBp: plan.lossBp, needsApproval: plan.needsApproval, varietyChange: plan.varietyChange, lossValue: plan.lossValueMinor, values: plan.outputValuesMinor },
    { lossGrams: 0, lossBp: 0, needsApproval: false, varietyChange: false, lossValue: 0, values: [110_000] },
  );
});

test("M4: Sinandomeng → Dinorado is Ibang klase and the new sack carries the old cost", () => {
  const plan = planResack({
    input: { productId: "s25", name: "Sinandomeng 25 kg", grams: 25_000, valueMinor: 110_000 },
    outputs: [{ productId: "d25", name: "Dinorado 25 kg", grams: 25_000 }],
  });
  assert.equal(plan.varietyChange, true);
  assert.deepEqual(plan.outputValuesMinor, [110_000], "Dinorado's own (higher) cost is NOT used");
});

test("M4: 0.8% loss is within 1%; 2% loss waits for the owner; exactly 1% does not", () => {
  const small = planResack({ input: { productId: "a", name: "A 25kg", grams: 25_000, valueMinor: 100_000 }, outputs: [{ productId: "b", name: "A loose", grams: 24_800 }] });
  assert.deepEqual([small.lossGrams, small.lossBp, small.needsApproval], [200, 80, false]);
  const big = planResack({ input: { productId: "a", name: "A 25kg", grams: 25_000, valueMinor: 100_000 }, outputs: [{ productId: "b", name: "A 5kg", grams: 24_500 }] });
  assert.deepEqual([big.lossGrams, big.lossBp, big.needsApproval], [500, 200, true]);
  assert.equal(big.lossValueMinor, 2_000, "2% of ₱1,000 lost");
  assert.equal(big.outputValuesMinor[0], 98_000);
  const edge = planResack({ input: { productId: "a", name: "A", grams: 10_000, valueMinor: 1 }, outputs: [{ productId: "b", name: "B", grams: 9_900 }] });
  assert.equal(edge.needsApproval, false, "exactly 1% is within tolerance");
  const justOver = planResack({ input: { productId: "a", name: "A", grams: 10_000, valueMinor: 1 }, outputs: [{ productId: "b", name: "B", grams: 9_899 }] });
  assert.equal(justOver.needsApproval, true, "1.01% is over — no rounding lets it slip");
});

test("M4: several outputs share the value by weight and always add up", () => {
  const plan = planResack({
    input: { productId: "s25", name: "Sinandomeng 25 kg", grams: 25_000, valueMinor: 100_001 },
    outputs: [
      { productId: "s5", name: "Sinandomeng 5kg", grams: 15_000 },
      { productId: "lo", name: "Sinandomeng (per kilo)", grams: 9_800 },
    ],
  });
  assert.equal(plan.lossGrams, 200);
  assert.equal(plan.outputValuesMinor.reduce((a, b) => a + b, 0) + plan.lossValueMinor, 100_001, "no centavo lost or invented");
});

test("M4: impossible resacks are refused", () => {
  const input = { productId: "s25", name: "S 25kg", grams: 25_000, valueMinor: 1 };
  assert.throws(() => planResack({ input, outputs: [] }), /came out/);
  assert.throws(() => planResack({ input, outputs: [{ productId: "x", name: "X", grams: 25_001 }] }), /weighs more/);
  assert.throws(() => planResack({ input, outputs: [{ productId: "s25", name: "S 25kg", grams: 25_000 }] }), /are the same/);
});

test("M4: a sack is valued per sack; loose rice per kilo", () => {
  assert.equal(valueOf({ ...sack25, costMinor: 110_000 }, 2), 220_000);
  assert.equal(valueOf({ ...loose, costMinor: 4_800 }, 1_250), 6_000, "1.25 kg at ₱48/kg = ₱60");
  assert.equal(valueOf({ ...loose, costMinor: 4_801 }, 1), 5, "rounded half-up to the centavo");
});

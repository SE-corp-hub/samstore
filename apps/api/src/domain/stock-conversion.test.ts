import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidStockConversionError, planStockConversion } from "./stock-conversion.js";

test("one 25 kg sack converts to five 5 kg packs without waste", () => {
  const plan = planStockConversion({
    sourceQuantity: 1,
    outputQuantity: 5,
    sourceBaseQuantity: 25_000,
    destinationBaseQuantity: 5_000,
    sourceCostMinor: 125_000,
  });
  assert.equal(plan.maxOutputQuantity, 5);
  assert.equal(plan.wasteBaseQuantity, 0);
  assert.equal(plan.outputValueMinor, 125_000);
  assert.equal(plan.wasteValueMinor, 0);
});

test("staff-entered short yield records remainder and proportional waste value", () => {
  const plan = planStockConversion({
    sourceQuantity: 1,
    outputQuantity: 4,
    sourceBaseQuantity: 25_000,
    destinationBaseQuantity: 5_000,
    sourceCostMinor: 100_000,
    wasteReason: "spillage while repacking",
  });
  assert.equal(plan.wasteBaseQuantity, 5_000);
  assert.equal(plan.outputValueMinor, 80_000);
  assert.equal(plan.wasteValueMinor, 20_000);
});

test("conversion refuses impossible yield, incomplete loss reason, and invalid quantities", () => {
  const base = { sourceQuantity: 1, outputQuantity: 1, sourceBaseQuantity: 25_000, destinationBaseQuantity: 5_000, sourceCostMinor: 1000 };
  assert.throws(() => planStockConversion({ ...base, outputQuantity: 6 }), InvalidStockConversionError);
  assert.throws(() => planStockConversion({ ...base, outputQuantity: 4 }), /reason is required/);
  assert.throws(() => planStockConversion({ ...base, sourceQuantity: 0 }), /sourceQuantity/);
});

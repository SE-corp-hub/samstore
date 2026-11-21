import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustUnits } from "./stock-units";

const loose = { stockBaseUnit: "g", stockBaseQuantity: 1 };
const sack = { stockBaseUnit: "g", stockBaseQuantity: 25_000 };

test("Adjust on kilo rice: typed kilos become grams (20 kg is 20,000 g, not 20 g)", () => {
  assert.equal(adjustUnits(loose, "20"), 20_000);
  assert.equal(adjustUnits(loose, "12.5"), 12_500);
  assert.equal(adjustUnits(loose, "-0,5"), -500);
});

test("Adjust on sacks: whole numbers only", () => {
  assert.equal(adjustUnits(sack, "3"), 3);
  assert.equal(adjustUnits(sack, "-2"), -2);
  assert.ok(Number.isNaN(adjustUnits(sack, "1.5")));
  assert.ok(Number.isNaN(adjustUnits(sack, "abc")));
});

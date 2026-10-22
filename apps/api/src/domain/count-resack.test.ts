import test from "node:test";
import assert from "node:assert/strict";
import { planOpenedSacks, type OpenedLine } from "./count-resack.js";

const sack = (id: string, name: string, grams: number, expected: number, counted: number | null): OpenedLine => ({ productId: id, expectedQty: expected, countedQty: counted, product: { name, stockBaseUnit: "g", stockBaseQuantity: grams } });
const loose = (id: string, name: string, expected: number, counted: number | null): OpenedLine => sack(id, name, 1, expected, counted);

test("a sack down and the loose rice up is an opened sack, not a shortage plus a surplus", () => {
  const plans = planOpenedSacks([sack("s", "Sinandomeng 25 kg", 25_000, 2, 1), loose("l", "Sinandomeng (per kilo)", 10_000, 35_000)]);
  assert.equal(plans.length, 1);
  assert.deepEqual([plans[0]!.variety, plans[0]!.sacks, plans[0]!.grams, plans[0]!.unexplainedGrams], ["sinandomeng", 1, 25_000, 0]);
  assert.deepEqual([plans[0]!.sackName, plans[0]!.looseName], ["Sinandomeng 25 kg", "Sinandomeng (per kilo)"]);
});

test("only the sacks that went missing can have been opened; extra loose rice stays unexplained", () => {
  const plans = planOpenedSacks([sack("s", "Sinandomeng 25 kg", 25_000, 3, 2), loose("l", "Sinandomeng (per kilo)", 0, 80_000)]);
  assert.deepEqual([plans[0]!.sacks, plans[0]!.grams, plans[0]!.unexplainedGrams], [1, 25_000, 55_000]);
});

test("the biggest sack is the one opened; a little extra loose rice rounds up to one sack", () => {
  const plans = planOpenedSacks([sack("a", "Dinorado 25 kg", 25_000, 2, 1), sack("b", "Dinorado 5 kg", 5_000, 4, 4), loose("l", "Dinorado (per kilo)", 1_000, 3_000)]);
  assert.deepEqual([plans[0]!.sackProductId, plans[0]!.sacks, plans[0]!.grams], ["a", 1, 25_000]);
});

test("no plan when nothing opened: sack up, loose down, nothing counted, or no loose item", () => {
  assert.deepEqual(planOpenedSacks([sack("s", "Sinandomeng 25 kg", 25_000, 2, 3), loose("l", "Sinandomeng (per kilo)", 10_000, 0)]), []);
  assert.deepEqual(planOpenedSacks([sack("s", "Sinandomeng 25 kg", 25_000, 2, 1), loose("l", "Sinandomeng (per kilo)", 10_000, null)]), []);
  assert.deepEqual(planOpenedSacks([sack("s", "Sinandomeng 25 kg", 25_000, 2, 1)]), []);
  assert.deepEqual(planOpenedSacks([sack("s", "Sinandomeng 25 kg", 25_000, 2, 1), loose("l", "Dinorado (per kilo)", 0, 5_000)]), [], "different kinds of rice never pair");
});

// Rice Ops M8 — counts, balance and write-offs (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceOf, costValue, countedUnits, CountError, lineResult, verdict, writeOffCheck } from "./counting.js";

const sack = { stockBaseUnit: "g", stockBaseQuantity: 25_000, costMinor: 110_000 };
const loose = { stockBaseUnit: "g", stockBaseQuantity: 1, costMinor: 4_600 };

test("M8: Kulang / Sobra / Tama in units, kilos and pesos (at cost)", () => {
  assert.deepEqual(lineResult(sack, 10, 9), { varianceQty: -1, varianceGrams: -25_000, varianceValueMinor: -110_000, verdict: "KULANG" });
  assert.deepEqual(lineResult(loose, 20_000, 20_500), { varianceQty: 500, varianceGrams: 500, varianceValueMinor: 2_300, verdict: "SOBRA" });
  assert.equal(lineResult(sack, 3, 3).verdict, "TAMA");
  assert.equal(costValue(loose, -1), -5, "rounds away from zero both ways");
  assert.equal(verdict(0), "TAMA");
});

test("M8: staff type sacks as whole numbers and loose rice in kilos", () => {
  assert.equal(countedUnits(sack, 7), 7);
  assert.equal(countedUnits(sack, 0), 0, "zero is a real count");
  assert.equal(countedUnits(loose, "12.5"), 12_500);
  assert.equal(countedUnits(loose, "0"), 0);
  assert.throws(() => countedUnits(sack, 1.5), CountError);
  assert.throws(() => countedUnits(sack, -1), CountError);
  assert.throws(() => countedUnits(loose, "1.2345"), CountError);
});

test("M8: expected = last count + every shelf movement since; reservations don't count", () => {
  const { expected, buckets } = balanceOf(10, [
    { type: "STOCK_IN", delta: 5 }, { type: "RECEIVE_IN", delta: 3 }, { type: "CONSUME", delta: -4 }, { type: "RESERVE", delta: 2 },
    { type: "RELEASE_OUT", delta: -2 }, { type: "RESACK_OUT", delta: -1 }, { type: "WRITE_OFF", delta: -1 }, { type: "RETURN_IN", delta: 1 }, { type: "SOMETHING_NEW", delta: 1 },
  ]);
  assert.equal(expected, 12);
  assert.deepEqual([buckets.pumasok, buckets.lipat_papasok, buckets.nabenta, buckets.lipat_palabas, buckets.resack_pumasok, buckets.bawas, buckets.ibinalik, buckets.iba], [5, 3, -4, -2, -1, -1, 1, 1]);
});

test("M8: a write-off over 1% of what the location holds waits for the owner", () => {
  assert.deepEqual(writeOffCheck(200, 2, "BASA", null), { qty: 2, reason: "BASA", lossBp: 100, needsApproval: false }, "exactly 1% is fine");
  assert.equal(writeOffCheck(200, 3, "BUKBOK", null).needsApproval, true);
  assert.equal(writeOffCheck(10, 1, "TAPON", null).needsApproval, true, "1 of 10 sacks = 10%");
  assert.throws(() => writeOffCheck(5, 6, "TAPON", null), /count it first/);
  assert.throws(() => writeOffCheck(5, 1, "IBA", ""), /reason/);
  assert.throws(() => writeOffCheck(5, 1, "NAWALA", null), /reason/);
});

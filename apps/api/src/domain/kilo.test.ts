import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isKiloItem, kiloCostFrom, kiloName, kiloPriceFrom, kiloRefusal } from "./kilo.js";

const sack = { name: "Samrice Sinandomeng 25kg", stockBaseUnit: "g", stockBaseQuantity: 25_000 };

describe("sell per kilo", () => {
  it("names the kilo item after the sack, without the size", () => {
    assert.equal(kiloName("Samrice Sinandomeng 25kg"), "Samrice Sinandomeng · per kilo");
    assert.equal(kiloName("Dinorado 25 kg"), "Dinorado · per kilo");
    assert.equal(kiloName("Jasmine (50 kilos)"), "Jasmine · per kilo");
    assert.equal(kiloName("25kg"), "25kg · per kilo");
  });
  it("prices a kilo at sack ÷ 25, rounded up to a peso, + ₱2", () => {
    assert.equal(kiloPriceFrom(135_000, 25_000), 5_600); // ₱1,350 -> ₱54 + ₱2
    assert.equal(kiloPriceFrom(132_500, 25_000), 5_500); // ₱53 exact + ₱2
    assert.equal(kiloPriceFrom(132_600, 25_000), 5_600); // ₱53.04 -> ₱54 + ₱2
    assert.equal(kiloPriceFrom(0, 25_000), 0);
  });
  it("costs a kilo at sack cost ÷ kilos", () => {
    assert.equal(kiloCostFrom(130_000, 25_000), 5_200);
    assert.equal(kiloCostFrom(130_001, 25_000), 5_200);
  });
  it("lets only sacks of 10 kg or more sell per kilo", () => {
    assert.equal(kiloRefusal(sack), null);
    assert.match(kiloRefusal({ ...sack, stockBaseQuantity: 5_000 }) ?? "", /small pack/);
    assert.match(kiloRefusal({ name: "X", stockBaseUnit: null, stockBaseQuantity: null }) ?? "", /sack size/);
    assert.match(kiloRefusal({ name: "X", stockBaseUnit: "g", stockBaseQuantity: 1 }) ?? "", /already/);
    assert.equal(isKiloItem({ stockBaseUnit: "g", stockBaseQuantity: 1 }), true);
  });
});

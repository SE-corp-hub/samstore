import test from "node:test";
import assert from "node:assert/strict";
import { isKiloLine, lineText, qtyText } from "./order-lines.js";

test("sacks read as a count, kilo rice (grams) reads in kilos", () => {
  assert.equal(lineText({ productName: "Alsa 25kg", quantity: 2, soldBy: "PIECE" }), "2× Alsa 25kg");
  assert.equal(lineText({ productName: "Alsa 25kg", quantity: 2 }), "2× Alsa 25kg");
  assert.equal(lineText({ productName: "Sinandomeng per kilo", quantity: 1785, soldBy: "PESO" }), "1.785 kg Sinandomeng per kilo");
  assert.equal(qtyText({ quantity: 2500, soldBy: "KILO" }), "2.5 kg");
  assert.equal(isKiloLine({ quantity: 1, soldBy: null }), false);
});

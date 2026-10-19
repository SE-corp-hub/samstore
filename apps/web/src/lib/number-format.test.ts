import test from "node:test";
import assert from "node:assert/strict";
import { cleanTyping, formatOnBlur, kilosToGrams, pesosToMinor } from "./number-format.js";

test("peso boxes show 2 decimals, kilo boxes 3, whole boxes none", () => {
  assert.equal(formatOnBlur("50", "peso"), "50.00");
  assert.equal(formatOnBlur("1,250.5", "peso"), "1250.50");
  assert.equal(formatOnBlur("25", "kilo"), "25.000");
  assert.equal(formatOnBlur("3.7", "whole"), "3");
  assert.equal(formatOnBlur("", "peso"), "");
  assert.equal(formatOnBlur("abc", "peso"), "");
});

test("typing is limited to the allowed decimals", () => {
  assert.equal(cleanTyping("12.345", "peso"), "12.34");
  assert.equal(cleanTyping("1.2.3", "kilo"), "1.23");
  assert.equal(cleanTyping("7.9", "whole"), "7");
  assert.equal(cleanTyping("₱1,000", "peso"), "1000");
});

test("pesos and kilos convert to exact centavos and grams", () => {
  assert.equal(pesosToMinor("50.10"), 5010);
  assert.equal(pesosToMinor("0.29"), 29);
  assert.equal(pesosToMinor(""), null);
  assert.equal(kilosToGrams("24.975"), 24975);
  assert.equal(kilosToGrams("0.1"), 100);
});

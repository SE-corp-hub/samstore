// P1: pure-unit tests for the Philippines context formatters (@sam-store/contracts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPesos, pesoInWords, formatManila, manilaNow } from "@sam-store/contracts";

test("formatPesos formats integer minor units with grouping and 2 decimals", () => {
  assert.equal(formatPesos(0), "₱0.00");
  assert.equal(formatPesos(5), "₱0.05");
  assert.equal(formatPesos(9900), "₱99.00");
  assert.equal(formatPesos(123456), "₱1,234.56");
  assert.equal(formatPesos(100000), "₱1,000.00");
  assert.equal(formatPesos(100000000), "₱1,000,000.00");
});

test("formatPesos rejects non-integer and negative inputs", () => {
  assert.throws(() => formatPesos(-1));
  assert.throws(() => formatPesos(1.5));
  assert.throws(() => formatPesos(Number.NaN));
});

test("pesoInWords: whole pesos", () => {
  assert.equal(pesoInWords(0), "zero piso");
  assert.equal(pesoInWords(100), "isang piso");
  assert.equal(pesoInWords(500), "limang piso");
  assert.equal(pesoInWords(10000), "isang daang piso");
  assert.equal(pesoInWords(200000), "dalawang libong piso"); // ₱2,000
  assert.equal(pesoInWords(2000000), "dalawampung libong piso"); // ₱20,000
  assert.equal(pesoInWords(100000), "isang libong piso"); // ₱1,000
  assert.equal(pesoInWords(123400), "isang libo dalawang daan at tatlumpu't apat na piso");
});

test("pesoInWords: with centavos", () => {
  assert.equal(pesoInWords(101), "isang piso at isang sentimo");
  assert.equal(pesoInWords(150), "isang piso at limampung sentimo");
  assert.equal(pesoInWords(1050), "sampung piso at limampung sentimo");
  assert.equal(pesoInWords(123456), "isang libo dalawang daan at tatlumpu't apat na piso at limampu't anim na sentimo");
});

test("pesoInWords: large amounts (million)", () => {
  // minor 123456700 = ₱1,234,567.00 (no centavos)
  assert.equal(
    pesoInWords(123456700),
    "isang milyon dalawang daan at tatlumpu't apat na libo limang daan at animnapu't pitong piso",
  );
});

test("pesoInWords rejects bad inputs", () => {
  assert.throws(() => pesoInWords(-1));
  assert.throws(() => pesoInWords(1.5));
});

test("formatManila renders Asia/Manila regardless of host timezone", () => {
  // 2026-01-01 12:00 UTC == 2026-01-01 20:00 Asia/Manila.
  const s = formatManila(Date.UTC(2026, 0, 1, 12, 0, 0));
  assert.match(s, /Jan 1, 2026/);
  assert.match(s, /\d{1,2}:\d{2}/);
});

test("manilaNow returns a Date in the current year", () => {
  const d = manilaNow();
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
});
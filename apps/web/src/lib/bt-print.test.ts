import test from "node:test";
import assert from "node:assert/strict";
import { plain, slipLines, slipToEscPos } from "./bt-print.js";

test("only plain characters reach the printer", () => {
  assert.equal(plain("₱1,500.00 × 2 — Jasmine"), "P1,500.00 x 2 - Jasmine");
  assert.equal(plain("Piña"), "Pina");
  assert.equal(plain("日本"), "??");
});

test("a 58 mm slip fits 32 characters a line and keeps amounts on the right", () => {
  const lines = slipLines({ storeName: "SAM STORE", title: "RECEIPT", reference: "ORD-1", rows: [{ name: "Sinandomeng 25 kg", qty: "1  ₱1,500.00" }], totals: [{ label: "TOTAL", value: "₱1,500.00" }], footer: "Salamat po!" }, 32);
  assert.ok(lines.every((l) => l.length <= 32), lines.join("|"));
  assert.ok(lines.includes("TOTAL" + " ".repeat(32 - 5 - 9) + "P1,500.00"));
  assert.ok(lines.some((l) => l.trim() === "Salamat po!"));
});

test("two copies are separated and the bytes start with the printer reset", () => {
  const one = slipLines({ storeName: "S", title: "T" }, 32);
  const two = slipLines({ storeName: "S", title: "T", copies: 2 }, 32);
  assert.ok(two.length > one.length * 2);
  const bytes = slipToEscPos({ storeName: "S", title: "T" }, 32);
  assert.deepEqual([bytes[0], bytes[1]], [0x1b, 0x40]);
  assert.equal(bytes[bytes.length - 1], 0x0a);
});

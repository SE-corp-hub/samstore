import test from "node:test";
import assert from "node:assert/strict";
import { btErrorText, pickWriter, plain, slipLines, slipToEscPos } from "./bt-print.js";

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

const u = (n: number) => `0000${n.toString(16)}-0000-1000-8000-00805f9b34fb`;

test("the receipt never goes to the device-name slot, and a known print channel wins", () => {
  const chars = [
    { service: u(0x1800), uuid: u(0x2a00), write: true, writeWithoutResponse: false }, // device name: writable on some printers
    { service: u(0xff00), uuid: u(0xff03), write: true, writeWithoutResponse: false },
    { service: u(0x18f0), uuid: u(0x2af1), write: true, writeWithoutResponse: true },
  ];
  assert.equal(pickWriter(chars), 2);
  assert.equal(pickWriter(chars.slice(0, 2)), 1);
  assert.equal(pickWriter(chars.slice(0, 1)), -1);
});

test("Bluetooth errors are explained in plain words", () => {
  const err = (name: string, message: string) => Object.assign(new Error(message), { name });
  assert.equal(btErrorText(err("NotFoundError", "User cancelled the requestDevice() chooser.")), "No printer was chosen");
  assert.match(btErrorText(err("NotFoundError", "Bluetooth adapter not available.")), /Nearby devices.*\(Bluetooth adapter not available\.\)/);
  assert.match(btErrorText(err("NetworkError", "GATT Server is disconnected.")), /did not answer/);
  assert.match(btErrorText(err("SecurityError", "x")), /Nearby devices/);
  // An automatic print after a sale has no tap, so Chrome cannot show its printer list.
  assert.match(btErrorText(err("NeedsTapError", "Printer not connected yet")), /Tap Print receipt/);
  assert.match(btErrorText(err("SecurityError", "Must be handling a user gesture to show a permission request.")), /Tap Print receipt/);
});

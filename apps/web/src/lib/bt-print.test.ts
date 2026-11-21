import test from "node:test";
import assert from "node:assert/strict";
import { btErrorText, pickWriter, plain, slipLines, slipPrintLines, slipToEscPos } from "./bt-print.js";
import { saleReceipt } from "./sale-receipt.js";

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
  // A connect that never answers (tablet after Bluetooth off/on): only closing the app clears it.
  assert.match(btErrorText(err("TimeoutError", "No answer from the printer")), /close this app completely.*receipt is kept/);
  assert.match(btErrorText(err("PendingReceipt", "")), /not printed yet/);
  assert.match(btErrorText(err("SecurityError", "x")), /Nearby devices/);
  // The printer connected, but none of its services is on the app's list: not a Bluetooth-off problem.
  assert.match(btErrorText(err("NotFoundError", "No Services found in device.")), /Check my printer/);
  assert.match(btErrorText(err("SecurityError", "Origin is not allowed to access any service.")), /Check my printer/);
  // An automatic print after a sale has no tap, so Chrome cannot show its printer list.
  assert.match(btErrorText(err("NeedsTapError", "Printer not connected yet")), /Tap Connect printer/);
  assert.match(btErrorText(err("SecurityError", "Must be handling a user gesture to show a permission request.")), /Tap Connect printer/);
});

test("the Bluetooth receipt prints the address and contact lines under the name", () => {
  const lines = slipLines({ storeName: "Tindahan ni Sam", header: "Brgy. 1", contact: "0917 123 4567", title: "RECEIPT" }, 32).map((l) => l.trim());
  assert.deepEqual(lines.slice(0, 5), ["Tindahan ni Sam", "Brgy. 1", "0917 123 4567", "", "RECEIPT"]);
});

const sale = saleReceipt({
  status: "COMPLETED", orderNumber: "POS-000123", totalMinor: 259282, changeMinor: 40718, customerName: "Aling Nena", payLabel: "Cash", tenderedMinor: 300000,
  lines: [
    { name: "Sinandomeng 25kg", soldBy: "PIECE", quantity: 2, grams: 50000, unitPriceMinor: 125000, lineTotalMinor: 250000 },
    { name: "Dinorado per kilo", soldBy: "WEIGHT", quantity: 1785, grams: 1785, unitPriceMinor: 5200, lineTotalMinor: 9282 },
  ],
}, "Bogs and Lucy", null, new Date(2026, 10, 21, 7, 37));

test("the sales receipt: big store name, item detail under each name, tall TOTAL, cash and change", () => {
  for (const w of [32, 48]) {
    const lines = slipPrintLines(sale, w);
    const width = (l: { text: string; mode: string }) => (l.mode === "big" ? l.text.length * 2 : l.text.length);
    assert.ok(lines.every((l) => width(l) <= w), lines.map((l) => l.text).join("|"));
    assert.equal(lines[0]!.mode, "big");
    assert.equal(lines[0]!.text.trim(), "Bogs and Lucy");
    const at = (t: string) => lines.findIndex((l) => l.text.includes(t));
    assert.equal(lines[at("Sinandomeng")]!.mode, "bold");
    assert.match(lines[at("Sinandomeng") + 1]!.text, /^ {2}2 x P1,250\.00 +P2,500\.00$/);
    assert.match(lines[at("Dinorado") + 1]!.text, /1\.785 kg x P52\.00\/kg +P92\.82$/);
    assert.equal(lines[at("TOTAL")]!.mode, "tall");
    assert.ok(at("Cash given") > at("TOTAL") && at("Change") > at("Cash given"));
    assert.match(lines[at("Customer")]!.text, /Aling Nena$/);
    assert.match(lines[at("Date")]!.text, /Nov 21, 2026, 7:37 AM$/);
    assert.ok(lines.every((l) => !l.text.includes("?")), "no unknown characters (the narrow space before am/pm)");
  }
});

test("a store name too long for big letters prints bold at normal size", () => {
  const lines = slipPrintLines({ storeName: "Bahay Tindahan ng Bigas at Iba Pa sa Bauan", title: "RECEIPT" }, 32);
  assert.equal(lines[0]!.mode, "bold");
});

test("the print modes reach the printer and are reset at the end", () => {
  const bytes = Array.from(slipToEscPos(sale, 32));
  const modes = bytes.flatMap((b, i) => (b === 0x1b && bytes[i + 1] === 0x21 ? [bytes[i + 2]] : []));
  assert.ok(modes.includes(0x38) && modes.includes(0x18) && modes.includes(0x08));
  assert.equal(modes[modes.length - 1], 0x00);
});

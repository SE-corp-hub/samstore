import test from "node:test";
import assert from "node:assert/strict";
import { buildText, phoneForLink, smsLink } from "./text-message.js";

test("Philippine mobile numbers become +63 links; bad numbers are refused", () => {
  assert.equal(phoneForLink("0917 123 4567"), "+639171234567");
  assert.equal(phoneForLink("+63 917-123-4567"), "+639171234567");
  assert.equal(phoneForLink("9171234567"), "+639171234567");
  assert.equal(phoneForLink("02-8123-4567"), "");
  assert.equal(phoneForLink(""), "");
  assert.equal(phoneForLink(null), "");
});

test("the sms link carries the message, encoded", () => {
  const link = smsLink("+639171234567", "Hi Ana, ₱1,200.00 & more");
  assert.ok(link.startsWith("sms:+639171234567?&body="));
  assert.ok(!link.includes(" "));
  assert.equal(decodeURIComponent(link.split("&body=")[1]!), "Hi Ana, ₱1,200.00 & more");
});

test("texts show the transaction and the remaining balance", () => {
  const sale = buildText("credit_sale", { storeName: "SAM STORE", customerName: "Ana Cruz", reference: "S-12", totalMinor: 125000, balanceMinor: 300000, items: [{ name: "Jasmine", qty: "25 kg" }] });
  assert.ok(sale.includes("Ana,") && sale.includes("₱1,250.00") && sale.includes("₱3,000.00") && sale.includes("25 kg Jasmine"));
  assert.ok(buildText("balance", { storeName: "SAM STORE", balanceMinor: 0 }).includes("wala na po"));
  assert.ok(buildText("payment_received", { storeName: "SAM STORE", paidMinor: 50000, balanceMinor: 250000 }).includes("Natitirang balanse: ₱2,500.00"));
  assert.ok(buildText("payment_received", { storeName: "SAM STORE", paidMinor: 50000, balanceMinor: 0 }).includes("Bayad na po"));
});

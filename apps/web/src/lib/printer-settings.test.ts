import test from "node:test";
import assert from "node:assert/strict";
import { cleanPrinterSettings, DEFAULT_PRINTER, PLACEHOLDER_NAME, receiptName } from "./printer-settings.js";

test("bad or missing printer settings fall back to the defaults", () => {
  assert.deepEqual(cleanPrinterSettings(null), DEFAULT_PRINTER);
  assert.deepEqual(cleanPrinterSettings({ widthMm: 100, copies: 5, autoPrint: "yes" }), DEFAULT_PRINTER);
});

test("good settings are kept and the text is tidied", () => {
  const c = cleanPrinterSettings({ widthMm: 80, copies: 2, autoPrint: true, header: " Tel 0917\n123 ", footer: "x".repeat(200) });
  assert.equal(c.widthMm, 80);
  assert.equal(c.copies, 2);
  assert.equal(c.autoPrint, true);
  assert.equal(c.header, "Tel 0917 123");
  assert.equal(c.footer.length, 80);
});

test("the receipt name and contact line are kept and tidied", () => {
  const c = cleanPrinterSettings({ name: "  Aling Nena Rice\n", contact: "0917 123 4567", footer: "Balik po kayo!" });
  assert.equal(c.name, "Aling Nena Rice");
  assert.equal(c.contact, "0917 123 4567");
  assert.equal(cleanPrinterSettings({ name: "x".repeat(99) }).name.length, 40);
});

test("store receipts print the typed name, else the registered name; report titles stay", () => {
  // offline: the screen only had the placeholder
  assert.equal(receiptName(PLACEHOLDER_NAME, "", "Tindahan ni Sam"), "Tindahan ni Sam");
  assert.equal(receiptName(PLACEHOLDER_NAME, "Sam Bigasan", "Tindahan ni Sam"), "Sam Bigasan");
  // online: the screen passed the registered name
  assert.equal(receiptName("Tindahan ni Sam", "Sam Bigasan", "Tindahan ni Sam"), "Sam Bigasan");
  // nothing known yet: the placeholder stays
  assert.equal(receiptName(PLACEHOLDER_NAME, "", null), PLACEHOLDER_NAME);
  // a statement or report with its own title is not renamed
  assert.equal(receiptName("Weekly summary", "Sam Bigasan", "Tindahan ni Sam"), "Weekly summary");
});

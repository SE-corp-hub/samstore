import test from "node:test";
import assert from "node:assert/strict";
import { cleanPrinterSettings, DEFAULT_PRINTER } from "./printer-settings.js";

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

import test from "node:test";
import assert from "node:assert/strict";
import { safeImage, slipHtml } from "./slip-print.js";

test("slip text is escaped and the paper width is applied", () => {
  const html = slipHtml({ storeName: "A & B <Rice>", title: "RESACK", rows: [{ name: "<img onerror=x>", qty: "25.000 kg" }], widthMm: 80 });
  assert.ok(html.includes("A &amp; B &lt;Rice&gt;"));
  assert.ok(!html.includes("<img onerror"));
  assert.ok(html.includes("size: 80mm auto"));
});

test("only png/jpeg data images are printed as signatures", () => {
  assert.equal(safeImage("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(safeImage("https://evil.example/x.png"), null);
  assert.equal(safeImage('data:image/svg+xml;base64,PHN2Zz4='), null);
  const html = slipHtml({ storeName: "S", title: "T", signatures: [{ role: "Kargador", name: "Mang Jose", imageData: "javascript:alert(1)" }] });
  assert.ok(html.includes('class="blank"') && !html.includes("javascript:"));
});

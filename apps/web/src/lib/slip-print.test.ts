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

test("a header line and two copies are printed when asked", () => {
  const one = slipHtml({ storeName: "S", title: "T", header: "Tel 0917" });
  assert.ok(one.includes("Tel 0917"));
  assert.equal(one.split("<section>").length - 1, 1);
  const two = slipHtml({ storeName: "S", title: "T", copies: 2 });
  assert.equal(two.split("<section>").length - 1, 2);
  assert.equal(slipHtml({ storeName: "S", title: "T", copies: 9 }).split("<section>").length - 1, 2);
});

test("a contact line prints under the address", () => {
  const html = slipHtml({ storeName: "S", title: "T", header: "Brgy. 1, Bulacan", contact: "0917 123 4567" });
  assert.ok(html.indexOf("Brgy. 1, Bulacan") < html.indexOf("0917 123 4567"));
});

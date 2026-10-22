import test from "node:test";
import assert from "node:assert/strict";
import { tableHtml } from "./table-print.js";

test("the page has the title, the heading cells, every row and the totals", () => {
  const html = tableHtml({ title: "Stock movement", subtitle: "Store 1 · 1 Oct to 7 Oct", head: ["Item", "Start", "End"], rows: [["Sinandomeng 25 kg", "5", "3"], ["Dinorado 25 kg", "0", "9"]], foot: [["Total kilos", "125", "75"]] });
  assert.match(html, /<h1>Stock movement<\/h1>/);
  assert.match(html, /Store 1 · 1 Oct to 7 Oct/);
  assert.equal((html.match(/<th[ >]/g) ?? []).length, 3);
  assert.equal((html.match(/<td/g) ?? []).length, 9);
  assert.match(html, /<tfoot>/);
  assert.match(html, /size: A4 landscape/);
});

test("words from the data cannot add markup", () => {
  const html = tableHtml({ title: "<b>x</b>", head: ["A\"B"], rows: [["<script>alert(1)</script>"]] });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<b>x</b>"), false);
  assert.match(html, /&lt;script&gt;/);
});

test("no totals means no footer; the first column is left, the others right", () => {
  const html = tableHtml({ title: "T", head: ["Item", "Qty"], rows: [["a", "1"]] });
  assert.equal(html.includes("<tfoot>"), false);
  assert.match(html, /<th>Item<\/th><th class="n">Qty<\/th>/);
});

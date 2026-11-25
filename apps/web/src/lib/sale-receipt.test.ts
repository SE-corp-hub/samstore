import test from "node:test";
import assert from "node:assert/strict";
import { preorderSaleReceipt } from "./sale-receipt.js";

const pre = {
  orderNumber: "PO-12", customerName: "Aling Nena", totalMinor: 250000, locationId: "loc1",
  items: [{ productName: "Dinorado", variantName: "25kg", quantity: 2, unitPriceMinor: 125000, lineTotalMinor: 250000 }],
};

test("a completed pre-order paid in cash prints like a POS sale", () => {
  const s = preorderSaleReceipt(pre, { paidBy: "cash", tenderedMinor: 300000, changeMinor: 50000 }, "Bogs and Lucy");
  assert.equal(s.title, "SALES RECEIPT");
  assert.equal(s.reference, "PO-12");
  assert.equal(s.locationId, "loc1");
  assert.deepEqual(s.lines, [{ label: "Customer", value: "Aling Nena" }]);
  assert.equal(s.rows?.[0]?.name, "Dinorado · 25kg");
  assert.ok(s.rows?.[0].detail?.startsWith("2 x "));
  assert.deepEqual(s.totals?.map((t) => t.label), ["TOTAL", "Paid by", "Cash given", "Change"]);
});

test("a pre-order on credit prints no cash or change, and an offline one says so", () => {
  const s = preorderSaleReceipt(pre, { paidBy: "credit", tenderedMinor: 999, changeMinor: 5, offline: true }, "S1");
  assert.deepEqual(s.totals?.map((t) => t.label), ["TOTAL", "Paid by"]);
  assert.equal(s.totals?.[1]?.value, "Credit (utang)");
  assert.match(s.footer ?? "", /offline/i);
});

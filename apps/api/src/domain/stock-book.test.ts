// Stock book — ledger chain check (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkChain, type LedgerRow } from "./stock-book.js";

let n = 0;
const row = (type: string, delta: number, balanceAfter: number | null, docType: string | null = null): LedgerRow => ({
  id: `m${++n}`, type, delta, balanceAfter, documentType: docType, documentId: docType ? `d${n}` : null, createdAt: new Date(2026, 9, 1, 8, n),
});

test("stock book: an unbroken ledger that ends at the shelf count is ok", () => {
  const c = checkChain([row("RECEIPT", 50, 50, "STOCK_IN"), row("TRANSFER_OUT", -20, 30, "TRANSFER"), row("CONSUME", -5, 25, "SALE")], 25);
  assert.equal(c.status, "ok");
  assert.equal(c.difference, 0);
  assert.equal(c.ledgerBalance, 25);
  assert.deepEqual(c.breaks, []);
});

test("stock book: shelf shows less than the ledger — the difference says how many", () => {
  const c = checkChain([row("RECEIPT", 50, 50), row("CONSUME", -5, 45)], 0);
  assert.equal(c.status, "off");
  assert.equal(c.ledgerBalance, 45);
  assert.equal(c.difference, -45, "inventory says out of stock but the ledger says 45");
});

test("stock book: a jump in the chain is pinned to the row after it", () => {
  const c = checkChain([row("RECEIPT", 10, 10), row("CONSUME", -2, 8), row("CONSUME", -1, 3, "SALE")], 3);
  assert.equal(c.status, "off", "chain broke even though the last balance matches the shelf");
  assert.equal(c.breaks.length, 1);
  assert.equal(c.breaks[0]!.expected, 7);
  assert.equal(c.breaks[0]!.actual, 3);
  assert.equal(c.breaks[0]!.gap, -4, "4 left without a ledger row");
});

test("stock book: hold and release-a-hold rows do not count", () => {
  const c = checkChain([row("RECEIPT", 10, 10), row("RESERVE", -3, 7), row("RELEASE_RESERVATION", 3, 10)], 10);
  assert.equal(c.status, "ok");
  assert.equal(c.rows, 1);
});

test("stock book: rows with no balance (older data) are carried forward", () => {
  const c = checkChain([row("RECEIPT", 10, null), row("CONSUME", -2, null), row("CONSUME", -1, 7)], 7);
  assert.equal(c.status, "ok", "no earlier balance to compare with, so the first known balance starts the chain");
  assert.equal(c.ledgerBalance, 7);
  const d = checkChain([row("RECEIPT", 10, 10), row("CONSUME", -2, null), row("CONSUME", -1, 7)], 7);
  assert.equal(d.status, "ok");
});

test("stock book: stock with no ledger rows at all is flagged, zero stock is just empty", () => {
  assert.equal(checkChain([], 12).status, "no_ledger");
  assert.equal(checkChain([], 12).difference, 12);
  assert.equal(checkChain([], 0).status, "empty");
});

import { bucketOf, periodTotals } from "./stock-book.js";

const at = (d: number, type: string, delta: number, bal: number, docType: string | null = null): LedgerRow => ({
  id: `p${++n}`, type, delta, balanceAfter: bal, documentType: docType, documentId: null, createdAt: new Date(Date.UTC(2026, 9, d, 4)),
});

test("stock book: rows fall into plain-word buckets", () => {
  assert.equal(bucketOf({ type: "RECEIPT", documentType: "STOCK_IN" }), "purchase");
  assert.equal(bucketOf({ type: "TRANSFER_IN", documentType: "TRANSFER" }), "transfer_in");
  assert.equal(bucketOf({ type: "TRANSFER_OUT", documentType: "TRANSFER" }), "transfer_out");
  assert.equal(bucketOf({ type: "CONSUME", documentType: "SALE" }), "sale");
  assert.equal(bucketOf({ type: "CONVERSION_OUT", documentType: "RESACK" }), "resack");
  assert.equal(bucketOf({ type: "ADJUST", documentType: "COUNT" }), "count_or_writeoff");
  assert.equal(bucketOf({ type: "VOID_RESTORE", documentType: "SALE" }), "void_or_return", "a voided sale puts rice back; it is not a sale");
  assert.equal(bucketOf({ type: "MYSTERY", documentType: null }), "other");
});

test("stock book: opening + in − out = closing for the period", () => {
  const rows = [at(1, "RECEIPT", 100, 100, "STOCK_IN"), at(2, "TRANSFER_OUT", -30, 70, "TRANSFER"), at(5, "CONSUME", -10, 60, "SALE"), at(6, "TRANSFER_IN", 20, 80, "TRANSFER"), at(9, "CONSUME", -5, 75, "SALE")];
  const t = periodTotals(rows, new Date(Date.UTC(2026, 9, 3)), new Date(Date.UTC(2026, 9, 8)));
  assert.equal(t.opening, 70);
  assert.equal(t.closing, 80);
  assert.equal(t.inQty, 20);
  assert.equal(t.outQty, 10);
  assert.equal(t.opening! + t.inQty - t.outQty, t.closing);
  assert.equal(t.byBucket.sale.outQty, 10);
  assert.equal(t.byBucket.transfer_in.inQty, 20);
});

test("stock book: a period with no rows keeps the balance it started with", () => {
  const rows = [at(1, "RECEIPT", 100, 100, "STOCK_IN")];
  const t = periodTotals(rows, new Date(Date.UTC(2026, 9, 3)), new Date(Date.UTC(2026, 9, 8)));
  assert.equal(t.opening, 100);
  assert.equal(t.closing, 100);
  assert.equal(t.inQty + t.outQty, 0);
});

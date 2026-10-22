import test from "node:test";
import assert from "node:assert/strict";
import { buildSummary, COLUMNS, type MoveGroup, type SummaryProduct } from "./movement-summary.js";

const sack: SummaryProduct = { id: "sack", name: "Sinandomeng 25 kg", loose: false, unitGrams: 25_000 };
const loose: SummaryProduct = { id: "loose", name: "Sinandomeng (per kilo)", loose: true, unitGrams: 1 };
const still: SummaryProduct = { id: "still", name: "Never moved", loose: false, unitGrams: 25_000 };
const g = (productId: string, type: string, documentType: string | null, delta: number): MoveGroup => ({ productId, type, documentType, delta });

test("start + every column = end, and each move lands in its own column", () => {
  const { rows } = buildSummary(
    [sack],
    new Map([["sack", 20]]),
    new Map([["sack", -3]]), // 3 sacks were sold after the period: the end of the period was 23
    [g("sack", "RECEIPT", "STOCK_IN", 30), g("sack", "TRANSFER_OUT", "TRANSFER", -5), g("sack", "TRANSFER_IN", "TRANSFER", 2), g("sack", "CONSUME", "SALE", -12), g("sack", "ADJUST", "COUNT", -1)],
  );
  const r = rows[0]!;
  assert.equal(r.end, 23);
  assert.equal(r.bought, 30);
  assert.equal(r.movedOut, -5);
  assert.equal(r.movedIn, 2);
  assert.equal(r.sold, -12);
  assert.equal(r.countFix, -1);
  assert.equal(r.start, 23 - (30 - 5 + 2 - 12 - 1));
  assert.equal(r.start + COLUMNS.reduce((s, c) => s + r[c], 0), r.end);
});

test("resack, returns and cancelled sales have their own columns", () => {
  const { rows } = buildSummary(
    [sack, loose],
    new Map([["sack", 10], ["loose", 40_000]]),
    new Map(),
    [g("sack", "CONVERSION_OUT", "RESACK", -2), g("loose", "CONVERSION_IN", "RESACK", 10_000), g("sack", "VOID_RESTORE", "SALE", 1), g("sack", "RECEIPT", "RETURN", 1)],
  );
  const s = rows.find((r) => r.productId === "sack")!;
  assert.equal(s.resack, -2);
  assert.equal(s.returns, 2);
  assert.equal(rows.find((r) => r.productId === "loose")!.resack, 10_000);
});

test("items that did not move and hold nothing are left out; items that only sit on the shelf are kept", () => {
  const { rows } = buildSummary([sack, loose, still], new Map([["sack", 8]]), new Map(), []);
  assert.deepEqual(rows.map((r) => r.productId), ["sack"]);
  assert.equal(rows[0]!.start, 8);
  assert.equal(rows[0]!.end, 8);
});

test("an item that was sold out completely in the period still shows", () => {
  const { rows } = buildSummary([sack], new Map([["sack", 0]]), new Map(), [g("sack", "CONSUME", "SALE", -4)]);
  assert.equal(rows[0]!.start, 4);
  assert.equal(rows[0]!.end, 0);
});

test("kilo totals add sacks and loose rice together", () => {
  const { kilos } = buildSummary(
    [sack, loose],
    new Map([["sack", 10], ["loose", 40_000]]),
    new Map(),
    [g("sack", "CONSUME", "SALE", -2), g("loose", "CONSUME", "SALE", -5_000)],
  );
  assert.equal(kilos.sold, -(2 * 25 + 5));
  assert.equal(kilos.end, 10 * 25 + 40);
  assert.equal(kilos.start, 10 * 25 + 40 + 55);
});

test("a product that is not a weight item is not in the kilo totals", () => {
  const bag: SummaryProduct = { id: "bag", name: "Plastic bags", loose: false, unitGrams: null };
  const { rows, kilos } = buildSummary([bag], new Map([["bag", 100]]), new Map(), [g("bag", "CONSUME", "SALE", -10)]);
  assert.equal(rows.length, 1);
  assert.equal(kilos.sold, 0);
});

test("rows are sorted by name", () => {
  const a: SummaryProduct = { id: "a", name: "Ate", loose: false, unitGrams: 1000 };
  const z: SummaryProduct = { id: "z", name: "Zeta", loose: false, unitGrams: 1000 };
  const { rows } = buildSummary([z, a], new Map([["a", 1], ["z", 1]]), new Map(), []);
  assert.deepEqual(rows.map((r) => r.name), ["Ate", "Zeta"]);
});

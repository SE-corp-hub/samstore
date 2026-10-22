import test from "node:test";
import assert from "node:assert/strict";
import { ageText, countedKg, groupKg, searchItems, sheetGroups, staleCount, staleFirst, titleCase } from "./count-view.js";

const mk = (name: string, over: Partial<{ sku: string; barcode: string | null; variety: string; lastCountedAt: string | null }> = {}) =>
  ({ name, sku: over.sku ?? name.slice(0, 3).toUpperCase(), barcode: over.barcode ?? null, variety: over.variety ?? "", lastCountedAt: over.lastCountedAt ?? null });

test("search: every word must match; an exact code or barcode comes first; names that start with the text next", () => {
  const items = [mk("Dinorado 25 kg", { variety: "dinorado" }), mk("Sinandomeng 25 kg", { variety: "sinandomeng", sku: "SIN25", barcode: "4800001" }), mk("Sinandomeng (per kilo)", { variety: "sinandomeng", sku: "SINK" }), mk("Ginger Sinandomeng 5 kg", { variety: "ginger sinandomeng" })];
  assert.deepEqual(searchItems(items, "sinandomeng 25").map((i) => i.name), ["Sinandomeng 25 kg"]);
  assert.deepEqual(searchItems(items, "SINANDOMENG").map((i) => i.name), ["Sinandomeng (per kilo)", "Sinandomeng 25 kg", "Ginger Sinandomeng 5 kg"], "names that start with the text first, then the rest");
  assert.equal(searchItems(items, "4800001")[0]!.name, "Sinandomeng 25 kg", "a scanned barcode finds the item");
  assert.equal(searchItems(items, "sink")[0]!.name, "Sinandomeng (per kilo)", "the code works too");
  assert.deepEqual(searchItems(items, "  "), [], "nothing typed, nothing shown");
  assert.deepEqual(searchItems(items, "jasmine"), []);
  assert.equal(searchItems(items, "sinandomeng", 2).length, 2, "the list is capped");
});

test("search ignores accents and punctuation", () => {
  const items = [mk("Piñipig (25-kg)", { variety: "pinipig" })];
  assert.equal(searchItems(items, "pinipig 25").length, 1);
  assert.equal(searchItems(items, "PIÑIPIG").length, 1);
});

test("the not-counted-for-a-while list starts with never counted, then the oldest", () => {
  const now = Date.parse("2026-10-22T08:00:00Z");
  const items = [mk("B", { lastCountedAt: "2026-10-20T00:00:00Z" }), mk("A", { lastCountedAt: "2026-09-01T00:00:00Z" }), mk("C"), mk("D", { lastCountedAt: "2026-10-22T01:00:00Z" })];
  assert.deepEqual(staleFirst(items, 3).map((i) => i.name), ["C", "A", "B"]);
  assert.equal(staleCount(items, 14, now), 2, "C never counted and A counted 51 days ago");
  assert.equal(staleCount(items, 0, now), 0);
  assert.equal(staleCount(items, 1, now), 3);
});

test("last counted wording", () => {
  const now = Date.parse("2026-10-22T08:00:00Z");
  assert.equal(ageText(null, now), "never counted");
  assert.equal(ageText("2026-10-22T01:00:00Z", now), "counted today");
  assert.equal(ageText("2026-10-21T07:00:00Z", now), "counted yesterday");
  assert.equal(ageText("2026-10-17T07:00:00Z", now), "counted 5 days ago");
  assert.equal(ageText("2026-07-01T00:00:00Z", now), "counted 3 months ago");
  assert.equal(titleCase("ginger sinandomeng"), "Ginger Sinandomeng");
});

const L = (productId: string, name: string, variety: string, unitGrams: number | null, loose = false) => ({ productId, name, variety, unitGrams, loose });

test("the sheet groups one kind of rice together: big sacks first, loose kilos last, unknown kinds at the end", () => {
  const lines = [L("1", "Sinandomeng (per kilo)", "sinandomeng", 1, true), L("2", "Dinorado 25 kg", "dinorado", 25_000), L("3", "Sinandomeng 25 kg", "sinandomeng", 25_000), L("4", "Plastic ties", "", null), L("5", "Sinandomeng 5 kg", "sinandomeng", 5_000)];
  const g = sheetGroups(lines);
  assert.deepEqual(g.map((x) => x.variety), ["dinorado", "sinandomeng", ""]);
  assert.deepEqual(g[1]!.lines.map((l) => l.productId), ["3", "5", "1"]);
});

test("live kilos: sacks × sack weight plus loose kilos; empty boxes are skipped; an item with no weight gives no total", () => {
  const sack = L("a", "Sin 25", "sin", 25_000);
  const bag = L("b", "Sin 5", "sin", 5_000);
  const loose = L("c", "Sin loose", "sin", 1, true);
  assert.equal(countedKg(sack, "2"), 50);
  assert.equal(countedKg(loose, "12.5"), 12.5);
  assert.equal(countedKg(sack, ""), null);
  assert.equal(groupKg([sack, bag, loose], { a: "2", b: "3", c: "12.5" }), 77.5);
  assert.equal(groupKg([sack, bag, loose], { a: "2" }), 50, "only the counted lines add up");
  assert.equal(groupKg([sack, bag], {}), null, "nothing counted yet");
  assert.equal(groupKg([L("x", "Ties", "", null)], { x: "4" }), null, "no weight, no total");
});

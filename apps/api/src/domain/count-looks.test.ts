import test from "node:test";
import assert from "node:assert/strict";
import { accStat, fastSellers, flagText, needsLook, pesoPlain, rightFirst, suggestList, suggestText, weeklyTrend, type LookCount } from "./count-looks.js";

const NOW = Date.parse("2026-10-22T08:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY);
const limits = { lookMinor: 100_000, recountMinor: 50_000 };
const line = (productId: string, leftoverQty: number, valueMinor: number, reason: string | null = "UNRINGED") => ({ productId, name: `Item ${productId}`, leftoverQty, valueMinor, reason });
const count = (id: string, daysAgo: number, lines: ReturnType<typeof line>[], over: Partial<LookCount> = {}): LookCount => ({ id, locationId: "s1", decidedAt: at(daysAgo), lookStatus: "NONE", lines, ...over });

test("a big difference is flagged in either direction; a smaller one is not", () => {
  const r = needsLook([count("c1", 1, [line("a", -1, -110_000), line("b", 1, 120_000), line("c", -1, -90_000)])], limits, NOW);
  assert.deepEqual(r[0]!.flags.map((f) => [f.kind, f.productId]), [["BIG", "b"], ["BIG", "a"]], "biggest first; ₱900 is under the limit");
});

test("an over count above the count-again limit is flagged because it adds stock; a short one of the same size is not", () => {
  const r = needsLook([count("c1", 1, [line("a", 2, 60_000, "STOCKIN_MISSING"), line("b", -2, -60_000)])], limits, NOW);
  assert.deepEqual(r[0]!.flags.map((f) => [f.kind, f.productId]), [["OVER", "a"]]);
  assert.deepEqual(needsLook([count("c1", 1, [line("a", 2, 40_000, "STOCKIN_MISSING")])], limits, NOW), [], "under the limit");
});

test("the same item short 3 times in 30 days is flagged on the counts that found it; older counts do not add up", () => {
  const counts = [count("c3", 1, [line("a", -1, -20_000)]), count("c2", 10, [line("a", -1, -20_000)]), count("c1", 20, [line("a", -1, -20_000)]), count("old", 45, [line("z", -1, -1_000)])];
  const r = needsLook(counts, limits, NOW);
  assert.deepEqual(r.map((x) => [x.id, x.flags[0]!.kind, x.flags[0]!.times]), [["c3", "REPEAT", 3], ["c2", "REPEAT", 3], ["c1", "REPEAT", 3]]);
  const twice = needsLook(counts.slice(0, 2), limits, NOW);
  assert.deepEqual(twice, [], "two times is not a pattern yet");
  const otherStore = needsLook([counts[0]!, counts[1]!, count("c1", 20, [line("a", -1, -20_000)], { locationId: "s2" })], limits, NOW);
  assert.deepEqual(otherStore, [], "another store's count does not add up");
});

test("three or more \"Don't know\" differences in one count are flagged; a correct line never counts", () => {
  const two = [line("a", -1, -1_000, "UNKNOWN"), line("b", -1, -1_000, "UNKNOWN"), line("d", 0, 0, "UNKNOWN")];
  assert.deepEqual(needsLook([count("c1", 1, two)], limits, NOW), [], "two real differences are not enough");
  const r = needsLook([count("c1", 1, [...two, line("c", 1, 1_000, "UNKNOWN"), line("e", -1, -1_000, "UNKNOWN")])], limits, NOW);
  assert.deepEqual(r[0]!.flags.map((f) => [f.kind, f.times]), [["UNKNOWN", 4]]);
});

test("a count the owner already marked OK stays out, but still counts toward a repeat; limits of 0 switch a rule off", () => {
  const counts = [count("c3", 1, [line("a", -1, -20_000)]), count("c2", 10, [line("a", -1, -20_000)], { lookStatus: "OK" }), count("c1", 20, [line("a", -1, -20_000)], { lookStatus: "OK" })];
  assert.deepEqual(needsLook(counts, limits, NOW).map((x) => x.id), ["c3"]);
  assert.deepEqual(needsLook([count("c1", 1, [line("a", -1, -500_000), line("b", 3, 500_000)])], { lookMinor: 0, recountMinor: 0 }, NOW), [], "both limits off");
});

test("the flags read in plain words", () => {
  assert.equal(flagText({ kind: "BIG", productId: "a", name: "Dinorado 25 kg", valueMinor: -125_000, times: null }), "Short ₱1,250.00 on Dinorado 25 kg");
  assert.equal(flagText({ kind: "BIG", productId: "a", name: "Dinorado 25 kg", valueMinor: 125_000, times: null }), "Over ₱1,250.00 on Dinorado 25 kg");
  assert.equal(flagText({ kind: "OVER", productId: "a", name: "Jasmine", valueMinor: 64_000, times: null }), "Over count adds stock: Jasmine (₱640.00)");
  assert.equal(flagText({ kind: "REPEAT", productId: "a", name: "Jasmine", valueMinor: -1, times: 3 }), "Jasmine was short 3 times in 30 days");
  assert.equal(flagText({ kind: "UNKNOWN", productId: null, name: null, valueMinor: null, times: 4 }), "4 differences marked “Don't know”");
  assert.equal(pesoPlain(-123_456_789), "₱1,234,567.89");
  assert.equal(pesoPlain(5), "₱0.05");
});

const it = (productId: string, sales30: number, lastDaysAgo: number | null, onHand = 5) => ({ productId, name: `Item ${productId}`, sales30, lastCountedAt: lastDaysAgo === null ? null : at(lastDaysAgo), onHand });

test("fast sellers are the top third of what sold", () => {
  const items = [it("a", 30, 1), it("b", 20, 1), it("c", 10, 1), it("d", 5, 1), it("e", 2, 1), it("f", 1, 1), it("g", 0, 1)];
  assert.deepEqual([...fastSellers(items)].sort(), ["a", "b"], "6 sold at all: the top 2");
  assert.deepEqual([...fastSellers([it("x", 0, 1)])], [], "nothing sold: nobody is fast");
  assert.deepEqual([...fastSellers([it("x", 3, 1)])], ["x"], "one seller is fast");
});

test("the suggested list: never counted first (best sellers first), then what is overdue; fast sellers weekly, the rest monthly", () => {
  const items = [
    it("fast-due", 30, 16), it("fast-ok", 20, 3), it("slow-due", 1, 40), it("slow-ok", 1, 10), it("never-slow", 1, null), it("never-fast", 25, null),
    it("never-nothing", 0, null, 0), it("gone", 0, 90, 0),
  ];
  const s = suggestList(items, NOW);
  assert.deepEqual(s.map((x) => [x.productId, x.why]), [["never-fast", "NEVER"], ["never-slow", "NEVER"], ["fast-due", "FAST"], ["slow-due", "DUE"]], "an unsold, empty, never-counted item is left out; so is one with no rice and no sales");
  assert.equal(suggestList(items, NOW, 2).length, 2);
  assert.equal(suggestText(s[0]!), "Never counted");
  assert.equal(suggestText(s[2]!), "Fast seller, counted 16 days ago");
  assert.equal(suggestText(s[3]!), "Counted 40 days ago");
  assert.deepEqual(suggestList([it("a", 1, 2)], NOW), [], "everything recent: nothing to suggest");
});

test("accuracy: right the first time means the first number matched the system; the trend is weekly, oldest first", () => {
  const l = (daysAgo: number, counted: number, first: number | null, expected: number) => ({ countedAt: at(daysAgo), countedQty: counted, firstCountedQty: first, expectedQty: expected });
  assert.equal(rightFirst(l(1, 10, null, 10)), true);
  assert.equal(rightFirst(l(1, 10, 9, 10)), false, "counted again: the first number was wrong");
  assert.deepEqual(accStat([l(1, 10, null, 10), l(1, 9, null, 10), l(1, 10, null, 10)]), { counted: 3, right: 2, pct: 67 });
  assert.deepEqual(accStat([]), { counted: 0, right: 0, pct: null });
  const lines = [l(1, 5, null, 5), l(2, 5, null, 5), l(3, 4, null, 5), l(10, 5, null, 5), l(20, 5, null, 6), l(27, 1, null, 1), l(40, 1, null, 2)];
  const t = weeklyTrend(lines, NOW);
  assert.deepEqual(t.map((w) => [w.counted, w.pct]), [[1, 100], [1, 0], [1, 100], [3, 67]], "four weeks, the last 7 days at the end; 40 days ago is outside");
});

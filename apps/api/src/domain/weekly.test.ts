import test from "node:test";
import assert from "node:assert/strict";
import { changePct, daysSince, weekRanges } from "./weekly.js";

test("this week is the 7 days ending on the chosen day; last week is the 7 before", () => {
  assert.deepEqual(weekRanges("2026-10-22"), { thisFrom: "2026-10-16", thisTo: "2026-10-22", lastFrom: "2026-10-09", lastTo: "2026-10-15" });
});

test("it crosses a month and a year", () => {
  assert.deepEqual(weekRanges("2026-01-03"), { thisFrom: "2025-12-28", thisTo: "2026-01-03", lastFrom: "2025-12-21", lastTo: "2025-12-27" });
  assert.equal(weekRanges("2024-03-03").thisFrom, "2024-02-26");
});

test("a bad date is refused", () => {
  assert.throws(() => weekRanges("22/10/2026"));
  assert.throws(() => weekRanges("2026-13-40"));
});

test("percent change keeps one decimal and says nothing when last week had no sales", () => {
  assert.equal(changePct(110, 100), 10);
  assert.equal(changePct(90, 100), -10);
  assert.equal(changePct(1, 3), -66.7);
  assert.equal(changePct(100, 0), null);
  assert.equal(changePct(0, 0), null);
});

test("days since counts whole days and is null without a date", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(daysSince(new Date("2026-10-20T13:00:00Z"), now), 1);
  assert.equal(daysSince(new Date("2026-10-15T12:00:00Z"), now), 7);
  assert.equal(daysSince(new Date("2026-10-22T11:00:00Z"), now), 0);
  assert.equal(daysSince(null, now), null);
});

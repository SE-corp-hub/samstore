// Rice Ops M9 — report helpers (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { aging, dayRange, lineCost, lineGrams, manilaDate, monthRange, pct, ReportError, stockFlag, toCsv } from "./reports.js";

test("M9: a business day is a Manila day", () => {
  const d = dayRange("2026-10-15");
  assert.equal(d.from.toISOString(), "2026-10-14T16:00:00.000Z");
  assert.equal(d.to.toISOString(), "2026-10-15T16:00:00.000Z");
  assert.equal(manilaDate(new Date("2026-10-14T16:30:00Z")), "2026-10-15", "00:30 in Manila is already the 15th");
  assert.throws(() => dayRange("2026-02-30"), ReportError);
  const m = monthRange("2026-12");
  assert.deepEqual([m.from.toISOString(), m.to.toISOString()], ["2026-11-30T16:00:00.000Z", "2026-12-31T16:00:00.000Z"]);
  assert.throws(() => monthRange("2026-13"), ReportError);
});

test("M9: cost and grams of a sale line — loose rice per kilo, sacks per piece", () => {
  assert.equal(lineCost({ soldBy: "PIECE", quantity: 2, unitCostMinor: 110_000, lineTotalMinor: 260_000 }, 0, false), 220_000);
  assert.equal(lineCost({ soldBy: "PESO", quantity: 1_923, unitCostMinor: 4_600, lineTotalMinor: 10_000 }, 0, true), 8_846);
  assert.equal(lineCost({ soldBy: null, quantity: 1, unitCostMinor: null, lineTotalMinor: 100 }, 70, false), 70, "legacy line → current cost");
  assert.equal(lineGrams({ soldBy: "PIECE", quantity: 2, grams: null }, 25_000), 50_000);
  assert.equal(lineGrams({ soldBy: "KILO", quantity: 1_250, grams: 1_250 }, 1), 1_250);
});

test("M9: utang aging — payments settle the oldest utang first", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const a = aging([
    { type: "purchase", amountMinor: 100_000, createdAt: day(70) },
    { type: "purchase", amountMinor: 50_000, createdAt: day(40) },
    { type: "purchase", amountMinor: 20_000, createdAt: day(5) },
    { type: "payment", amountMinor: -120_000, createdAt: day(1) },
  ], now);
  assert.deepEqual(a, { d0_30: 20_000, d31_60: 30_000, d60plus: 0, oldestDays: 40 });
});

test("M9: Stock Live flags, percentages and the Excel export", () => {
  assert.equal(stockFlag(false, 0), "ZERO");
  assert.equal(stockFlag(false, 2), "LOW");
  assert.equal(stockFlag(true, 5_001), "OK");
  assert.equal(pct(1, 3), 33.33);
  assert.equal(pct(1, 0), 0);
  assert.equal(toCsv([["Item", "₱"], ['Sako "25"', 1_300]]), '﻿Item,₱\r\n"Sako ""25""",1300\r\n');
});

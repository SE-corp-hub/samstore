// Rice Ops M9 — pure helpers for the owner's reports. No DB.
//
//   * Days and months are Manila days (UTC+8, no daylight saving).
//   * Sales are counted on the day they really happened (a paper slip's own time).
//   * Gross profit uses the cost frozen on each sale line (loose rice: cost per kilo);
//     legacy lines without one fall back to the product's current cost.
//   * Utang aging: payments settle the OLDEST utang first (first in, first out).

const MANILA_MS = 8 * 3_600_000;

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

/** "2026-10-15" for the Manila day of `d`. */
export function manilaDate(d: Date): string {
  return new Date(d.getTime() + MANILA_MS).toISOString().slice(0, 10);
}

/** [from, to) of a Manila day, as UTC instants. */
export function dayRange(date: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ReportError("Petsa: YYYY-MM-DD");
  const from = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(from.getTime()) || manilaDate(from) !== date) throw new ReportError("Mali ang petsa");
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

/** [from, to) of a Manila month "2026-10". */
export function monthRange(month: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new ReportError("Buwan: YYYY-MM");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = new Date(`${month}-01T00:00:00+08:00`);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  return { from, to: new Date(`${next}-01T00:00:00+08:00`) };
}

export interface CostLine { soldBy: string | null; quantity: number; unitCostMinor: number | null; lineTotalMinor: number }

/** Cost of what a sale line took off the shelf. Loose lines (grams) are costed per kilo. */
export function lineCost(l: CostLine, fallbackCostMinor: number, loose: boolean): number {
  const unit = l.unitCostMinor ?? fallbackCostMinor;
  if (loose || l.soldBy === "KILO" || l.soldBy === "PESO") return Math.round((l.quantity * unit) / 1000);
  return l.quantity * unit;
}

/** Grams a sale line moved (loose: the quantity itself; sacks: count × grams per sack). */
export function lineGrams(l: { soldBy: string | null; quantity: number; grams: number | null }, gramsPerUnit: number | null): number {
  if (l.grams !== null && l.grams !== undefined) return l.grams;
  if (l.soldBy === "KILO" || l.soldBy === "PESO") return l.quantity;
  return gramsPerUnit ? l.quantity * gramsPerUnit : 0;
}

export interface AgingBuckets { d0_30: number; d31_60: number; d60plus: number; oldestDays: number }

/** Utang aging: payments (and reductions) settle the oldest utang first. */
export function aging(entries: { type: string; amountMinor: number; createdAt: Date }[], now: Date): AgingBuckets {
  const open = entries.filter((e) => e.amountMinor > 0).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((e) => ({ at: e.createdAt, left: e.amountMinor }));
  let paid = -entries.filter((e) => e.amountMinor < 0).reduce((s, e) => s + e.amountMinor, 0);
  for (const o of open) {
    const take = Math.min(o.left, paid);
    o.left -= take;
    paid -= take;
  }
  const out: AgingBuckets = { d0_30: 0, d31_60: 0, d60plus: 0, oldestDays: 0 };
  for (const o of open) {
    if (o.left <= 0) continue;
    const days = Math.floor((now.getTime() - o.at.getTime()) / 86_400_000);
    out.oldestDays = Math.max(out.oldestDays, days);
    if (days <= 30) out.d0_30 += o.left;
    else if (days <= 60) out.d31_60 += o.left;
    else out.d60plus += o.left;
  }
  return out;
}

/** Low / zero on Stock Live: amber at 2 sacks (5 kg loose) or less, red at 0. */
export function stockFlag(loose: boolean, available: number): "ZERO" | "LOW" | "OK" {
  if (available <= 0) return "ZERO";
  return available <= (loose ? 5_000 : 2) ? "LOW" : "OK";
}

/** Percent with two decimals, safe for zero. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part * 10_000) / whole) / 100 : 0);

/** CSV that Excel opens correctly (BOM, quoted cells, CRLF). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

// Rice Ops — pure helpers for the Count screen (no browser): searching the item list,
// the "last counted" wording, and grouping a count sheet by kind of rice with a live kilo total.

import { kg, peso } from "./number-format";

export interface CountItem {
  productId: string;
  name: string;
  sku: string;
  barcode: string | null;
  /** Lower-case kind of rice ("sinandomeng"), "" when unknown. */
  variety: string;
  loose: boolean;
  /** Grams in one unit (25 000 for a 25 kg sack, 1 for loose rice), null when the item has no weight. */
  unitGrams: number | null;
  lastCountedAt: string | null;
}

const DAY = 86_400_000;

/** Lower-case, no accents, only letters/digits/spaces. */
export function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Items matching what was typed: every word must be found in the name, code, barcode or kind of rice.
 * An exact barcode or code comes first, then names that start with the text, then the rest by name.
 */
export function searchItems<T extends Pick<CountItem, "name" | "sku" | "barcode" | "variety">>(items: T[], query: string, limit = 8): T[] {
  const q = norm(query);
  if (!q) return [];
  const raw = query.trim().toLowerCase();
  const words = q.split(" ");
  const scored: { item: T; rank: number }[] = [];
  for (const item of items) {
    const exact = (item.barcode ?? "").toLowerCase() === raw || item.sku.toLowerCase() === raw;
    const name = norm(item.name);
    const hay = `${name} ${norm(item.sku)} ${norm(item.barcode ?? "")} ${norm(item.variety)}`;
    if (!exact && !words.every((w) => hay.includes(w))) continue;
    const rank = exact ? 0 : name.startsWith(q) ? 1 : name.split(" ").some((w) => w.startsWith(words[0]!)) ? 2 : 3;
    scored.push({ item, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
  return scored.slice(0, limit).map((s) => s.item);
}

/** Never-counted items first, then the ones counted longest ago. */
export function staleFirst<T extends Pick<CountItem, "name" | "lastCountedAt">>(items: T[], limit = 5): T[] {
  const t = (i: T) => (i.lastCountedAt ? Date.parse(i.lastCountedAt) : -Infinity);
  return [...items].sort((a, b) => t(a) - t(b) || a.name.localeCompare(b.name)).slice(0, limit);
}

/** How many items were not counted in the last `days` days (never counted included). */
export function staleCount(items: Pick<CountItem, "lastCountedAt">[], days: number, now = Date.now()): number {
  if (!Number.isFinite(days) || days < 1) return 0;
  return items.filter((i) => !i.lastCountedAt || Date.parse(i.lastCountedAt) < now - days * DAY).length;
}

/** "never counted" / "counted today" / "counted yesterday" / "counted 5 days ago" / "counted 3 months ago". */
export function ageText(iso: string | null, now = Date.now()): string {
  if (!iso) return "never counted";
  const days = Math.floor((now - Date.parse(iso)) / DAY);
  if (days < 1) return "counted today";
  if (days === 1) return "counted yesterday";
  if (days < 60) return `counted ${days} days ago`;
  return `counted ${Math.floor(days / 30)} months ago`;
}

export const titleCase = (s: string) => s.replace(/\b[a-zñ]/g, (c) => c.toUpperCase());

export interface SheetLine { productId: string; name: string; loose: boolean; variety?: string; unitGrams?: number | null }

/** Lines grouped by kind of rice (big sacks first, loose kilos last), so a sack and its loose rice sit together. */
export function sheetGroups<T extends SheetLine>(lines: T[]): { variety: string; lines: T[] }[] {
  const sorted = [...lines].sort((a, b) => {
    const va = a.variety ?? "";
    const vb = b.variety ?? "";
    if (va !== vb) return va === "" ? 1 : vb === "" ? -1 : va.localeCompare(vb);
    return (b.unitGrams ?? 0) - (a.unitGrams ?? 0) || a.name.localeCompare(b.name);
  });
  const out: { variety: string; lines: T[] }[] = [];
  for (const l of sorted) {
    const v = l.variety ?? "";
    const last = out[out.length - 1];
    if (last && last.variety === v) last.lines.push(l);
    else out.push({ variety: v, lines: [l] });
  }
  return out;
}

/** Kilos in what was typed for one line: kilos for loose rice, sacks × sack weight otherwise. null when empty or the item has no weight. */
export function countedKg(line: Pick<SheetLine, "loose" | "unitGrams">, value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (line.loose) return n;
  return line.unitGrams ? (n * line.unitGrams) / 1000 : null;
}

/** Total kilos counted so far in a group; null when nothing is counted yet or a counted line has no weight. */
export function groupKg(lines: Pick<SheetLine, "productId" | "loose" | "unitGrams">[], values: Record<string, string>): number | null {
  let total = 0;
  let any = false;
  for (const l of lines) {
    const v = values[l.productId] ?? "";
    if (v.trim() === "") continue;
    const k = countedKg(l, v);
    if (k === null) return null;
    total += k;
    any = true;
  }
  return any ? Math.round(total * 1000) / 1000 : null;
}

export const formatKg = (kg: number) => `${kg.toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`;

/** "Short 1 sack" / "Over 0.4 kg" / "Correct". Loose rice is counted in grams under the hood. */
export function differenceText(loose: boolean, variance: number): string {
  if (variance === 0) return "Correct";
  const abs = Math.abs(variance);
  const amount = loose ? kg(abs) : `${abs} ${abs === 1 ? "sack" : "sacks"}`;
  return `${variance < 0 ? "Short" : "Over"} ${amount}`;
}

// ───────────── the count report and the all-stores table ─────────────

/** What moved an item since the last count, in plain words. */
export const BUCKET_LABEL: Record<string, string> = {
  pumasok: "Stock in", lipat_papasok: "Transfer in", ibinalik: "Returned", resack_lumabas: "Resack (out)", nabenta: "Sold",
  lipat_palabas: "Transfer out", resack_pumasok: "Resack (in)", bawas: "Write-off", bilang: "Count", iba: "Other",
};
const BUCKET_ORDER = ["pumasok", "lipat_papasok", "ibinalik", "resack_lumabas", "nabenta", "lipat_palabas", "resack_pumasok", "bawas", "bilang", "iba"];

const unitText = (loose: boolean, n: number) => (loose ? kg(n) : `${n}`);

/** "Stock in +20 · Sold −18" (empty buckets are left out; "nothing moved" when there are none). */
export function sinceText(loose: boolean, buckets: Record<string, number>): string {
  const parts = BUCKET_ORDER.filter((k) => (buckets[k] ?? 0) !== 0).map((k) => {
    const v = buckets[k]!;
    return `${BUCKET_LABEL[k] ?? k} ${v > 0 ? "+" : "−"}${unitText(loose, Math.abs(v))}`;
  });
  return parts.length ? parts.join(" · ") : "nothing moved";
}

/** CSV that Excel opens: a BOM first, a cell quoted when it holds a comma, a quote or a line break. */
export function csvText(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
}

export const pesoText = (minor: number) => peso(Math.abs(minor));

export interface OverviewItem { productId: string; name: string; variety: string; loose: boolean; cells: Record<string, { lastCountedAt: string | null; onHand: number }> }

/** When the item was counted longest ago in any store (null = never counted somewhere it is held). */
export function oldestCount(item: Pick<OverviewItem, "cells">): number {
  let oldest = Infinity;
  for (const c of Object.values(item.cells)) oldest = Math.min(oldest, c.lastCountedAt ? Date.parse(c.lastCountedAt) : -Infinity);
  return oldest === Infinity ? Infinity : oldest;
}

/** The all-stores table: filter by words, longest-not-counted first (or by name). */
export function overviewRows<T extends OverviewItem>(items: T[], query: string, byAge: boolean): T[] {
  const words = norm(query).split(" ").filter(Boolean);
  const kept = items.filter((i) => words.every((w) => norm(`${i.name} ${i.variety}`).includes(w)));
  return kept.sort((a, b) => (byAge ? oldestCount(a) - oldestCount(b) : 0) || a.name.localeCompare(b.name));
}

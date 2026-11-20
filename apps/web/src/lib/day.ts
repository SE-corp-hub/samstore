// Open day + Close day (Z-read) on POS — what the tablet knows about a store's day, and the Z-read slip.
// The server decides (apps/api/src/reports/day-close.service.ts); this file only reads and prints.

import { useEffect, useState } from "react";
import { cachedGet, savedCopy } from "./offlineCache";
import { peso } from "./number-format";
import type { Slip } from "./slip-print";

export interface DayStatus {
  on: boolean;
  location: { id: string; name: string } | null;
  today: string;
  open: { id: string; businessDate: string; openedAt: string; openedBy: string; floatMinor: number; stale: boolean } | null;
  closedToday: { id: string; zNumber: number | null; closedAt: string | null } | null;
  suggestFloatMinor: number | null;
}

export interface DayFigures {
  location: { id: string; name: string };
  businessDate: string;
  zNumber: number | null;
  openedAt: string; openedBy: string;
  closedAt: string | null; closedBy: string | null;
  sales: { count: number; grossMinor: number; takenBackCount: number; takenBackMinor: number; netMinor: number; cashMinor: number; gcashMinor: number; creditMinor: number; otherMinor: number; encodedLater: number };
  receipts: { first: string | null; last: string | null };
  creditCollectedMinor: number;
  cash: { floatMinor: number; inMinor: number; givenBackMinor: number; paidOutMinor: number; handedOverMinor: number; shouldBeMinor: number; countedMinor: number | null; differenceMinor: number | null };
  gcash: { inMinor: number; givenBackMinor: number; shouldBeMinor: number; countedMinor: number | null; differenceMinor: number | null };
  cashOut: { what: string; amountMinor: number; at: string }[];
  cashCounts: Record<string, number> | null;
  keepFloatMinor: number | null;
  varianceReason: string | null;
  note: string | null;
  reopened: { at: string; by: string; reason: string } | null;
}

/** Bills and coins for the count, in centavos (same list as the server). */
export const DENOMINATIONS: { minor: number; label: string; coin: boolean }[] = [
  { minor: 100_000, label: "₱1,000", coin: false }, { minor: 50_000, label: "₱500", coin: false }, { minor: 20_000, label: "₱200", coin: false },
  { minor: 10_000, label: "₱100", coin: false }, { minor: 5_000, label: "₱50", coin: false }, { minor: 2_000, label: "₱20", coin: false },
  { minor: 1_000, label: "₱10", coin: true }, { minor: 500, label: "₱5", coin: true }, { minor: 100, label: "₱1", coin: true }, { minor: 25, label: "25¢", coin: true },
];

export const VARIANCE_REASONS = ["Wrong change given", "Expense not written down", "Walk-in sale not rung up", "Cash handed over not written down", "Counting mistake", "Don't know"] as const;

export const zLabel = (n: number | null | undefined) => (n ? `Z-${String(n).padStart(4, "0")}` : "Z-read");
export const dayPath = (locationId: string) => `/admin/rice/day?locationId=${encodeURIComponent(locationId)}`;

/** "20 Nov 2026" */
export function dayText(date: string): string {
  const d = new Date(`${date}T00:00:00+08:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Manila" });
}
/** "7:02 AM" */
export const timeText = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }) : "");

/** Today in Manila, as the tablet's clock sees it. */
export const manilaToday = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

// An Open day made with no signal waits on the tablet; until it reaches the server the tablet
// treats the day as open, so selling never stops for a bad signal.
const pendingKey = (locationId: string) => `sam.dayOpenPending:${locationId}`;
export function markPendingOpen(locationId: string, floatMinor: number) {
  try { window.localStorage.setItem(pendingKey(locationId), JSON.stringify({ date: manilaToday(), floatMinor, at: new Date().toISOString() })); } catch { /* convenience only */ }
}
function pendingOpen(locationId: string): { date: string; floatMinor: number; at: string } | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(locationId));
    const v = raw ? (JSON.parse(raw) as { date: string; floatMinor: number; at: string }) : null;
    return v && v.date === manilaToday() ? v : null;
  } catch { return null; }
}
function clearPending(locationId: string) {
  try { window.localStorage.removeItem(pendingKey(locationId)); } catch { /* convenience only */ }
}

/** The day of a store: the server's answer (or the saved copy), with an Open day still waiting on this tablet. */
export async function loadDay(locationId: string, opts: { savedOnly?: boolean } = {}): Promise<DayStatus | null> {
  const s = opts.savedOnly ? savedCopy<DayStatus>(dayPath(locationId)) : await cachedGet<DayStatus>(dayPath(locationId));
  if (!s) return null;
  if (s.open || s.closedToday) { if (!opts.savedOnly) clearPending(locationId); return s; }
  const p = pendingOpen(locationId);
  if (p && s.on) return { ...s, open: { id: "pending", businessDate: p.date, openedAt: p.at, openedBy: "this tablet", floatMinor: p.floatMinor, stale: false } };
  return s;
}

/** The Z-read (or X-read) on the receipt printer. */
export function zSlip(z: DayFigures, storeName: string, kind: "Z" | "X"): Slip {
  const diff = (m: number | null) => (m === null ? "" : m === 0 ? "Correct" : m < 0 ? `Short ${peso(-m)}` : `Over ${peso(m)}`);
  const lines = [
    { label: "Store", value: z.location.name },
    { label: "Day", value: dayText(z.businessDate) },
    { label: "Opened", value: `${timeText(z.openedAt)} ${z.openedBy}` },
    ...(z.closedAt ? [{ label: "Closed", value: `${timeText(z.closedAt)} ${z.closedBy ?? ""}` }] : [{ label: "Printed", value: new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }) }]),
    ...(z.receipts.first ? [{ label: "Receipts", value: z.receipts.first === z.receipts.last ? z.receipts.first : `${z.receipts.first} to ${z.receipts.last}` }] : []),
  ];
  const rows = [
    { name: `Sales (${z.sales.count})`, qty: peso(z.sales.grossMinor) },
    ...(z.sales.takenBackCount ? [{ name: `Taken back (${z.sales.takenBackCount})`, qty: `-${peso(z.sales.takenBackMinor)}` }] : []),
    { name: "NET SALES", qty: peso(z.sales.netMinor) },
    { name: "  Cash", qty: peso(z.sales.cashMinor) },
    { name: "  GCash", qty: peso(z.sales.gcashMinor) },
    { name: "  Credit", qty: peso(z.sales.creditMinor) },
    ...(z.sales.otherMinor ? [{ name: "  Other", qty: peso(z.sales.otherMinor) }] : []),
    { name: "Credit collected", qty: peso(z.creditCollectedMinor) },
    { name: "— CASH DRAWER —", qty: "" },
    { name: "Change fund", qty: peso(z.cash.floatMinor) },
    { name: "Cash in", qty: peso(z.cash.inMinor) },
    ...(z.cash.givenBackMinor ? [{ name: "Given back", qty: `-${peso(z.cash.givenBackMinor)}` }] : []),
    ...(z.cash.paidOutMinor ? [{ name: "Expenses", qty: `-${peso(z.cash.paidOutMinor)}` }] : []),
    ...(z.cash.handedOverMinor ? [{ name: "To the owner", qty: `-${peso(z.cash.handedOverMinor)}` }] : []),
    { name: "Cash should be", qty: peso(z.cash.shouldBeMinor) },
    ...(z.cash.countedMinor !== null ? [{ name: "Cash counted", qty: peso(z.cash.countedMinor) }, { name: "Cash", qty: diff(z.cash.differenceMinor) }] : []),
    { name: "— GCASH —", qty: "" },
    { name: "GCash should be", qty: peso(z.gcash.shouldBeMinor) },
    ...(z.gcash.countedMinor !== null ? [{ name: "GCash counted", qty: peso(z.gcash.countedMinor) }, { name: "GCash", qty: diff(z.gcash.differenceMinor) }] : []),
    ...(z.varianceReason ? [{ name: "Reason", qty: z.varianceReason }] : []),
    ...(z.keepFloatMinor !== null ? [{ name: "Change fund kept", qty: peso(z.keepFloatMinor) }] : []),
  ];
  return {
    storeName, locationId: z.location.id, title: kind === "Z" ? `Z-READ ${zLabel(z.zNumber)}` : "X-READ (day still open)",
    when: null, lines, rows,
    footer: z.reopened ? `REOPENED ${timeText(z.reopened.at)} by ${z.reopened.by}: ${z.reopened.reason}` : kind === "X" ? "Not a closing. The day is still open." : "End of day",
  };
}

/** Is Open day + Close day turned on (Settings)? null while not known yet. */
export function useDayOn(): boolean | null {
  const [on, setOn] = useState<boolean | null>(() => savedCopy<DayStatus>("/admin/rice/day")?.on ?? null);
  useEffect(() => { void cachedGet<DayStatus>("/admin/rice/day").then((d) => { if (d) setOn(d.on); }); }, []);
  return on;
}

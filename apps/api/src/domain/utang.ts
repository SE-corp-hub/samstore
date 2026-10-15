// Rice Ops M6 — pure rules for utang (customer credit) and its text messages. No DB.
//
//   * Money in texts reads like people write it: ₱1,250 (centavos only when there are some).
//   * Dates read "14 Okt" in Manila time.
//   * The texts carry the balances the ledger just wrote — never recomputed elsewhere.
//   * A failed text never blocks a sale; it is retried, then shows "Hindi naipadala".
//   * Reminders are once per period per customer (the period key makes them idempotent).

import { amountForGrams } from "./weight.js";

export class UtangError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UtangError";
  }
}

/**
 * ₱1,250 / ₱1,250.50 / -₱20. Texts use "P" instead of "₱": the peso sign is not in the
 * GSM alphabet, so one ₱ would cut every SMS from 160 to 70 characters (and double the cost).
 */
export function pesoText(minor: number, symbol = "₱"): string {
  if (!Number.isInteger(minor)) throw new RangeError("amount must be whole centavos");
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString("en-PH");
  const cents = abs % 100;
  return `${sign}${symbol}${whole}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

const MONTHS = ["Ene", "Peb", "Mar", "Abr", "May", "Hun", "Hul", "Ago", "Set", "Okt", "Nob", "Dis"];
const MANILA_OFFSET_MS = 8 * 3_600_000; // the Philippines has no daylight saving

/** The calendar day in Manila (UTC+8). */
export function manilaParts(d: Date): { y: number; m: number; day: number } {
  const t = new Date(d.getTime() + MANILA_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), day: t.getUTCDate() };
}

/** "14 Okt" */
export function shortDate(d: Date): string {
  const p = manilaParts(d);
  return `${p.day} ${MONTHS[p.m]}`;
}

/** "Sinandomeng 25 kg" / "Sinandomeng 25 kg +2 pa" — keeps a text to one SMS. */
export function itemsText(names: string[]): string {
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (uniq.length === 0) return "bigas";
  const first = uniq[0]!.length > 40 ? `${uniq[0]!.slice(0, 39)}…` : uniq[0]!;
  return uniq.length === 1 ? first : `${first} +${uniq.length - 1} pa`;
}

const P = (minor: number) => pesoText(minor, "P");
const firstName = (name: string) => (name.trim().split(/\s+/)[0] || "po").slice(0, 20);

export function saleText(x: { customerName: string; amountMinor: number; items: string[]; locationName: string; at: Date; balanceMinor: number }): string {
  return `Salamat po, ${firstName(x.customerName)}. Utang ngayon: ${P(x.amountMinor)} (${itemsText(x.items)}, ${x.locationName}, ${shortDate(x.at)}). Kabuuang utang: ${P(x.balanceMinor)}.`;
}

export function paymentText(x: { amountMinor: number; balanceMinor: number }): string {
  return x.balanceMinor > 0
    ? `Natanggap: ${P(x.amountMinor)}. Natitirang utang: ${P(x.balanceMinor)}. Salamat po!`
    : `Natanggap: ${P(x.amountMinor)}. Bayad na po lahat ng utang. Salamat po!`;
}

export function monthlyText(x: { customerName: string; balanceMinor: number; storeName: string; at: Date }): string {
  return `Magandang araw po, ${firstName(x.customerName)}. Utang ninyo sa ${x.storeName} hanggang ${shortDate(x.at)}: ${P(x.balanceMinor)}. Salamat po!`;
}

export function overdueText(x: { customerName: string; balanceMinor: number; days: number; storeName: string }): string {
  return `Paalala po, ${firstName(x.customerName)}: may utang kayong ${P(x.balanceMinor)} sa ${x.storeName}, ${x.days} araw na. Salamat po!`;
}

/** A credit limit decision: within, or over (→ the owner's Para sa iyo). */
export function limitCheck(balanceMinor: number, amountMinor: number, limitMinor: number): { ok: true } | { ok: false; overByMinor: number } {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new UtangError("Mali ang halaga");
  if (limitMinor <= 0) return { ok: false, overByMinor: balanceMinor + amountMinor };
  const after = balanceMinor + amountMinor;
  return after <= limitMinor ? { ok: true } : { ok: false, overByMinor: after - limitMinor };
}

/** Bayad sa utang: partial is fine; more than owed is refused. */
export function checkPayment(balanceMinor: number, amountMinor: unknown): number {
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) throw new UtangError("Ilagay ang halagang ibinayad");
  if (balanceMinor <= 0) throw new UtangError("Wala nang utang ang customer na ito");
  if (amountMinor > balanceMinor) throw new UtangError(`Sobra — ${pesoText(balanceMinor)} lang ang utang`);
  return amountMinor;
}

/** Period keys make reminders idempotent: one monthly text per month, one overdue text per week. */
export function monthKey(d: Date): string {
  const p = manilaParts(d);
  return `M${p.y}-${String(p.m + 1).padStart(2, "0")}`;
}
export function weekKey(d: Date): string {
  const p = manilaParts(d);
  const day = Date.UTC(p.y, p.m, p.day);
  return `W${Math.floor((day / 86_400_000 + 3) / 7)}`; // weeks start on Monday
}

/** Days since a date (Manila calendar days). */
export function daysSince(from: Date, now: Date): number {
  const a = manilaParts(from);
  const b = manilaParts(now);
  return Math.floor((Date.UTC(b.y, b.m, b.day) - Date.UTC(a.y, a.m, a.day)) / 86_400_000);
}

/**
 * The money behind returned rice: what those units were sold for on that order.
 * Loose rice (grams) is re-priced from the line's per-kilo price; never more than the line.
 */
export function refundValue(line: { soldBy: string | null; unitPriceMinor: number; quantity: number; lineTotalMinor: number }, units: number): number {
  if (!Number.isInteger(units) || units <= 0) return 0;
  const take = Math.min(units, line.quantity);
  if (line.soldBy === "KILO" || line.soldBy === "PESO") {
    if (take === line.quantity) return line.lineTotalMinor;
    return Math.min(line.lineTotalMinor, amountForGrams(take, line.unitPriceMinor));
  }
  return Math.min(line.lineTotalMinor, line.unitPriceMinor * take);
}

/** GSM-7 text over 160 characters splits into several SMS (and costs more). */
export function smsSegments(text: string): number {
  // "₱" and other non-GSM characters force UCS-2 (70 per segment, 67 when split).
  const ucs2 = /[^\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà€]/.test(text);
  const single = ucs2 ? 70 : 160;
  const multi = ucs2 ? 67 : 153;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

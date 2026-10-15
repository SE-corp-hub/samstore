// Rice Ops M8 — pure rules for counts (Bilangin), the balance, and write-offs (Manual na bawas).
//
//   * A count line keeps what the system expected AT THE MOMENT it was counted, so sales
//     during the count never show up as kulang/sobra (the store can stay open).
//   * Kulang (short) / Sobra (over) / Tama (right), in stock units, kilos and pesos (at cost).
//   * The balance of an item at a location: expected = last count + every movement since,
//     grouped the way the owner reads it. It must equal the shelf number in the system.
//   * A write-off over 1% of what the location holds waits for the owner (the stock moves).

import { lossBasisPoints } from "./weight.js";

export class CountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CountError";
  }
}

export type Verdict = "KULANG" | "SOBRA" | "TAMA";

export function verdict(variance: number): Verdict {
  return variance < 0 ? "KULANG" : variance > 0 ? "SOBRA" : "TAMA";
}

interface Costed { stockBaseUnit: string | null; stockBaseQuantity: number | null; costMinor: number }
export const isLooseP = (p: Pick<Costed, "stockBaseUnit" | "stockBaseQuantity">) => (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1;

/** Grams in `qty` stock units (null when the product has no weight). Signed. */
export function gramsIn(p: Pick<Costed, "stockBaseUnit" | "stockBaseQuantity">, qty: number): number | null {
  if ((p.stockBaseUnit ?? "").toLowerCase() !== "g" || !p.stockBaseQuantity) return null;
  return qty * p.stockBaseQuantity;
}

/** Value at cost of `qty` stock units (loose rice: cost is per kilo). Signed, half away from zero. */
export function costValue(p: Costed, qty: number): number {
  const sign = qty < 0 ? -1 : 1;
  const abs = Math.abs(qty);
  const v = isLooseP(p) ? Number((BigInt(abs) * BigInt(p.costMinor) + 500n) / 1000n) : abs * p.costMinor;
  return sign * v;
}

/** What staff typed for a line: whole units, or kilos for loose rice (→ grams). */
export function countedUnits(p: Pick<Costed, "stockBaseUnit" | "stockBaseQuantity">, raw: unknown): number {
  if (isLooseP(p)) {
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(",", ".") : "";
    const m = /^(\d{1,7})(?:\.(\d{1,3}))?$/.exec(text);
    if (!m) throw new CountError("Ilagay ang timbang sa kilo (hal. 12.5) — 0 kung wala");
    return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0") || 0);
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 1_000_000) throw new CountError("Ilagay ang bilang (0 kung wala)");
  return raw;
}

export interface LineResult { varianceQty: number; varianceGrams: number | null; varianceValueMinor: number; verdict: Verdict }

export function lineResult(p: Costed, expectedQty: number, countedQty: number): LineResult {
  const varianceQty = countedQty - expectedQty;
  return { varianceQty, varianceGrams: gramsIn(p, varianceQty), varianceValueMinor: costValue(p, varianceQty), verdict: verdict(varianceQty) };
}

/** Movement types that change only the RESERVED number — never part of the shelf balance. */
export const RESERVED_ONLY = new Set(["RESERVE", "RELEASE_RESERVATION"]);

/** How the owner reads the ledger (expected = last count + received + … − sold − …). */
export const BUCKET_OF: Record<string, string> = {
  RECEIPT: "pumasok", STOCK_IN: "pumasok", MERGE_IN: "pumasok",
  RECEIVE_IN: "lipat_papasok", TRANSFER_IN: "lipat_papasok",
  RELEASE_OUT: "lipat_palabas", TRANSFER_OUT: "lipat_palabas",
  RETURN_IN: "ibinalik",
  CONSUME: "nabenta", RELEASE: "nabenta", VOID_RESTORE: "nabenta",
  RESACK_IN: "resack_lumabas", CONVERSION_IN: "resack_lumabas",
  RESACK_OUT: "resack_pumasok", CONVERSION_OUT: "resack_pumasok", RESACK_RETURN: "resack_pumasok",
  WRITE_OFF: "bawas", MERGE_OUT: "bawas",
  COUNT_ADJUST: "bilang", ADJUST: "bilang",
};
export const BUCKETS = ["pumasok", "lipat_papasok", "ibinalik", "resack_lumabas", "nabenta", "lipat_palabas", "resack_pumasok", "bawas", "bilang", "iba"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** expected = base + Σ(shelf movements), with each bucket's total for the report. */
export function balanceOf(base: number, movements: { type: string; delta: number }[]): { expected: number; buckets: Record<Bucket, number> } {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  let expected = base;
  for (const m of movements) {
    if (RESERVED_ONLY.has(m.type)) continue;
    const b = (BUCKET_OF[m.type] ?? "iba") as Bucket;
    buckets[b] += m.delta;
    expected += m.delta;
  }
  return { expected, buckets };
}

export const WRITE_OFF_REASONS = ["TAPON", "BASA", "BUKBOK", "SAMPLE", "BIGAY", "IBA"] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];
export const WRITE_OFF_LABEL: Record<WriteOffReason, string> = { TAPON: "Natapon", BASA: "Nabasa", BUKBOK: "May bukbok", SAMPLE: "Sample", BIGAY: "Ibinigay", IBA: "Iba pa" };

/** A write-off: how big it is against what the location holds. Over 1% → the owner. */
export function writeOffCheck(onHandBefore: number, qty: unknown, reason: unknown, note: unknown): { qty: number; reason: WriteOffReason; lossBp: number; needsApproval: boolean } {
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) throw new CountError("Ilagay kung ilan ang ibabawas");
  if (!WRITE_OFF_REASONS.includes(reason as WriteOffReason)) throw new CountError("Pumili ng dahilan");
  if (reason === "IBA" && (typeof note !== "string" || note.trim().length < 3)) throw new CountError("Ilagay ang dahilan");
  if (qty > onHandBefore) throw new CountError(`${onHandBefore} lang ang nasa sistema dito — bilangin muna`);
  const lossBp = lossBasisPoints(onHandBefore, onHandBefore - qty);
  return { qty, reason: reason as WriteOffReason, lossBp, needsApproval: lossBp > 100 };
}

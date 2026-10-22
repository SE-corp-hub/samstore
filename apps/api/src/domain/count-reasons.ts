// Rice Ops — why a count is short or over. A reason is a LABEL recorded by hand: it never creates a
// POS sale, a write-off or a charge by itself (the automatic charge at the consignment store is separate).
//
//   * Short and over have their own lists of reasons; "Don't know" is always allowed, so a reason
//     can be asked for every difference without ever blocking a count.
//   * A big difference (worth the store's limit or more) asks to be counted again, once.

import { CountError } from "./counting.js";

export const SHORT_REASONS = ["UNRINGED", "OPENED_SACK", "SPILLED", "WET", "WEEVILS", "GIVEN", "MOVED_OUT", "MISCOUNT", "SCALE", "UNKNOWN"] as const;
export const OVER_REASONS = ["STOCKIN_MISSING", "RETURN_MISSING", "MOVED_IN", "OPENED_SACK", "MISCOUNT", "SCALE", "UNKNOWN"] as const;
export type CountReason = (typeof SHORT_REASONS)[number] | (typeof OVER_REASONS)[number];

export const REASON_LABEL: Record<CountReason, string> = {
  UNRINGED: "Sold but not rung up",
  OPENED_SACK: "Opened a sack, not recorded",
  SPILLED: "Spilled",
  WET: "Got wet",
  WEEVILS: "Weevils",
  GIVEN: "Sample or given away",
  MOVED_OUT: "Moved to another store, not recorded",
  STOCKIN_MISSING: "Stock in not recorded",
  RETURN_MISSING: "Return not recorded",
  MOVED_IN: "Moved in, not recorded",
  MISCOUNT: "Counted wrong before",
  SCALE: "Scale difference",
  UNKNOWN: "Don't know",
};

/** The reasons to offer for a difference (negative = short, positive = over). None for a correct count. */
export function reasonsFor(variance: number): readonly CountReason[] {
  return variance < 0 ? SHORT_REASONS : variance > 0 ? OVER_REASONS : [];
}

/** A reason that fits the direction of the difference, or an error a person can read. */
export function checkReason(variance: number, reason: unknown): CountReason {
  if (variance === 0) throw new CountError("That item is correct — no reason is needed");
  if (typeof reason !== "string" || !reasonsFor(variance).includes(reason as CountReason)) throw new CountError(variance < 0 ? "Choose why it is short" : "Choose why it is over");
  return reason as CountReason;
}

/** A short optional note: trimmed, at most 120 characters, null when empty. */
export function cleanNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const t = note.trim().replace(/\s+/g, " ").slice(0, 120);
  return t || null;
}

/** A difference worth the limit or more asks to be counted again (once: only while the line has not been counted again). */
export function asksRecount(varianceValueMinor: number, limitMinor: number, alreadyRecounted: boolean): boolean {
  return !alreadyRecounted && limitMinor > 0 && Math.abs(varianceValueMinor) >= limitMinor;
}

/** Lines with a difference but no valid reason yet (the submit rule). */
export function missingReasons<T extends { name: string; varianceQty: number; reason: string | null }>(lines: T[]): T[] {
  return lines.filter((l) => l.varianceQty !== 0 && !(l.reason && reasonsFor(l.varianceQty).includes(l.reason as CountReason)));
}

/** "Choose a reason for: A, B +2 more" */
export function missingReasonsMessage(names: string[]): string {
  return `Choose a reason for: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}`;
}

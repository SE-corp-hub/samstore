// Courier hand-over: the line written on the order's history when it is marked delivered.
import { pesoText } from "./utang.js";

/** "Cash collected ₱1,250", plus how far it is from the order total when it differs. */
export function cashNote(collectedMinor: number, totalMinor: number): string {
  const diff = collectedMinor - totalMinor;
  if (diff === 0) return `Cash collected ${pesoText(collectedMinor)}`;
  return `Cash collected ${pesoText(collectedMinor)} (${diff < 0 ? "short" : "over"} ${pesoText(Math.abs(diff))} of ${pesoText(totalMinor)})`;
}

// Number boxes: the same rule everywhere so nobody has to guess the decimals.
//   Peso boxes   show 2 decimals  (50 → 50.00)
//   Kilo boxes   show 3 decimals  (25 → 25.000)
//   Whole boxes  sacks and pieces, no decimals (3.7 → 3)
// Pure helpers so the rule is unit-tested without a browser.

/** Centavos as "₱1,234.50". */
export const peso = (minor: number) => `₱${(minor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Grams as "12.5 kg". */
export const kg = (g: number) => `${(g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`;

export type NumberKind = "peso" | "kilo" | "whole";

export const DECIMALS: Record<NumberKind, number> = { peso: 2, kilo: 3, whole: 0 };

/** Tidy what was typed on leaving the box: "50" → "50.00". Blank or unreadable stays blank. */
export function formatOnBlur(raw: string, kind: NumberKind): string {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return "";
  const n = Number(text);
  if (!Number.isFinite(n)) return "";
  const d = DECIMALS[kind];
  const rounded = kind === "whole" ? Math.trunc(n) : Math.round(n * 10 ** d) / 10 ** d;
  return rounded.toFixed(d);
}

/** What the box accepts while typing: digits and at most one dot, capped at the allowed decimals. */
export function cleanTyping(raw: string, kind: NumberKind): string {
  let t = raw.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const d = DECIMALS[kind];
  if (d === 0) return t.replace(/\..*$/, "");
  const first = t.indexOf(".");
  if (first >= 0) {
    const whole = t.slice(0, first);
    const frac = t.slice(first + 1).replace(/\./g, "").slice(0, d);
    t = `${whole}.${frac}`;
  }
  return t;
}

/** Typed pesos → whole centavos (null when blank or not a number). */
export function pesosToMinor(raw: string): number | null {
  const t = raw.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Typed kilos → whole grams (null when blank or not a number). */
export function kilosToGrams(raw: string): number | null {
  const t = raw.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

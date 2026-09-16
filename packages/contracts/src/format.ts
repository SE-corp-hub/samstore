// @sam-store/contracts — Philippines context formatters (P1).
// Pure, deterministic, dependency-free. Money stays in integer minor units.
// Timestamps render in Asia/Manila regardless of the host timezone.

// ─────────────────────────────── Peso formatting ───────────────────────────────

/** Format integer minor units as a PHP string: 123450 → "₱1,234.50". */
export function formatPesos(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new Error(`formatPesos expects a non-negative integer minor value, got ${minor}`);
  }
  const pesos = Math.floor(minor / 100);
  const cents = minor % 100;
  return `₱${pesos.toLocaleString("en-PH")}.${String(cents).padStart(2, "0")}`;
}

// ─────────────────────────────── Asia/Manila time ───────────────────────────────

/** Current wall-clock time in Asia/Manila returned as a local Date whose fields are the Manila time. */
export function manilaNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
}

/** Format any date in Asia/Manila, e.g. "Sep 16, 2026 · 9:30 PM". */
export function formatManila(
  date: Date | string | number,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  const d = typeof date === "object" ? date : new Date(date);
  const defaults: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-PH", {
      ...defaults,
      ...opts,
      timeZone: "Asia/Manila",
    }).format(d);
  } catch {
    // Never let a formatting edge crash a receipt/order flow.
    return d.toISOString();
  }
}

// ─────────────────────────────── Peso in words (Filipino) ───────────────────────────────
// Pragmatic Filipino/Baybay memory of amounts for receipts (e.g. "Isang libo,
// dalawang daan at tatlumpu't apat na piso"). Covers 0 – 999,999,999,999.99.
// Notes: "at" joins within a group; scale groups are space-joined; centavos are
// appended as "<words> na sentimo". FORMAL-ish; numbers ending in 4/6/9 use "na".

const ONES: ReadonlyArray<string> = [
  "",
  "isa",
  "dalawa",
  "tatlo",
  "apat",
  "lima",
  "anim",
  "pito",
  "walo",
  "siyam",
];
const NUM_1_19: ReadonlyArray<string> = [
  "",
  "isa",
  "dalawa",
  "tatlo",
  "apat",
  "lima",
  "anim",
  "pito",
  "walo",
  "siyam",
  "sampu",
  "labing isa",
  "labing dalawa",
  "labing tatlo",
  "labing apat",
  "labing lima",
  "labing anim",
  "labing pito",
  "labing walo",
  "labing siyam",
];
const TENS: ReadonlyArray<string> = [
  "",
  "sampu",
  "dalawampu",
  "tatlumpu",
  "apatnapu",
  "limampu",
  "animnapu",
  "pitumpu",
  "walumpu",
  "siyamnapu",
];

/** 1–99 alone (returns "" for 0). */
function twoDigits(n: number): string {
  if (n <= 0) return "";
  if (n < 20) return NUM_1_19[n] ?? "";
  const t = Math.floor(n / 10);
  const o = n % 10;
  if (o === 0) return TENS[t] ?? "";
  return `${TENS[t] ?? ""}'t ${ONES[o] ?? ""}`;
}

function hundredLink(h: number): string {
  if (h === 1) return "isang daan";
  if (h === 4 || h === 6 || h === 9) return `${ONES[h] ?? ""} na raan`;
  return `${ONES[h] ?? ""}ng daan`;
}

/** 1–999 in words (returns "" for 0). */
function groupWords(n: number): string {
  if (n <= 0) return "";
  if (n < 100) return twoDigits(n);
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    if (r === 0) return hundredLink(h);
    return `${hundredLink(h)} at ${twoDigits(r)}`;
  }
  // Defensive fallback for callers that pass ≥1000.
  return numberToWords(n);
}

/** Ligature rules when a numeral phrase precedes "libo/milyon/bilyon/piso". */
const LIGATURES: Record<string, string> = {
  isa: "isang",
  dalawa: "dalawang",
  tatlo: "tatlong",
  apat: "apat na",
  lima: "limang",
  anim: "anim na",
  pito: "pitong",
  walo: "walong",
  siyam: "siyam na",
  sampu: "sampung",
  dalawampu: "dalawampung",
  tatlumpu: "tatlumpung",
  apatnapu: "apatnapung",
  limampu: "limampung",
  animnapu: "animnapung",
  pitumpu: "pitumpung",
  walumpu: "walumpung",
  siyamnapu: "siyamnapung",
  daan: "daang",
  raan: "raang",
  libo: "libong",
  milyon: "milyong",
  bilyon: "bilyong",
};

/** Apply the ligature to the LAST word so the phrase can precede a scale noun. */
function linkNumeral(phrase: string): string {
  const words = phrase.trim().split(/\s+/);
  if (words.length === 0) return phrase;
  const last = words[words.length - 1] ?? "";
  const lig = LIGATURES[last];
  if (!lig) return phrase;
  words[words.length - 1] = lig;
  return words.join(" ");
}

/** Positive integer part in words ("dalawang libo", "isang milyon" …). */
function numberToWords(n: number): string {
  if (n === 0) return "zero";
  const scales: Array<[number, string]> = [
    [1_000_000_000, "bilyon"],
    [1_000_000, "milyon"],
    [1_000, "libo"],
  ];
  const parts: string[] = [];
  let rest = n;
  for (const [div, word] of scales) {
    const q = Math.floor(rest / div);
    if (q > 0) {
      parts.push(`${linkNumeral(groupWords(q))} ${word}`);
      rest -= q * div;
    }
  }
  if (rest > 0) parts.push(linkNumeral(groupWords(rest)));
  return parts.join(" ");
}

/** Integer minor units → Filipino amount in words, e.g. 123456 → "isang libo, dalawang daan at tatlumpu't apat na piso at limampu't anim na sentimo". */
export function pesoInWords(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new Error(`pesoInWords expects a non-negative integer minor value, got ${minor}`);
  }
  const pesoPart = Math.floor(minor / 100);
  const centavoPart = minor % 100;

  const pesoWords =
    pesoPart === 0
      ? "zero piso"
      : pesoPart === 1
        ? "isang piso"
        : `${linkNumeral(numberToWords(pesoPart))} piso`;

  if (centavoPart === 0) return pesoWords;
  const centavoWords =
    centavoPart === 1 ? "isang sentimo" : `${linkNumeral(twoDigits(centavoPart))} sentimo`;
  return `${pesoWords} at ${centavoWords}`;
}
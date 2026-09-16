// Phone domain helpers (A1) — the ONE place a phone number is normalized.
// PH DPA: a phone number is personal data; every entry point that stores or
// matches one MUST pass through toE164 first so we never mint duplicate humans.

const E164_COUNTRY_CODE = "+63"; // operator decision: Philippine market only

const PH_RE = /^(?:\+?63|0)?\s*9\d{2}\s*-?\s*\d{3}\s*-?\s*\d{4}$/;

/**
 * Normalizes a Philippine mobile number to E.164 (+639…).
 * Accepts 09xxxxxxxxx, 9xxxxxxxxx, 639xxxxxxxxx, +639xxxxxxxxx and
 * spaced/dashed variants. Anything else is rejected.
 * Returns "" (never throws) when the input is not a valid PH mobile.
 */
export function toE164(phone: string | null | undefined): string {
  const raw = (phone ?? "").replace(/[\s-]/g, "");
  if (!PH_RE.test(raw)) return "";
  let digits = raw;
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("63")) return `+${digits}`;
  if (digits.startsWith("0")) return `+63${digits.slice(1)}`;
  return `+63${digits}`;
}

/** True when the value is a recognizable PH mobile (accepts the same spellings). */
export function isPhMobile(phone: string | null | undefined): boolean {
  return toE164(phone) !== "";
}

/** 0917 123 4567 — display form for the UI. */
export function formatPh(phone: string | null | undefined): string {
  const e = toE164(phone);
  if (!e) return phone ?? "";
  const d = e.slice(3); // drop +63
  return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}
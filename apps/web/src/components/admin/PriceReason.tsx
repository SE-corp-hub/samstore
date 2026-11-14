"use client";

// Why the price was changed: three choices only, so the owner's report can be read at a glance.
export const PRICE_REASONS = ["Discount", "Unit price", "Special price (regular customer)"] as const;

export const reasonOk = (r: string | undefined | null) => (PRICE_REASONS as readonly string[]).includes(r ?? "");

export default function PriceReason({ value, onChange, invalid = false, className = "form-select", id, short = false, disabled = false }: { value: string; onChange: (v: string) => void; invalid?: boolean; className?: string; id?: string; /** A narrow box with its own label beside it: the empty choice just says "Choose…". */ short?: boolean; /** Greyed out while the price is still the usual one. */ disabled?: boolean }) {
  return (
    <select id={id} className={`${className}${invalid ? " is-invalid" : ""}`} aria-label="Why the price changed" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{short ? "Choose…" : "Why the price changed…"}</option>
      {PRICE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
  );
}

/** The words on the reason buttons: short enough for three in one row beside the price pad. */
const SHORT: Record<string, string> = { "Special price (regular customer)": "Regular customer" };

/** The reason picked last on this device: a changed price starts with it already chosen (first time: Discount). */
const LAST_KEY = "sam.priceReason";
export function lastReason(): string {
  try { const r = window.localStorage.getItem(LAST_KEY); if (reasonOk(r)) return r!; } catch { /* convenience only */ }
  return PRICE_REASONS[0];
}
export function saveLastReason(r: string) {
  try { if (reasonOk(r)) window.localStorage.setItem(LAST_KEY, r); } catch { /* convenience only */ }
}

/**
 * The reason as three big buttons in one row, one of them always chosen (no drop-down to open, nothing
 * to scroll to). Tapping one also makes it the choice next time on this device.
 */
export function ReasonButtons({ value, onChange, label = "Why?" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="reason-buttons" role="radiogroup" aria-label="Why the price changed">
      <span className="reason-label">{label}</span>
      {PRICE_REASONS.map((r) => (
        <button key={r} type="button" role="radio" aria-checked={value === r} title={r}
          className={`btn ${value === r ? "btn-dark" : "btn-outline-dark"}`}
          onClick={() => { onChange(r); saveLastReason(r); }}>
          {value === r && <i className="bi bi-check-lg me-1" aria-hidden="true"></i>}{SHORT[r] ?? r}
        </button>
      ))}
    </div>
  );
}

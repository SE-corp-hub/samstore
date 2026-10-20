"use client";

// Why the price was changed: three choices only, so the owner's report can be read at a glance.
export const PRICE_REASONS = ["Discount", "Unit price", "Special price (regular customer)"] as const;

export const reasonOk = (r: string | undefined | null) => (PRICE_REASONS as readonly string[]).includes(r ?? "");

export default function PriceReason({ value, onChange, invalid = false, className = "form-select", id }: { value: string; onChange: (v: string) => void; invalid?: boolean; className?: string; id?: string }) {
  return (
    <select id={id} className={`${className}${invalid ? " is-invalid" : ""}`} aria-label="Why the price changed" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Why the price changed…</option>
      {PRICE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
  );
}

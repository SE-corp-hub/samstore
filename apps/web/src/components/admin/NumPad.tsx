"use client";

// Rice Ops M5 — the big on-screen number pad. Numbers never go through the phone
// keyboard: 64 px keys, equal-width digits, one thumb. `decimals` allows one "." (kilos).

export default function NumPad({
  value,
  onChange,
  decimals = 0,
  maxLength = 9,
  label,
  unit,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Digits allowed after the point (0 = whole numbers only). */
  decimals?: number;
  maxLength?: number;
  label: string;
  unit?: string;
}) {
  const press = (k: string) => {
    if (k === "⌫") return onChange(value.slice(0, -1));
    if (k === "C") return onChange("");
    if (k === ".") {
      if (decimals === 0 || value.includes(".")) return;
      return onChange(value === "" ? "0." : `${value}.`);
    }
    const [, frac] = value.split(".");
    if (frac !== undefined && frac.length >= decimals) return;
    if (value.length >= maxLength) return;
    onChange(value === "0" ? k : `${value}${k}`);
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", decimals > 0 ? "." : "C", "0", "⌫"];
  return (
    <div>
      <div className="border rounded-3 px-3 py-2 mb-2 text-end bg-white" aria-live="polite" aria-label={label}
        style={{ fontSize: 34, fontVariantNumeric: "tabular-nums", minHeight: 64 }}>
        {value || <span className="text-muted">0</span>}{unit ? <span className="fs-5 ms-2 text-muted">{unit}</span> : null}
      </div>
      <div className="d-grid gap-2" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {keys.map((k) => (
          <button key={k} type="button" className="btn btn-light border" style={{ fontSize: 26, minHeight: 64, fontVariantNumeric: "tabular-nums" }}
            aria-label={k === "⌫" ? "Delete last digit" : k === "C" ? "Clear all" : k} onClick={() => press(k)}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

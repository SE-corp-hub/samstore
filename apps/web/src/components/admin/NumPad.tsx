"use client";

import { useState, type ReactNode } from "react";

// Rice Ops M5 — the big on-screen number pad. Numbers never go through the phone
// keyboard: 64 px keys (48 px on a short screen, the tablet held sideways — easy-read.css §9),
// equal-width digits, one thumb. `decimals` allows one "." (kilos).

export default function NumPad({
  value,
  onChange,
  decimals = 0,
  maxLength = 9,
  label,
  unit,
  startFresh = false,
  lead,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Digits allowed after the point (0 = whole numbers only). */
  decimals?: number;
  maxLength?: number;
  label: string;
  unit?: string;
  /** The value shown is a ready-made guess (e.g. 1 sack): the first digit replaces it. */
  startFresh?: boolean;
  /** A control that shares the row with the amount shown (the Kilos / Pesos switch), so it costs no extra row. */
  lead?: ReactNode;
}) {
  const [fresh, setFresh] = useState(startFresh);
  const press = (k: string) => {
    if (fresh) {
      setFresh(false);
      if (/\d/.test(k)) return onChange(k);
    }
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
  const display = (
    <div className={`border rounded-3 px-3 text-end bg-white numpad-display${lead ? " flex-grow-1" : " mb-2"}`} aria-live="polite" aria-label={label}>
      {value || <span className="text-muted">0</span>}{unit ? <span className="fs-5 ms-2 text-muted">{unit}</span> : null}
    </div>
  );
  return (
    <div>
      {lead ? <div className="d-flex align-items-stretch gap-2 mb-2">{lead}{display}</div> : display}
      <div className="numpad-keys">
        {keys.map((k) => (
          <button key={k} type="button" className="btn btn-light border numpad-key"
            aria-label={k === "⌫" ? "Delete last digit" : k === "C" ? "Clear all" : k} onClick={() => press(k)}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

"use client";

// POS tab: Walk-in (quick cash sale) or Full sale (credit, GCash, special prices, paper slips).
// The choice is kept on this tablet, so the counter opens where it sells most.

import { useEffect, useState } from "react";
import BentaPanel from "./BentaPanel";
import WalkInPanel from "./WalkInPanel";

type Mode = "walkin" | "full";
const KEY = "pos-mode";

function savedMode(): Mode {
  try { return window.localStorage.getItem(KEY) === "full" ? "full" : "walkin"; } catch { return "walkin"; }
}

export default function PosPanel() {
  const [mode, setMode] = useState<Mode>("walkin");
  useEffect(() => { setMode(savedMode()); }, []);
  const pick = (m: Mode) => {
    setMode(m);
    try { window.localStorage.setItem(KEY, m); } catch { /* convenience only */ }
  };
  // The switch sits at the top of the product column (the panels place it), so the sale card can start at the very top.
  const switcher = (
    <div className="btn-group w-100 mb-2" role="group" aria-label="Kind of sale">
      <button type="button" className={`btn fw-semibold ${mode === "walkin" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={mode === "walkin"} onClick={() => pick("walkin")}>
        <i className="bi bi-lightning-charge me-1" aria-hidden="true"></i>Walk-in
      </button>
      <button type="button" className={`btn fw-semibold ${mode === "full" ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={mode === "full"} onClick={() => pick("full")}>
        <i className="bi bi-basket me-1" aria-hidden="true"></i>Full sale
        <span className="seg-caption">Credit, GCash, special price</span>
      </button>
    </div>
  );
  return mode === "walkin" ? <WalkInPanel switcher={switcher} /> : <BentaPanel switcher={switcher} />;
}

"use client";

// Add several products at once: one row per product, type like a spreadsheet.
// Sold as Sack (price per sack, kilos in a sack), Kilo (price per kilo, loose rice) or Piece.
// The code (SKU) is made for you. Stock starts at 0 — put the first stock in through Stock in.

import { useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { isBelowCost, pesoToMinor } from "../../lib/below-cost";
import { askBelowCost } from "./BelowCostDialog";

type SoldAs = "SACK" | "KILO" | "PIECE";
interface Row { name: string; soldAs: SoldAs; kilos: string; price: string; cost: string; track: boolean; state: "idle" | "ok" | string }
const blank = (): Row => ({ name: "", soldAs: "SACK", kilos: "25", price: "", cost: "", track: true, state: "idle" });
const dec = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 10);
const skuOf = (name: string) => `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "ITEM"}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

export default function AddSeveralProducts({ onClose, onDone }: { onClose: () => void; onDone: () => void | Promise<void> }) {
  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const patch = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p, state: "idle" } : r)));
  const used = rows.filter((r) => r.name.trim() || r.price);
  const valid = (r: Row) => r.name.trim().length >= 2 && Number(r.price) > 0 && (r.soldAs !== "SACK" || Number(r.kilos) > 0);
  const ready = used.length > 0 && used.every(valid) && !busy;

  const save = async () => {
    setBusy(true);
    const next = [...rows];
    // Rows priced under their cost: ask about each one before anything is saved.
    for (let i = 0; i < next.length; i++) {
      const r = next[i]!;
      const price = pesoToMinor(r.price) ?? 0, cost = pesoToMinor(r.cost) ?? 0;
      if (r.state === "ok" || !isBelowCost(price, cost)) continue;
      const pick = await askBelowCost({ name: r.name.trim() || `Row ${i + 1}`, priceMinor: price, costMinor: cost, unit: r.soldAs === "KILO" ? "kilo" : r.soldAs === "SACK" ? "sack" : "piece", showCost: true, canChangeCost: true, proceed: "Save anyway" });
      if (!pick) { setRows(next); setBusy(false); return; }
      if (pick.kind === "price") next[i] = { ...r, price: (pick.priceMinor / 100).toFixed(2) };
      if (pick.kind === "cost") next[i] = { ...r, cost: (pick.costMinor / 100).toFixed(2) };
    }
    let okCount = 0;
    for (let i = 0; i < next.length; i++) {
      const r = next[i]!;
      if (!(r.name.trim() || r.price) || r.state === "ok") continue;
      const body = {
        name: r.name.trim(), sku: skuOf(r.name), priceMinor: Math.round(Number(r.price) * 100), costMinor: r.cost ? Math.round(Number(r.cost) * 100) : undefined,
        unit: r.soldAs === "KILO" ? "kilo" : r.soldAs === "SACK" ? "sako" : "pc",
        stockBaseUnit: r.soldAs === "PIECE" ? null : "g",
        stockBaseQuantity: r.soldAs === "SACK" ? Math.round(Number(r.kilos) * 1000) : r.soldAs === "KILO" ? 1 : null,
        soldByWeight: r.soldAs === "KILO",
        stockConversionFamily: r.soldAs === "PIECE" ? null : "Bigas",
        trackStock: r.soldAs === "PIECE" ? r.track : true,
      };
      try {
        const res = await fetch(`${API_URL}/admin/products`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
        const d = (await res.json().catch(() => null)) as { message?: string; errors?: string[] } | null;
        next[i] = res.ok ? { ...r, state: "ok" } : { ...r, state: d?.errors?.join(", ") ?? d?.message ?? "Not saved" };
        if (res.ok) okCount++;
      } catch { next[i] = { ...r, state: "No signal" }; }
    }
    setRows(next);
    setBusy(false);
    if (okCount) { toast(`Added ${okCount} product${okCount > 1 ? "s" : ""}`); await onDone(); }
    if (next.every((r) => r.state === "ok" || !(r.name.trim() || r.price))) onClose();
  };

  return (
    <div className="card border-success mb-3">
      <div className="card-body">
        <h2 className="h5">Add several products</h2>
        <p className="text-muted small mb-2">One row per product. Price is per sack, per kilo or per piece, depending on “Sold as”. Stock starts at 0 — receive the first stock in Stock in.</p>
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead><tr><th>Name</th><th style={{ width: 130 }}>Sold as</th><th style={{ width: 90 }}>Kg / sack</th><th style={{ width: 110 }}>Price ₱</th><th style={{ width: 110 }}>Cost ₱</th><th style={{ width: 40 }}></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.state === "ok" ? "table-success" : r.state !== "idle" ? "table-danger" : ""}>
                  <td>
                    <input className="form-control" aria-label={`Name ${i + 1}`} value={r.name} onChange={(e) => patch(i, { name: e.target.value.slice(0, 80) })} />
                    {r.state !== "idle" && r.state !== "ok" && <div className="small text-danger">{r.state}</div>}
                  </td>
                  <td>
                    <select className="form-select" aria-label="Sold as" value={r.soldAs} onChange={(e) => patch(i, { soldAs: e.target.value as SoldAs })}>
                      <option value="SACK">Sack</option><option value="KILO">Kilo</option><option value="PIECE">Piece</option>
                    </select>
                  </td>
                  <td><input className="form-control text-end" aria-label="Kilos per sack" inputMode="decimal" disabled={r.soldAs !== "SACK"} value={r.soldAs === "SACK" ? r.kilos : ""} onChange={(e) => patch(i, { kilos: dec(e.target.value) })} /></td>
                  <td><input className={`form-control text-end${isBelowCost(pesoToMinor(r.price), pesoToMinor(r.cost)) ? " is-invalid" : ""}`} aria-label="Price" inputMode="decimal" placeholder="0.00" value={r.price} onChange={(e) => patch(i, { price: dec(e.target.value) })} /></td>
                  <td><input className="form-control text-end" aria-label="Cost" inputMode="decimal" placeholder="0.00" value={r.cost} onChange={(e) => patch(i, { cost: dec(e.target.value) })} /></td>
                  <td>{rows.length > 1 && <button type="button" className="btn btn-link text-danger p-0" aria-label="Remove row" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="d-flex flex-wrap justify-content-between gap-2">
          <button type="button" className="btn btn-outline-secondary" onClick={() => setRows([...rows, blank(), blank(), blank()])}>+ 3 more rows</button>
          <span className="d-flex gap-2">
            <button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={onClose}>Close</button>
            <button type="button" className="btn btn-success" disabled={!ready} onClick={() => void save()}>{busy ? "Saving…" : `Save ${used.length || ""} product${used.length === 1 ? "" : "s"}`}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

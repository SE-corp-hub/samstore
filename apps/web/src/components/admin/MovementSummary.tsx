"use client";

// Stock movement summary (owner and manager): every item at one store, or all places together, for some days —
// what was there at the start, what was bought, moved in and out, sold, resacked, fixed by a count, returned, and what is there at the end.
// Start + the columns = End. Print or Excel.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { downloadCsv } from "../../lib/count-view";
import { printTable } from "../../lib/table-print";

const COLS = [
  ["bought", "Bought"], ["movedIn", "Moved in"], ["movedOut", "Moved out"], ["sold", "Sold"], ["resack", "Resack"], ["countFix", "Count fix"], ["returns", "Returns / cancelled"], ["other", "Other"],
] as const;
type ColKey = (typeof COLS)[number][0];
type Row = { productId: string; name: string; loose: boolean; start: number; end: number } & Record<ColKey, number>;
type Kilos = { start: number; end: number } & Record<ColKey, number>;
interface Data { location: { id: string | null; name: string }; from: string; to: string; rows: Row[]; kilos: Kilos }
interface Loc { id: string; name: string; isActive: boolean }

const todayStr = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 8 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);
const num = (n: number) => n.toLocaleString("en-PH", { maximumFractionDigits: 3 });
/** Loose rice is kept in grams and shown in kilos. A zero is a dash; a change gets its + or − sign. */
const cell = (loose: boolean, n: number, signed: boolean) => {
  if (n === 0) return "–";
  const v = loose ? n / 1000 : n;
  return `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v))}`;
};
const niceDate = (d: string) => new Date(`${d}T12:00:00+08:00`).toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" });

export default function MovementSummary() {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [locationId, setLocationId] = useState("");
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      setLocations(((d?.warehouses ?? []) as Loc[]).filter((l) => l.isActive));
    }).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const q = new URLSearchParams({ from, to, ...(locationId ? { locationId } : {}) });
      const res = await fetch(`${API_URL}/admin/rice/movement-summary?${q}`, { headers: adminHeaders() });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.errors?.join(", ") ?? body?.message ?? "Could not load the summary"); setData(null); return; }
      setData(body as Data);
    } catch { setError("Could not load the summary"); setData(null); } finally { setBusy(false); }
  }, [from, to, locationId]);

  useEffect(() => { void load(); /* once, then on the button */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subtitle = data ? `${data.location.name} · ${niceDate(data.from)} to ${niceDate(data.to)}` : "";
  const head = ["Item", "Start", ...COLS.map(([, l]) => l), "End"];

  const printIt = () => {
    if (!data) return;
    printTable({
      title: "Stock movement summary", subtitle, head,
      rows: data.rows.map((r) => [r.name + (r.loose ? " (kg)" : ""), cell(r.loose, r.start, false), ...COLS.map(([k]) => cell(r.loose, r[k], true)), cell(r.loose, r.end, false)]),
      foot: [["Total kilos", num(data.kilos.start), ...COLS.map(([k]) => (data.kilos[k] === 0 ? "–" : `${data.kilos[k] > 0 ? "+" : "−"}${num(Math.abs(data.kilos[k]))}`)), num(data.kilos.end)]],
    });
  };
  const excel = () => {
    if (!data) return;
    downloadCsv(`stock-movement-${data.from}-to-${data.to}.csv`, [
      ["Item", "Unit", "Start", ...COLS.map(([, l]) => l), "End"],
      ...data.rows.map((r) => [r.name, r.loose ? "kg" : "pcs", r.loose ? r.start / 1000 : r.start, ...COLS.map(([k]) => (r.loose ? r[k] / 1000 : r[k])), r.loose ? r.end / 1000 : r.end]),
      ["Total kilos", "kg", data.kilos.start, ...COLS.map(([k]) => data.kilos[k]), data.kilos.end],
    ]);
  };

  return (
    <div>
      <p className="text-muted small">Every item: what was there at the start, what happened, and what is there at the end. Start plus the columns equals End. Sacks are counted in pieces; loose rice in kilos.</p>
      <div className="row g-2 align-items-end mb-3">
        <div className="col-12 col-md-4">
          <label className="form-label small mb-1" htmlFor="ms-loc">Where</label>
          <select id="ms-loc" className="form-select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All places together</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="col-6 col-md-2"><label className="form-label small mb-1" htmlFor="ms-from">From</label><input id="ms-from" type="date" className="form-control" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="col-6 col-md-2"><label className="form-label small mb-1" htmlFor="ms-to">To</label><input id="ms-to" type="date" className="form-control" value={to} min={from} max={todayStr()} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="col-12 col-md-4 d-flex gap-2">
          <button type="button" className="btn btn-primary" disabled={busy || !from || !to} onClick={() => void load()}>{busy ? "Please wait…" : "Show"}</button>
          <button type="button" className="btn btn-outline-dark" disabled={!data || data.rows.length === 0} onClick={printIt}>Print</button>
          <button type="button" className="btn btn-outline-dark" disabled={!data || data.rows.length === 0} onClick={excel}>Excel</button>
        </div>
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {data && (
        data.rows.length === 0 ? <p className="text-muted">Nothing moved in these dates, and nothing was on the shelf.</p> : (
          <div className="table-responsive">
            <table className="table table-sm align-middle">
              <thead><tr><th>Item</th><th className="text-end">Start</th>{COLS.map(([k, l]) => <th key={k} className="text-end">{l}</th>)}<th className="text-end">End</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.productId}>
                    <td>{r.name}{r.loose ? <span className="text-muted small"> (kg)</span> : null}</td>
                    <td className="text-end">{cell(r.loose, r.start, false)}</td>
                    {COLS.map(([k]) => <td key={k} className={`text-end ${r[k] < 0 ? "text-danger" : r[k] > 0 ? "text-success" : "text-muted"}`}>{cell(r.loose, r[k], true)}</td>)}
                    <td className="text-end fw-semibold">{cell(r.loose, r.end, false)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="fw-semibold"><td>Total kilos</td><td className="text-end">{num(data.kilos.start)}</td>{COLS.map(([k]) => <td key={k} className="text-end">{data.kilos[k] === 0 ? "–" : `${data.kilos[k] > 0 ? "+" : "−"}${num(Math.abs(data.kilos[k]))}`}</td>)}<td className="text-end">{num(data.kilos.end)}</td></tr>
              </tfoot>
            </table>
          </div>
        )
      )}
    </div>
  );
}

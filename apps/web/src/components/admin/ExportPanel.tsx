"use client";

// Owner's data export: pick dates and a file type, get one file with every part of the
// store (sales, products, stock, moves, payable, expenses, customers) for analysis elsewhere.

import { useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, handleUnauthorized } from "../../lib/admin";
import { wakeFetch } from "../../lib/wake-fetch";
import { useOffline } from "../../lib/offlineCache";
import { toast } from "../../lib/toast";

const DAY = 86_400_000;
/** Today in Manila as YYYY-MM-DD (the store's clock, whatever the tablet's setting). */
const manilaDay = (ms = Date.now()) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => manilaDay(new Date(`${day}T00:00:00+08:00`).getTime() + n * DAY);

type Preset = "7" | "30" | "month" | "lastmonth" | "year" | "custom";
function presetRange(p: Preset, today = manilaDay()): [string, string] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  switch (p) {
    case "7": return [addDays(today, -6), today];
    case "month": return [`${today.slice(0, 7)}-01`, today];
    case "lastmonth": {
      const first = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-01`;
      return [first, addDays(`${today.slice(0, 7)}-01`, -1)];
    }
    case "year": return [`${y}-01-01`, today];
    default: return [addDays(today, -29), today];
  }
}

const PRESETS: [Preset, string][] = [["7", "Last 7 days"], ["30", "Last 30 days"], ["month", "This month"], ["lastmonth", "Last month"], ["year", "This year"], ["custom", "Pick dates"]];
const FORMATS = [
  { id: "xlsx", label: "Excel", icon: "bi-file-earmark-spreadsheet", note: "One file, a sheet for each part (the usual choice)." },
  { id: "csv", label: "CSV (zip)", icon: "bi-file-earmark-zip", note: "One CSV file for each part, zipped. For programs and databases." },
  { id: "json", label: "JSON", icon: "bi-filetype-json", note: "One file for apps that import data." },
] as const;
const PARTS = ["Sales and each item sold (with cost and profit)", "Products and prices per location", "Stock now and every stock change", "Moves, stock in and resack", "Store payable", "Expenses", "Customers and credit"];

const chip = (on: boolean) => `btn ${on ? "btn-dark" : "btn-outline-dark"} rounded-pill`;

export default function ExportPanel() {
  const offline = useOffline();
  const [preset, setPreset] = useState<Preset>("30");
  const [[from, to], setRange] = useState<[string, string]>(() => presetRange("30"));
  const [format, setFormat] = useState<(typeof FORMATS)[number]["id"]>("xlsx");
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  };
  const badRange = !from || !to || from > to;

  const download = async () => {
    if (badRange || busy) return;
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ from, to, format });
      const res = await wakeFetch(`${API_URL}/admin/export?${q}`, { headers: adminHeaders(), cache: "no-store" }, setWaking);
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(res.status === 403 ? "Only the store owner can export data." : d?.message ?? "Could not make the file. Try again.");
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `store-data-${from}-to-${to}.${format === "csv" ? "zip" : format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast(`Saved ${name} to Downloads`);
    } catch (e) {
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "No connection to the server. Check the internet and try again.");
    } finally {
      setBusy(false);
      setWaking(false);
    }
  };

  return (
    <div className="export-panel" style={{ maxWidth: 760 }}>
      <h1 className="h4 mb-1"><i className="bi bi-download me-2" aria-hidden="true"></i>Export data</h1>
      <p className="text-muted mb-4">Download your store&apos;s data as one file to look at in another program, like your SamRice analysis. Money is in pesos, loose rice in kilos, times in Philippine time.</p>

      <section className="card mb-3" aria-labelledby="exp-dates">
        <div className="card-body">
          <h2 className="h6 mb-3" id="exp-dates">Which dates?</h2>
          <div className="d-flex flex-wrap gap-2 mb-3" role="group" aria-label="Dates">
            {PRESETS.map(([id, label]) => (
              <button key={id} type="button" className={chip(preset === id)} style={{ minHeight: 44 }} aria-pressed={preset === id} onClick={() => pick(id)}>{label}</button>
            ))}
          </div>
          <div className="row g-2">
            <div className="col-6 col-md-4">
              <label htmlFor="expFrom" className="form-label mb-1">From</label>
              <input id="expFrom" type="date" className="form-control" style={{ minHeight: 44 }} value={from} max={to || undefined} onChange={(e) => { setPreset("custom"); setRange([e.target.value, to]); }} />
            </div>
            <div className="col-6 col-md-4">
              <label htmlFor="expTo" className="form-label mb-1">To</label>
              <input id="expTo" type="date" className="form-control" style={{ minHeight: 44 }} value={to} min={from || undefined} max={manilaDay()} onChange={(e) => { setPreset("custom"); setRange([from, e.target.value]); }} />
            </div>
          </div>
          {badRange && <div className="text-danger mt-2" role="alert">The From date must be on or before the To date.</div>}
          <p className="text-muted small mt-2 mb-0">Products, prices, stock now and customers are always as of today.</p>
        </div>
      </section>

      <details className="mb-3">
        <summary className="py-2" style={{ minHeight: 44 }}>What is in the file</summary>
        <ul className="mb-0 mt-1">{PARTS.map((p) => <li key={p}>{p}</li>)}</ul>
        <p className="text-muted small mt-2 mb-0">It includes costs, profit and customer phone numbers. Share it only with people you trust.</p>
      </details>

      <details className="mb-3" open={format !== "xlsx"}>
        <summary className="py-2" style={{ minHeight: 44 }}>Other file types</summary>
        <div className="d-grid gap-2 mt-1" role="radiogroup" aria-label="File type">
          {FORMATS.map((f) => (
            <label key={f.id} className={`d-flex align-items-center gap-3 border rounded-3 p-3 ${format === f.id ? "border-dark border-2" : ""}`} style={{ cursor: "pointer", minHeight: 56 }}>
              <input type="radio" className="form-check-input m-0 flex-shrink-0" name="expFormat" value={f.id} checked={format === f.id} onChange={() => setFormat(f.id)} />
              <i className={`bi ${f.icon} fs-4 flex-shrink-0`} aria-hidden="true"></i>
              <span><span className="fw-semibold d-block">{f.label}</span><span className="text-muted small">{f.note}</span></span>
            </label>
          ))}
        </div>
      </details>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      <button type="button" className="btn btn-primary btn-lg w-100" style={{ minHeight: 52 }} disabled={busy || badRange || offline} onClick={download} aria-busy={busy}>
        {busy
          ? <><span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{waking ? "Waking the server… this can take a minute" : "Making your file…"}</>
          : <><i className="bi bi-download me-2" aria-hidden="true"></i>Download {FORMATS.find((f) => f.id === format)!.label} file</>}
      </button>
      {offline && <p className="text-muted mt-2 mb-0" role="status">Export needs the internet. Connect, then try again.</p>}
    </div>
  );
}

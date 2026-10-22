"use client";

// Rice Ops — the Report tab: counts posted in a period (one store or all), the totals, why things were
// short or over, every count to open, and every difference as an Excel file. Staff see their own store.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { downloadCsv, pesoText } from "../../lib/count-view";
import CountReport from "./CountReport";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
interface Loc { id: string; name: string; code: string | null }
interface Summary { id: string; docNumber: string; kind: string; location: string; postedAt: string | null; items: number; correct: number; short: number; over: number; kulangValueMinor: number; sobraValueMinor: number; countedBy: string | null }
interface Diff { docNumber: string; postedAt: string | null; location: string; item: string; loose: boolean; countedQty: number | null; expectedQty: number | null; varianceQty: number; varianceValueMinor: number; reasonLabel: string | null; note: string | null; countedBy: string | null }
interface Data {
  from: string; to: string; locationId: string | null;
  totals: { counts: number; items: number; correct: number; short: number; over: number; kulangValueMinor: number; sobraValueMinor: number };
  byReason: { code: string; label: string; items: number; shortValueMinor: number; overValueMinor: number }[];
  counts: Summary[]; differences: Diff[];
}
const KIND: Record<string, string> = { FULL: "Full", PARTIAL: "List", CLOSING: "Closing", QUICK: "Quick" };
const manila = (offsetDays: number) => new Date(Date.now() + 8 * 3_600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);

export default function CountReportList({ locations, locationId, owner }: { locations: Loc[]; locationId: string; owner: boolean }) {
  const [from, setFrom] = useState(manila(29));
  const [to, setTo] = useState(manila(0));
  const [where, setWhere] = useState(locationId); // "" = every store (owner)
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const q = new URLSearchParams({ from, to });
    if (owner && where) q.set("locationId", where);
    const res = await fetch(`${API_URL}/admin/counts/report?${q}`, { headers: adminHeaders() });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Could not load the report"); return; }
    setData(d as unknown as Data);
  }, [from, to, where, owner]);
  useEffect(() => { void load(); }, [load]);

  if (open) return <CountReport countId={open} onBack={() => setOpen(null)} backLabel="← Report" />;

  const range = (days: number) => { setFrom(manila(days - 1)); setTo(manila(0)); };
  const excel = () => data && downloadCsv(`count-differences-${data.from}-to-${data.to}.csv`, [
    ["Count", "Posted", "Store", "Item", "Counted", "System had", "Difference", "Value (₱)", "Why", "Note", "Counted by"],
    ...data.differences.map((d) => [d.docNumber, d.postedAt ? new Date(d.postedAt).toLocaleString("en-PH") : "", d.location, d.item, d.countedQty === null ? "" : d.loose ? d.countedQty / 1000 : d.countedQty, d.expectedQty === null ? "" : d.loose ? d.expectedQty / 1000 : d.expectedQty, d.loose ? d.varianceQty / 1000 : d.varianceQty, d.varianceValueMinor / 100, d.reasonLabel ?? "No reason", d.note ?? "", d.countedBy ?? ""]),
  ]);

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="d-flex flex-wrap align-items-end gap-2 mb-2">
        {owner && (
          <div>
            <label className="form-label small mb-0" htmlFor="rep-store">Store</label>
            <select id="rep-store" className="form-select" value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="">All stores</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} · ` : ""}{l.name}</option>)}
            </select>
          </div>
        )}
        <div><label className="form-label small mb-0" htmlFor="rep-from">From</label><input id="rep-from" type="date" className="form-control" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="form-label small mb-0" htmlFor="rep-to">To</label><input id="rep-to" type="date" className="form-control" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="btn-group">
          <button type="button" className="btn btn-outline-secondary" onClick={() => range(1)}>Today</button>
          <button type="button" className="btn btn-outline-secondary" onClick={() => range(7)}>7 days</button>
          <button type="button" className="btn btn-outline-secondary" onClick={() => range(30)}>30 days</button>
        </div>
        {data && data.differences.length > 0 && <button type="button" className="btn btn-outline-dark ms-auto" onClick={excel}>Excel (differences)</button>}
      </div>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {data && (
        <>
          <div className="row g-2 mb-3 text-center">
            <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Counts</div><div className="fs-4">{data.totals.counts}</div><div className="small text-muted">{data.totals.items} items</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Correct</div><div className="fs-4 text-success">{data.totals.correct}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Short ({data.totals.short})</div><div className="fs-5 text-danger">{pesoText(data.totals.kulangValueMinor)}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded py-2"><div className="small text-muted">Over ({data.totals.over})</div><div className="fs-5">{pesoText(data.totals.sobraValueMinor)}</div></div></div>
          </div>
          {data.byReason.length > 0 && (
            <div className="card mb-3">
              <div className="card-header fw-semibold">Why things were short or over</div>
              <div className="table-responsive">
                <table className="table table-sm mb-0" style={{ fontVariantNumeric: "tabular-nums" }}>
                  <thead><tr><th>Reason</th><th className="text-end">Items</th><th className="text-end">Short</th><th className="text-end">Over</th></tr></thead>
                  <tbody>{data.byReason.map((r) => <tr key={r.code}><td>{r.label}</td><td className="text-end">{r.items}</td><td className="text-end text-danger">{r.shortValueMinor ? pesoText(r.shortValueMinor) : ""}</td><td className="text-end">{r.overValueMinor ? pesoText(r.overValueMinor) : ""}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
          <h2 className="h6">Counts</h2>
          <div className="list-group mb-3">
            {data.counts.map((c) => (
              <button key={c.id} type="button" className="list-group-item list-group-item-action" onClick={() => setOpen(c.id)}>
                <div className="d-flex justify-content-between gap-2">
                  <span><span className="fw-semibold">{c.docNumber}</span> · {KIND[c.kind] ?? c.kind} · {c.location}</span>
                  <span className="small text-muted">{c.postedAt ? new Date(c.postedAt).toLocaleDateString("en-PH", { day: "numeric", month: "short" }) : ""}</span>
                </div>
                <div className="small">
                  {c.items} items · <span className="text-success">{c.correct} correct</span>
                  {c.short > 0 && <> · <span className="text-danger">{c.short} short ({pesoText(c.kulangValueMinor)})</span></>}
                  {c.over > 0 && <> · {c.over} over ({pesoText(c.sobraValueMinor)})</>}
                  {c.countedBy && <span className="text-muted"> · {c.countedBy}</span>}
                </div>
              </button>
            ))}
            {data.counts.length === 0 && <p className="text-muted mb-0">No counts were posted in these dates.</p>}
          </div>
        </>
      )}
    </div>
  );
}

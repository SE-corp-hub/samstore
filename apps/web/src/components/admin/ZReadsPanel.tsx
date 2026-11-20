"use client";

// Reports → Z-reads: every closed day per store, newest first. Tap one to see it, print it again,
// or (owner) reopen the last day of a store with a reason.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { peso } from "../../lib/number-format";
import { printSlip } from "../../lib/slip-print";
import { toast } from "../../lib/toast";
import { dayText, timeText, useDayOn, zLabel, zSlip, type DayFigures } from "../../lib/day";
import { ZView } from "./CloseDay";
import { getJson } from "./DayBar";

interface Row {
  id: string; zNumber: number | null; businessDate: string; locationId: string; locationName: string; closedAt: string | null; closedBy: string;
  netSalesMinor: number; cashDifferenceMinor: number; gcashDifferenceMinor: number; varianceReason: string | null; reopened: boolean;
}
interface List { from: string; to: string; open: { id: string; locationName: string; businessDate: string; openedAt: string }[]; zreads: Row[] }

const diff = (m: number) => (m === 0 ? <span className="day-ok">Correct</span> : m < 0 ? <span className="day-short fw-semibold">Short {peso(-m)}</span> : <span className="day-over fw-semibold">Over {peso(m)}</span>);
const daysAgo = (n: number) => new Date(Date.now() + 8 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);

export default function ZReadsPanel({ role }: { role?: string }) {
  const owner = role === "OWNER" || role === "STORE_OWNER" || role === "MANAGER" || role === "PLATFORM_ADMIN";
  const dayOn = useDayOn();
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAgo(0));
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ row: Row; z: DayFigures } | null>(null);
  const [storeName, setStoreName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await getJson<List>(`/admin/rice/day/zreads?from=${from}&to=${to}`);
    if (!r.ok || !r.data) { setError(r.message); return; }
    setError(null); setData(r.data);
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void getJson<{ name?: string }>("/admin/settings").then((r) => setStoreName(r.data?.name ?? "")); }, []);

  const open = async (row: Row) => {
    const r = await getJson<DayFigures>(`/admin/rice/day/zread?id=${encodeURIComponent(row.id)}`);
    if (!r.ok || !r.data) { setError(r.message); return; }
    setReason(""); setShown({ row, z: r.data });
  };
  const reopen = async () => {
    if (!shown) return;
    setBusy(true);
    const res = await fetch(`${API_URL}/admin/rice/day/reopen`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ id: shown.row.id, reason: reason.trim() }) }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { message?: string; errors?: string[] } | null;
    setBusy(false);
    if (!res?.ok) { setError(d?.errors?.join(", ") || d?.message || "Could not reopen — check the internet"); setShown(null); return; }
    toast(`${shown.row.locationName}: day reopened`);
    setShown(null);
    await load();
  };

  return (
    <div className="container-fluid py-3" style={{ maxWidth: 900 }}>
      <h1 className="h4 mb-2">Z-reads</h1>
      {dayOn === false && <div className="alert alert-info py-2">Open day and Close day are turned off. {owner ? "Turn them on in Settings, Selling at the counter." : "The owner turns them on in Settings."}</div>}
      <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
        <div><label className="form-label small mb-1" htmlFor="zr-from">From</label><input id="zr-from" type="date" className="form-control" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="form-label small mb-1" htmlFor="zr-to">To</label><input id="zr-to" type="date" className="form-control" value={to} min={from} max={daysAgo(0)} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {data && data.open.length > 0 && (
        <div className="alert alert-warning py-2">
          <strong>Open now:</strong> {data.open.map((o) => `${o.locationName} (${dayText(o.businessDate)}, since ${timeText(o.openedAt)})`).join(" · ")}
        </div>
      )}
      {!data ? <p className="text-muted">Loading…</p> : data.zreads.length === 0 ? <p className="text-muted">No closed days in these dates.</p> : (
        <div className="list-group">
          {data.zreads.map((r) => (
            <button key={r.id} type="button" className="list-group-item list-group-item-action py-3" onClick={() => void open(r)}>
              <div className="d-flex flex-wrap justify-content-between gap-2">
                <strong>{zLabel(r.zNumber)} · {r.locationName}</strong>
                <span>{dayText(r.businessDate)}{r.reopened && <span className="badge text-bg-warning ms-2">Reopened</span>}</span>
              </div>
              <div className="d-flex flex-wrap justify-content-between gap-2 mt-1">
                <span>Net sales {peso(r.netSalesMinor)}</span>
                <span>Cash: {diff(r.cashDifferenceMinor)} · GCash: {diff(r.gcashDifferenceMinor)}</span>
              </div>
              {(r.varianceReason || r.closedBy) && <div className="small text-muted mt-1">{r.closedBy ? `Closed ${timeText(r.closedAt)} by ${r.closedBy}` : ""}{r.varianceReason ? ` · ${r.varianceReason}` : ""}</div>}
            </button>
          ))}
        </div>
      )}

      {shown && (
        <>
          <div className="modal d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="zr-title" style={{ zIndex: 1080 }}>
            <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
              <div className="modal-content rice-ui">
                <div className="modal-header">
                  <h2 id="zr-title" className="h5 mb-0">{zLabel(shown.z.zNumber)} · {shown.row.locationName}</h2>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setShown(null)} />
                </div>
                <div className="modal-body">
                  <ZView z={shown.z} kind="Z" />
                  {owner && !shown.row.reopened && (
                    <div className="mt-3 pt-3 border-top">
                      <label className="form-label fw-semibold" htmlFor="zr-why">Reopen this day (only the last day of a store)</label>
                      <input id="zr-why" className="form-control form-control-lg mb-2" placeholder="Why? e.g. a sale was not rung up" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
                      <button type="button" className="btn btn-outline-dark" disabled={busy || !reason.trim()} onClick={() => void reopen()}>{busy ? "Please wait…" : "Reopen day"}</button>
                    </div>
                  )}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-primary btn-lg" onClick={() => printSlip(zSlip(shown.z, storeName, "Z"))}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print</button>
                  <button type="button" className="btn btn-dark btn-lg" onClick={() => setShown(null)}>Close</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop show" style={{ zIndex: 1070 }}></div>
        </>
      )}
    </div>
  );
}

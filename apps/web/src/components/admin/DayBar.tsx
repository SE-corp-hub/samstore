"use client";

// Open day + Close day (Z-read) on POS (Settings → Selling at the counter → "Open and close the day on POS").
//   switch off            nothing shows; POS works as before
//   day not open          a card in place of the price list: count the change fund, Open day
//   an old day still open a red card: close that day first
//   closed for today      a card: see / print the Z-read; the owner can reopen
//   open                  one slim row: "Day open since 7:02 AM", X-read, Close day
// An Open day with no signal waits on the tablet and the day counts as open, so selling never stops.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminRole } from "../../lib/admin";
import { sendStep } from "../../lib/offlineQueue";
import { useOffline } from "../../lib/offlineCache";
import { peso } from "../../lib/number-format";
import { printSlip } from "../../lib/slip-print";
import { toast } from "../../lib/toast";
import { dayText, loadDay, markPendingOpen, timeText, zLabel, zSlip, type DayFigures, type DayStatus } from "../../lib/day";
import NumPad from "./NumPad";
import CloseDay, { ZView } from "./CloseDay";

export type DayState = "off" | "open" | "blocked";
const OWNERS = ["OWNER", "MANAGER", "STORE_OWNER", "PLATFORM_ADMIN"];
const toMinor = (s: string) => Math.round(Number(s.replace(/,/g, "") || "0") * 100);
const errText = (d: { message?: string; errors?: string[] } | null, fallback: string) => d?.errors?.join(", ") || d?.message || fallback;

export async function getJson<T>(path: string): Promise<{ ok: boolean; data: T | null; message: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, { headers: adminHeaders() });
    const data = (await res.json().catch(() => null)) as (T & { message?: string; errors?: string[] }) | null;
    return { ok: res.ok, data: res.ok ? data : null, message: res.ok ? "" : errText(data, "Could not load — check the internet") };
  } catch {
    return { ok: false, data: null, message: "Needs internet" };
  }
}

/**
 * The day of the store POS is selling at. `onState` tells POS whether it may show the price list.
 * `heldCount`: sales put on hold on this tablet (shown before closing).
 */
export default function DayBar({ locationId, storeName, heldCount, onState, compact }: {
  locationId: string; storeName: string; heldCount: number; onState: (s: DayState) => void; compact?: boolean;
}) {
  const [day, setDay] = useState<DayStatus | null>(null);
  const [closing, setClosing] = useState(false);
  const [xread, setXread] = useState<DayFigures | null>(null);
  const [zShown, setZShown] = useState<DayFigures | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [float, setFloat] = useState("");
  const [reopenAsk, setReopenAsk] = useState(false);
  const [reason, setReason] = useState("");
  const offline = useOffline();
  const owner = OWNERS.includes(getAdminRole());

  const refresh = useCallback(async () => {
    if (!locationId) { setDay(null); return; }
    const saved = await loadDay(locationId, { savedOnly: true });
    if (saved) setDay(saved);
    const fresh = await loadDay(locationId);
    if (fresh) setDay(fresh);
  }, [locationId]);
  useEffect(() => { setDay(null); setFloat(""); setError(null); void refresh(); }, [refresh]);
  useEffect(() => {
    // A day left open past midnight turns "old" without a reload.
    const t = setInterval(() => void refresh(), 5 * 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const on = !!day?.on && day.location?.id === locationId;
  const openToday = on && !!day?.open && !day.open.stale;
  const state: DayState = !on ? "off" : openToday ? "open" : "blocked";
  useEffect(() => { onState(day === null && locationId ? "off" : state); }, [state, day, locationId, onState]);
  useEffect(() => { if (day?.suggestFloatMinor && float === "") setFloat(String(day.suggestFloatMinor / 100)); }, [day?.suggestFloatMinor]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!locationId || !day || !on) return null;
  const place = day.location?.name ?? "This store";

  const openDay = async () => {
    setBusy(true); setError(null);
    const floatMinor = toMinor(float);
    const sent = await sendStep("/admin/rice/day/open", { locationId, openingFloatMinor: floatMinor }, `Open day ${place}`);
    setBusy(false);
    if (sent.status === "queued") { markPendingOpen(locationId, floatMinor); toast("Day open (saved on this tablet, sends when online)"); await refresh(); return; }
    if (!sent.ok) { setError(errText(sent.data, "Could not open the day")); return; }
    toast(`${place}: day open`);
    await refresh();
  };
  const showX = async () => {
    setBusy(true); setError(null);
    const r = await getJson<DayFigures>(`/admin/rice/day/xread?locationId=${encodeURIComponent(locationId)}`);
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.message); return; }
    setXread(r.data);
  };
  const showZ = async (id: string) => {
    setBusy(true); setError(null);
    const r = await getJson<DayFigures>(`/admin/rice/day/zread?id=${encodeURIComponent(id)}`);
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.message); return; }
    setZShown(r.data);
  };
  const reopen = async () => {
    if (!day.closedToday) return;
    setBusy(true); setError(null);
    const res = await fetch(`${API_URL}/admin/rice/day/reopen`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ id: day.closedToday.id, reason: reason.trim() }) }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { message?: string; errors?: string[] } | null;
    setBusy(false);
    if (!res?.ok) { setError(errText(d, "Could not reopen — check the internet")); return; }
    setReopenAsk(false); setReason("");
    toast(`${place}: day reopened`);
    await refresh();
  };

  const modals = (
    <>
      {closing && day.open && (
        <CloseDay locationId={locationId} storeName={storeName} placeName={place} heldCount={heldCount} businessDate={day.open.businessDate}
          onCancel={() => setClosing(false)} onClosed={async () => { setClosing(false); await refresh(); }} />
      )}
      {(xread || zShown) && (
        <div className="modal d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="zx-title" style={{ zIndex: 1080 }}>
          <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
            <div className="modal-content rice-ui">
              <div className="modal-header">
                <h2 id="zx-title" className="h5 mb-0">{xread ? "X-read: the day so far" : zLabel(zShown?.zNumber)}</h2>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => { setXread(null); setZShown(null); }} />
              </div>
              <div className="modal-body"><ZView z={(xread ?? zShown)!} kind={xread ? "X" : "Z"} /></div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-primary btn-lg" onClick={() => printSlip(zSlip((xread ?? zShown)!, storeName, xread ? "X" : "Z"))}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print</button>
                <button type="button" className="btn btn-dark btn-lg" onClick={() => { setXread(null); setZShown(null); }}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {(xread || zShown) && <div className="modal-backdrop show" style={{ zIndex: 1070 }}></div>}
    </>
  );
  const err = error && <div className="alert alert-danger py-2 mb-2" role="alert">{error}</div>;

  // ── Open: one slim row ──
  if (openToday && day.open) {
    return (
      <div className={`day-bar d-flex align-items-center flex-wrap gap-2 mb-2${compact ? " day-bar-compact" : ""}`}>
        <span className="day-chip day-chip-open"><i className="bi bi-unlock me-1" aria-hidden="true"></i>{compact ? "Open" : "Day open"}<span className="day-chip-detail">&nbsp;· since {timeText(day.open.openedAt)}{day.open.id === "pending" ? " (not sent yet)" : ""}</span></span>
        <span className="ms-auto d-flex gap-2">
          <button type="button" className="btn btn-outline-primary" disabled={busy || offline || day.open.id === "pending"} onClick={() => void showX()} title={offline ? "Needs internet" : undefined}>X-read</button>
          <button type="button" className="btn btn-outline-dark" disabled={busy || day.open.id === "pending"} onClick={() => setClosing(true)}><i className="bi bi-lock me-1" aria-hidden="true"></i>Close day</button>
        </span>
        {err && <div className="w-100">{err}</div>}
        {modals}
      </div>
    );
  }

  // ── An old day still open ──
  if (day.open?.stale) {
    return (
      <div className="card border-danger day-card mb-2">
        <div className="card-body">
          <h2 className="h5 text-danger"><i className="bi bi-exclamation-octagon me-2" aria-hidden="true"></i>{place}: the day of {dayText(day.open.businessDate)} is still open</h2>
          <p className="mb-3">Close that day first (count the cash and GCash of that day). Then open today.</p>
          {err}
          <button type="button" className="btn btn-success btn-lg w-100" disabled={busy} onClick={() => setClosing(true)}>Close the day of {dayText(day.open.businessDate)}</button>
        </div>
        {modals}
      </div>
    );
  }

  // ── Closed for today ──
  if (day.closedToday) {
    return (
      <div className="card day-card mb-2">
        <div className="card-body">
          <h2 className="h5"><i className="bi bi-lock-fill me-2" aria-hidden="true"></i>{place} is closed for today</h2>
          <p className="mb-3">Closed at {timeText(day.closedToday.closedAt)} · {zLabel(day.closedToday.zNumber)}. Selling starts again with Open day tomorrow.</p>
          {err}
          <div className="d-flex flex-wrap gap-2">
            <button type="button" className="btn btn-outline-primary btn-lg" disabled={busy || offline} onClick={() => void showZ(day.closedToday!.id)}><i className="bi bi-receipt me-1" aria-hidden="true"></i>See / print {zLabel(day.closedToday.zNumber)}</button>
            {owner && !reopenAsk && <button type="button" className="btn btn-outline-dark btn-lg" disabled={offline} onClick={() => setReopenAsk(true)}>Reopen day</button>}
          </div>
          {owner && reopenAsk && (
            <div className="mt-3">
              <label className="form-label fw-semibold" htmlFor="reopen-why">Why reopen? (saved with the Z-read)</label>
              <input id="reopen-why" className="form-control form-control-lg mb-2" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. a sale was not rung up" />
              <p className="small text-muted mb-2">{zLabel(day.closedToday.zNumber)} stays on record, marked reopened. The next close prints a new Z number.</p>
              <div className="d-flex gap-2">
                <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => { setReopenAsk(false); setReason(""); }}>Back</button>
                <button type="button" className="btn btn-success btn-lg flex-grow-1" disabled={busy || !reason.trim()} onClick={() => void reopen()}>{busy ? "Please wait…" : "Reopen the day"}</button>
              </div>
            </div>
          )}
        </div>
        {modals}
      </div>
    );
  }

  // ── Not open yet ──
  return (
    <div className="card border-warning day-card mb-2">
      <div className="card-body">
        <h2 className="h5"><i className="bi bi-sunrise me-2" aria-hidden="true"></i>Open the day · {place}</h2>
        <p className="mb-2">Count the change fund in the drawer, then tap Open day. Selling starts after that.</p>
        {err}
        <div className="mx-auto" style={{ maxWidth: 360 }}>
          <NumPad value={float} onChange={setFloat} decimals={2} label="Change fund in the drawer" unit="₱" startFresh={!!day.suggestFloatMinor} />
          {day.suggestFloatMinor ? <p className="small text-muted mt-1 mb-0">Kept at the last close: {peso(day.suggestFloatMinor)}</p> : null}
          <button type="button" className="btn btn-success btn-lg w-100 mt-2" disabled={busy} onClick={() => void openDay()}>{busy ? "Please wait…" : `Open day with ${peso(toMinor(float))}`}</button>
        </div>
      </div>
    </div>
  );
}

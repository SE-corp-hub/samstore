"use client";

// Cash drawer — what should be in a store's drawer today, and the cash handed over to the owner.
// Per-store build, step 4. The numbers come from the cash book on the server, the same reading the
// daily report and Close the store use.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { askConfirm, askText } from "../../lib/ask";
import { cleanTyping, peso, pesosToMinor } from "../../lib/number-format";
import StoreBar, { type StoreOption } from "./StoreBar";

interface Handover { id: string; amountMinor: number; note: string | null; at: string; handedBy: string | null; received: boolean; receivedBy: string | null; cancelled: boolean; cancelReason: string | null }
interface CashDay {
  date: string; location: { id: string; name: string }; canCancel: boolean;
  cash: { inMinor: number; creditPaidMinor: number; givenBackMinor: number; paidOutMinor: number; handedOverMinor: number; expectedMinor: number };
  handovers: Handover[];
}
const errOf = (d: unknown, fallback: string) => { const e = d as { errors?: string[]; message?: string } | null; return e?.errors?.[0] ?? e?.message ?? fallback; };

export default function CashPanel() {
  const [places, setPlaces] = useState<StoreOption[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [data, setData] = useState<CashDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [me, locs] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      const active = ((locs?.warehouses ?? []) as (StoreOption & { isActive?: boolean })[]).filter((l) => l.isActive !== false && l.type === "STORE");
      setPlaces(active);
      setHome(me?.homeLocationId ?? null);
      setLocationId(me?.homeLocationId ?? active[0]?.id ?? "");
    })().catch(() => { setError("Could not load the stores. Check the connection and open this screen again."); setLoading(false); });
  }, []);

  const load = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/rice/cash?locationId=${encodeURIComponent(locationId)}`, { headers: adminHeaders() });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(errOf(d, "Could not load the cash. Try again.")); return; }
      setData(d as CashDay);
      setError(null);
    } catch {
      setError("No connection. Could not load the cash.");
    } finally {
      setLoading(false);
    }
  }, [locationId]);
  useEffect(() => { void load(); }, [load]);

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${API_URL}/admin/rice/cash/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
    return { ok: res.ok, data: await res.json().catch(() => null) };
  };

  const handOver = async () => {
    setFormError(null);
    const amountMinor = pesosToMinor(amount);
    if (!amountMinor || amountMinor <= 0) { setFormError("Type the cash that was handed over."); return; }
    const store = data?.location.name ?? "this store";
    if (data && amountMinor > data.cash.expectedMinor && !(await askConfirm(`${peso(amountMinor)} is more than the ${peso(Math.max(0, data.cash.expectedMinor))} that should be in the drawer of ${store} today. Save it anyway?`, { ok: "Yes, save it", cancel: "No, go back" }))) return;
    setSaving(true);
    try {
      const r = await post("handover", { locationId, amountMinor, note: note.trim() || undefined });
      if (!r.ok) { setFormError(errOf(r.data, "The hand-over was not saved. Try again.")); return; }
      setAmount(""); setNote("");
      toast(`${peso(amountMinor)} handed over from ${store}`);
      await load();
    } catch {
      setFormError("No connection. The hand-over was not saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const received = async (h: Handover) => {
    const r = await post("handover/received", { id: h.id });
    if (r.ok) { toast("Marked as received"); await load(); } else toast(errOf(r.data, "Not saved. Try again."));
  };
  const cancel = async (h: Handover) => {
    const reason = await askText(`Cancel this hand-over of ${peso(h.amountMinor)}? Write why.`, { ok: "Cancel the hand-over", cancel: "Keep it", danger: true, placeholder: "Example: wrong amount" });
    if (!reason) return;
    const r = await post("handover/cancel", { id: h.id, reason });
    if (r.ok) { toast("Hand-over cancelled"); await load(); } else toast(errOf(r.data, "Not cancelled. Try again."));
  };

  const c = data?.cash;
  const minus = (label: string, v: number) => (
    <div className="d-flex justify-content-between gap-3 py-1"><span>Less: {label}</span><span className="text-nowrap">−{peso(v)}</span></div>
  );
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });

  return (
    <div className="cash-screen">
      <h1 className="h4 mb-1"><i className="bi bi-safe me-2" aria-hidden="true"></i>Cash drawer</h1>
      <p className="text-muted mb-3">The cash that should be in the store&apos;s drawer today, and the cash handed over to the owner.</p>
      {places.length > 0 && <StoreBar label="Store" locations={places} value={locationId} homeLocationId={home} onPick={setLocationId} size="md" />}
      {error && <div className="alert alert-danger py-2" role="alert">{error} <button type="button" className="btn btn-outline-dark ms-2" onClick={load}>Try again</button></div>}
      {loading && !data && <p className="text-muted">Loading…</p>}

      {c && data && (
        <>
          <section className="card mb-3" aria-labelledby="cash-today">
            <div className="card-body" style={{ fontVariantNumeric: "tabular-nums" }}>
              <h2 className="h5 mb-2" id="cash-today">Today at {data.location.name}</h2>
              <div className="d-flex justify-content-between gap-3 py-1"><span>Cash taken in{c.creditPaidMinor ? ` (${peso(c.creditPaidMinor)} of it is credit paid)` : ""}</span><span className="text-nowrap">{peso(c.inMinor)}</span></div>
              {c.givenBackMinor > 0 && minus("cash given back to customers", c.givenBackMinor)}
              {c.paidOutMinor > 0 && minus("expenses paid from the drawer", c.paidOutMinor)}
              {c.handedOverMinor > 0 && minus("cash handed over to the owner", c.handedOverMinor)}
              <div className="d-flex justify-content-between align-items-baseline gap-3 border-top mt-2 pt-2" aria-live="polite">
                <span className="fw-semibold">Cash that should be in the drawer</span>
                <span className={`fs-3 fw-bold text-nowrap ${c.expectedMinor < 0 ? "text-danger" : ""}`}>{c.expectedMinor < 0 ? "−" : ""}{peso(Math.abs(c.expectedMinor))}</span>
              </div>
              {c.expectedMinor < 0 && <p className="text-danger mb-0 mt-1">More cash went out than came in today. Check the hand-overs and the expenses.</p>}
              <p className="small text-muted mb-0 mt-2">The change money the day started with is not counted here.</p>
            </div>
          </section>

          <form className="card mb-3" onSubmit={(e) => { e.preventDefault(); if (!saving) void handOver(); }} aria-labelledby="cash-give">
            <div className="card-body">
              <h2 className="h5 mb-3" id="cash-give">Hand over cash to the owner</h2>
              <div className="row g-3 mb-3">
                <div className="col-12 col-sm-5 col-lg-4">
                  <label className="form-label fw-semibold" htmlFor="cash-amount">Cash handed over</label>
                  <div className="input-group input-group-lg">
                    <span className="input-group-text">₱</span>
                    <input id="cash-amount" className="form-control" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount}
                      onChange={(e) => setAmount(cleanTyping(e.target.value, "peso"))} aria-invalid={!!formError} aria-describedby={formError ? "cash-error" : undefined} />
                  </div>
                </div>
                <div className="col-12 col-sm-7 col-lg-8">
                  <label className="form-label fw-semibold" htmlFor="cash-note">Note <span className="fw-normal text-muted">(not needed)</span></label>
                  <input id="cash-note" className="form-control form-control-lg" maxLength={200} autoComplete="off" placeholder="Example: given to Lucy at noon" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </div>
              {formError && <div className="alert alert-danger py-2" id="cash-error" role="alert">{formError}</div>}
              <button type="submit" className="btn btn-success btn-lg" disabled={saving}>
                <i className="bi bi-check-lg me-1" aria-hidden="true"></i>{saving ? "Saving…" : "Save hand-over"}
              </button>
            </div>
          </form>

          <h2 className="h5 mb-2">Handed over today</h2>
          {data.handovers.length === 0 ? (
            <p className="text-muted">No cash handed over yet today.</p>
          ) : (
            <ul className="list-group">
              {data.handovers.map((h) => (
                <li key={h.id} className="list-group-item">
                  <div className="d-flex flex-wrap align-items-center gap-2">
                    <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                      <div className={h.cancelled ? "text-decoration-line-through text-muted" : ""}>
                        <span className="fw-semibold">{time(h.at)}</span>{h.handedBy && <> · by {h.handedBy}</>}{h.note && <> · {h.note}</>}
                      </div>
                      {h.cancelled
                        ? <div className="small"><span className="badge text-bg-danger me-1">Cancelled</span>{h.cancelReason}</div>
                        : h.received
                          ? <div className="small"><i className="bi bi-check-circle-fill text-success me-1" aria-hidden="true"></i>Received{h.receivedBy ? ` by ${h.receivedBy}` : ""}</div>
                          : <div className="small"><i className="bi bi-hourglass-split me-1" aria-hidden="true"></i>Waiting for the owner to say it was received</div>}
                    </div>
                    <div className={`fs-5 fw-bold text-end ${h.cancelled ? "text-decoration-line-through text-muted" : ""}`}>{peso(h.amountMinor)}</div>
                    {data.canCancel && !h.cancelled && (
                      <span className="d-flex gap-2">
                        {!h.received && <button type="button" className="btn btn-outline-primary" onClick={() => received(h)} aria-label={`I received the ${peso(h.amountMinor)}`}><i className="bi bi-check-lg me-1" aria-hidden="true"></i>Received</button>}
                        <button type="button" className="btn btn-outline-danger" onClick={() => cancel(h)} aria-label={`Cancel the hand-over of ${peso(h.amountMinor)}`}><i className="bi bi-x-lg me-1" aria-hidden="true"></i>Cancel</button>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

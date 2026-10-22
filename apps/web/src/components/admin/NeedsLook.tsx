"use client";

// Rice Ops — the owner's side of counting, after the fact and never blocking:
//   * Needs a look: counts with a big difference, an over count, the same item short again and again, many "Don't know".
//     The owner opens the count, or taps OK (with a note). If a consignment store was charged, a button opens Store payable (Undo is there).
//   * Count accuracy: how often an item is right on the first count, per store and per person, week by week.
//   * The two limits: when to ask for a recount, and when to put a count on this list.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { pesoText } from "../../lib/count-view";
import { toast } from "../../lib/toast";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...adminHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

interface Flag { kind: string; text: string; valueMinor: number | null; times: number | null }
interface LookItem { count: { id: string; docNumber: string; kind: string; location: string; decidedAt: string | null; countedBy: string | null }; flags: Flag[]; chargeMinor: number }
interface Limits { recountMinor: number; lookMinor: number }
interface Week { counted: number; right: number; pct: number | null; endsAt: string }
interface Stat { counted: number; right: number; pct: number | null }
interface Accuracy { days: number; total: Stat & { weeks: Week[] }; locations: (Stat & { locationId: string; name: string; weeks: Week[] })[]; people: (Stat & { userId: string; name: string })[] }

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-PH", { day: "numeric", month: "short" }) : "");
const pesosText = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));
const toMinor = (pesos: string) => Math.round(Number(pesos || "0") * 100);

function Trend({ weeks }: { weeks: Week[] }) {
  return (
    <div className="d-flex align-items-end gap-2" style={{ height: 64 }} aria-label="Right first time, week by week">
      {weeks.map((w, i) => (
        <div key={w.endsAt} className="text-center" style={{ width: 54 }} title={`Week ending ${day(w.endsAt)}: ${w.right} of ${w.counted}`}>
          <div className="bg-success-subtle border border-success-subtle rounded-top" style={{ height: `${w.pct === null ? 2 : Math.max(2, Math.round((w.pct * 40) / 100))}px`, marginTop: "auto" }} />
          <div className="small">{w.pct === null ? "–" : `${w.pct}%`}</div>
          <div className="text-muted" style={{ fontSize: 11 }}>{i === weeks.length - 1 ? "this week" : `${weeks.length - 1 - i}w ago`}</div>
        </div>
      ))}
    </div>
  );
}

export default function NeedsLook({ onOpenCount, onNavigate, onChanged }: { onOpenCount: (id: string) => void; onNavigate?: (tab: string) => void; onChanged?: () => void }) {
  const [items, setItems] = useState<LookItem[] | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [acc, setAcc] = useState<Accuracy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [recount, setRecount] = useState("");
  const [look, setLook] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [l, a] = await Promise.all([call("GET", "/admin/counts/looks"), call("GET", "/admin/counts/accuracy")]);
    if (!l.ok) { setError(errText(l.data, "Could not load")); return; }
    setItems((l.data?.items as LookItem[] | undefined) ?? []);
    const lim = l.data?.limits as Limits | undefined;
    if (lim) { setLimits(lim); setRecount(pesosText(lim.recountMinor)); setLook(pesosText(lim.lookMinor)); }
    if (a.ok) setAcc(a.data as unknown as Accuracy);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const markOk = async (id: string) => {
    setBusy(true); setError(null);
    const r = await call("POST", `/admin/counts/${id}/look`, { note: note.trim() || undefined });
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Could not save")); return; }
    setNoting(null); setNote("");
    toast("Marked as looked at");
    await load();
    onChanged?.();
  };
  const saveLimits = async () => {
    setBusy(true); setError(null);
    const r = await call("POST", "/admin/counts/limits", { recountMinor: toMinor(recount), lookMinor: toMinor(look) });
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Could not save the limits")); return; }
    toast("Limits saved");
    await load();
    onChanged?.();
  };

  const limitsChanged = !!limits && (toMinor(recount) !== limits.recountMinor || toMinor(look) !== limits.lookMinor);
  return (
    <div style={{ maxWidth: 820 }}>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <h2 className="h5">Needs a look</h2>
      <p className="small text-muted">Counts from the last 30 days. Nothing here blocks anyone: the stock was already fixed when the count was submitted.</p>
      {items === null && !error && <p className="text-muted">Loading…</p>}
      {items && items.length === 0 && <div className="alert alert-success">Nothing needs a look.</div>}
      {items?.map((it) => (
        <div key={it.count.id} className="card mb-3">
          <div className="card-body py-2">
            <div className="d-flex flex-wrap justify-content-between gap-2">
              <div><span className="fw-semibold">{it.count.docNumber}</span> · {it.count.location}</div>
              <div className="small text-muted">{day(it.count.decidedAt)}{it.count.countedBy ? ` · ${it.count.countedBy}` : ""}</div>
            </div>
            <ul className="mb-2 mt-1">
              {it.flags.map((f, i) => <li key={i} className={f.kind === "BIG" ? "text-danger" : ""}>{f.text}</li>)}
            </ul>
            {it.chargeMinor > 0 && (
              <div className="small mb-2">
                The store was charged <strong>{pesoText(it.chargeMinor)}</strong> for this count.
                {onNavigate && <button type="button" className="btn btn-link btn-sm py-0" onClick={() => onNavigate("payable")}>Open Store payable (Undo is there)</button>}
              </div>
            )}
            {noting === it.count.id ? (
              <div className="d-flex flex-wrap gap-2">
                <input className="form-control" style={{ maxWidth: 320 }} placeholder="Add a note (optional)" aria-label="Note" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
                <button type="button" className="btn btn-success" disabled={busy} onClick={() => void markOk(it.count.id)}>Save: looked at it</button>
                <button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={() => { setNoting(null); setNote(""); }}>Cancel</button>
              </div>
            ) : (
              <div className="d-flex flex-wrap gap-2">
                <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => onOpenCount(it.count.id)}>Open the count</button>
                <button type="button" className="btn btn-success btn-sm" onClick={() => { setNoting(it.count.id); setNote(""); }}>OK, looked at it</button>
              </div>
            )}
          </div>
        </div>
      ))}

      <h2 className="h5 mt-4">Count accuracy</h2>
      <p className="small text-muted">How often an item was right on the first count, over the last 4 weeks. A low number means the stock records need more care, not that one person is at fault.</p>
      {acc && acc.total.counted === 0 && <p className="text-muted">No counts in the last 4 weeks.</p>}
      {acc && acc.total.counted > 0 && (
        <>
          <div className="d-flex flex-wrap align-items-center gap-4 mb-3">
            <div><div className="display-6">{acc.total.pct}%</div><div className="small text-muted">{acc.total.right} of {acc.total.counted} right the first time</div></div>
            <Trend weeks={acc.total.weeks} />
          </div>
          <div className="row g-3">
            <div className="col-md-6">
              <table className="table table-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
                <thead><tr><th>Store</th><th className="text-end">Counted</th><th className="text-end">Right</th></tr></thead>
                <tbody>{acc.locations.map((l) => <tr key={l.locationId}><td>{l.name}</td><td className="text-end">{l.counted}</td><td className="text-end">{l.pct}%</td></tr>)}</tbody>
              </table>
            </div>
            <div className="col-md-6">
              <table className="table table-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
                <thead><tr><th>Counted by</th><th className="text-end">Counted</th><th className="text-end">Right</th></tr></thead>
                <tbody>{acc.people.map((p) => <tr key={p.userId}><td>{p.name}</td><td className="text-end">{p.counted}</td><td className="text-end">{p.pct}%</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <h2 className="h5 mt-4">Limits</h2>
      <p className="small text-muted">In pesos, at cost. Put 0 to switch one off.</p>
      <div className="row g-2 align-items-end" style={{ maxWidth: 620 }}>
        <div className="col-sm-6">
          <label className="form-label" htmlFor="lim-recount">Ask to count again from</label>
          <div className="input-group"><span className="input-group-text">₱</span><input id="lim-recount" className="form-control" inputMode="decimal" value={recount} onChange={(e) => setRecount(e.target.value.replace(/[^\d.]/g, "").slice(0, 9))} /></div>
        </div>
        <div className="col-sm-6">
          <label className="form-label" htmlFor="lim-look">Put on this list from</label>
          <div className="input-group"><span className="input-group-text">₱</span><input id="lim-look" className="form-control" inputMode="decimal" value={look} onChange={(e) => setLook(e.target.value.replace(/[^\d.]/g, "").slice(0, 9))} /></div>
        </div>
      </div>
      <button type="button" className="btn btn-outline-dark mt-2" disabled={busy || !limitsChanged} onClick={() => void saveLimits()}>Save the limits</button>
    </div>
  );
}

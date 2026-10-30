"use client";

// Move stock: one step — pick from, to, product and how many. Both counts change at once and a record is kept.
// Staff can move rice out of, or into, their own store.
// A receipt prints right after every move (also when it waits on the tablet for the server), and every
// move in the list has its own Receipt button. The list shows one day or a date range.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { QUEUE_EVENT, queuedSteps, sendStep } from "../../lib/offlineQueue";
import { offlineRef } from "../../lib/offlineCache";
import { printSlip, type Slip } from "../../lib/slip-print";
import StoreBar from "./StoreBar";

interface Place { id: string; name: string; code: string | null; isActive: boolean }
interface ProductOption { id: string; name: string }
interface MoveRow { id: string; docNumber: string | null; productName: string; quantity: number; from: string; to: string; note: string | null; at: string }
type Body = { message?: string; errors?: string[]; docNumber?: string };
type Range = "today" | "yesterday" | "week" | "custom";

// Moves made while the server could not be reached wait on this tablet; each keeps its receipt (the queue "view") to reprint.
const waitingMoves = (): Slip[] => queuedSteps().filter((s) => s.path === "/admin/moves" && s.view).map((s) => s.view as Slip);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DAY = 86_400_000;
/** The from/to times (ISO) for the chosen day or dates; empty when a picked date is missing. */
function rangeOf(range: Range, customFrom: string, customTo: string): { from?: string; to?: string } {
  const today = startOfDay(new Date());
  if (range === "today") return { from: today.toISOString() };
  if (range === "yesterday") return { from: new Date(today.getTime() - DAY).toISOString(), to: new Date(today.getTime() - 1).toISOString() };
  if (range === "week") return { from: new Date(today.getTime() - 6 * DAY).toISOString() };
  const at = (v: string) => { const [y = 0, m = 1, d = 1] = v.split("-").map(Number); return new Date(y, m - 1, d); };
  return {
    ...(customFrom ? { from: at(customFrom).toISOString() } : {}),
    ...(customTo ? { to: new Date(at(customTo).getTime() + DAY - 1).toISOString() } : {}),
  };
}
const RANGES: [Range, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "Last 7 days"], ["custom", "Pick dates"]];

export default function MovePanel() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<MoveRow[]>([]);
  const [storeName, setStoreName] = useState("");
  const [receipt, setReceipt] = useState<Slip | null>(null);
  useEffect(() => { void fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setStoreName(d?.name ?? "")).catch(() => {}); }, []);
  // Every move prints its receipt right away. If the printer is not connected, the
  // "Printer not connected" box keeps it and offers Connect printer — no error.
  useEffect(() => { if (receipt) printSlip(receipt); }, [receipt]);
  const [waiting, setWaiting] = useState<Slip[]>([]);
  const [range, setRange] = useState<Range>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [loading, setLoading] = useState(false);
  const slip = (m: { docNumber: string | null; at: Date | string; from: string; to: string; productName: string; quantity: number; note?: string | null }): Slip => ({
    storeName: storeName || "SAM STORE", title: "MOVE STOCK RECEIPT", reference: m.docNumber, when: new Date(m.at).toLocaleString("en-PH"),
    lines: [{ label: "From", value: m.from }, { label: "To", value: m.to }, ...(m.note && m.note !== "Moved" ? [{ label: "Note", value: m.note }] : [])],
    rows: [{ name: m.productName, qty: String(m.quantity) }],
    signatures: [{ role: "Moved by", name: "" }, { role: "Received by", name: "" }], widthMm: 58,
  });

  const loadRows = useCallback(async () => {
    const q = new URLSearchParams(rangeOf(range, customFrom, customTo));
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/admin/moves${q.toString() ? `?${q}` : ""}`, { headers: adminHeaders() });
      if (r.ok) setRows(((await r.json()).moves ?? []) as MoveRow[]);
    } finally {
      setLoading(false);
    }
  }, [range, customFrom, customTo]);
  useEffect(() => { void loadRows().catch(() => {}); }, [loadRows]);
  useEffect(() => {
    let count = waitingMoves().length;
    const refresh = () => {
      const now = waitingMoves();
      setWaiting(now);
      if (now.length < count) void loadRows().catch(() => {}); // one was uploaded: it now shows in the list
      count = now.length;
    };
    refresh();
    window.addEventListener(QUEUE_EVENT, refresh);
    return () => window.removeEventListener(QUEUE_EVENT, refresh);
  }, [loadRows]);

  useEffect(() => {
    (async () => {
      const [me, locs, ps] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      const active = ((locs?.warehouses ?? []) as Place[]).filter((l) => l.isActive);
      setPlaces(active);
      setHome(me?.homeLocationId ?? null);
      setTo(me?.homeLocationId ?? active[0]?.id ?? "");
      setFrom(active.find((l) => l.id !== (me?.homeLocationId ?? active[0]?.id))?.id ?? "");
      setProducts(((ps?.products ?? ps?.items ?? []) as ProductOption[]).map((p) => ({ id: p.id, name: p.name })));
    })().catch(() => setError("Could not load the stores"));
  }, []);

  const n = Number(qty || "0");
  const fromName = places.find((p) => p.id === from)?.name;
  const toName = places.find((p) => p.id === to)?.name;
  const ready = !!from && !!to && from !== to && !!productId && n >= 1;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const productName = products.find((p) => p.id === productId)?.name ?? "";
    const made = slip({ docNumber: null, at: new Date(), from: fromName ?? "", to: toName ?? "", productName, quantity: n, note: note.trim() });
    const offline: Slip = { ...made, reference: offlineRef(String(Date.now())), footer: "Saved on this tablet · uploads when online." };
    const r = await sendStep("/admin/moves", { fromLocationId: from, toLocationId: to, productId, quantity: n, note }, `Move ${productName}`.trim(), offline);
    setBusy(false);
    // The server could not be reached: the move waits on the tablet, and its receipt still prints now.
    if (r.status === "queued") { setQty("1"); setNote(""); setProductId(""); setReceipt(offline); return; }
    const d = r.data as Body | null;
    if (!r.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "The move did not go through"); return; }
    toast(`Moved ${n} — ${d?.docNumber ?? "done"}`);
    setReceipt({ ...made, reference: d?.docNumber ?? null });
    setQty("1"); setNote(""); setProductId("");
    void loadRows().catch(() => {});
  };

  return (
    <div className="container py-3" style={{ maxWidth: 640 }}>
      <h5 className="mb-3">Move stock</h5>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <StoreBar label="Moving to" locations={places} value={to} homeLocationId={home} includeBuffer onPick={(id) => { setTo(id); if (id === from) setFrom(""); }} />
      <div className="mb-3">
        <div className="small text-muted mb-1">Taking from</div>
        <div className="d-flex flex-wrap gap-2">
          {places.filter((p) => p.id !== to).map((p) => (
            <button key={p.id} type="button" className={`btn btn-lg ${p.id === from ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setFrom(p.id)}>{p.name}</button>
          ))}
        </div>
      </div>
      <label className="form-label small text-muted" htmlFor="mv-product">Product</label>
      <select id="mv-product" className="form-select form-select-lg mb-3" value={productId} onChange={(e) => setProductId(e.target.value)}>
        <option value="">Choose the product…</option>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label className="form-label small text-muted" htmlFor="mv-qty">How many</label>
      <div className="input-group input-group-lg mb-3" style={{ maxWidth: 280 }}>
        <button type="button" className="btn btn-outline-dark" style={{ minWidth: 64, fontSize: 28 }} aria-label="One less" disabled={n <= 1} onClick={() => setQty(String(Math.max(1, n - 1)))}>−</button>
        <input id="mv-qty" className="form-control text-center" style={{ fontSize: 28 }} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 5))} />
        <button type="button" className="btn btn-outline-dark" style={{ minWidth: 64, fontSize: 28 }} aria-label="One more" onClick={() => setQty(String(n + 1))}>+</button>
      </div>
      <input className="form-control mb-3" placeholder="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      {ready && <div className="alert alert-light border py-2">Move {n} × {products.find((p) => p.id === productId)?.name} from <b>{fromName}</b> to <b>{toName}</b>. Both counts change now.</div>}
      <button type="button" className="btn btn-success btn-lg w-100 mb-4" disabled={!ready || busy} onClick={() => void submit()}>{busy ? "Moving…" : "Move now"}</button>

      {receipt && (
        <div className="alert alert-success d-flex flex-wrap align-items-center gap-2" role="status">
          <span className="me-auto fw-semibold">{receipt.reference?.startsWith("OFFLINE-") ? "Saved on this tablet — uploads when online" : "Moved"}{receipt.reference ? ` — ${receipt.reference}` : ""}</span>
          <button type="button" className="btn btn-dark" onClick={() => printSlip(receipt)}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print again</button>
          <button type="button" className="btn btn-outline-secondary" onClick={() => setReceipt(null)}>Close</button>
        </div>
      )}
      <h6 className="mb-2">Moves</h6>
      <div className="d-flex flex-wrap gap-2 mb-2" role="group" aria-label="Day">
        {RANGES.map(([id, label]) => (
          <button key={id} type="button" className={`btn rounded-pill ${range === id ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={range === id} onClick={() => setRange(id)}>{label}</button>
        ))}
      </div>
      {range === "custom" && (
        <div className="d-flex flex-wrap gap-2 align-items-end mb-2">
          <div><label className="form-label small mb-0" htmlFor="mv-from">From</label><input id="mv-from" className="form-control" type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} /></div>
          <div><label className="form-label small mb-0" htmlFor="mv-to">To</label><input id="mv-to" className="form-control" type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} /></div>
        </div>
      )}
      {waiting.length > 0 && (
        <ul className="list-group mb-2">
          {waiting.map((w) => (
            <li key={w.reference} className="list-group-item small d-flex align-items-center gap-2">
              <div className="me-auto">
                <b>{w.rows?.[0]?.qty} × {w.rows?.[0]?.name}</b> · {w.lines?.find((l) => l.label === "From")?.value} → {w.lines?.find((l) => l.label === "To")?.value}
                <div className="text-muted">{w.reference} · {w.when} · <span className="badge text-bg-warning">Waiting to upload</span></div>
              </div>
              <button type="button" className="btn btn-outline-dark text-nowrap" onClick={() => printSlip(w)}><i className="bi bi-receipt me-1" aria-hidden="true"></i>Receipt</button>
            </li>
          ))}
        </ul>
      )}
      <p className="small text-muted mb-2" aria-live="polite">
        {loading ? "Loading…" : `${rows.length} move${rows.length === 1 ? "" : "s"} · ${rows.reduce((t, m) => t + m.quantity, 0)} moved`}
      </p>
      {rows.length === 0 ? <p className="text-muted small">{range === "custom" && !customFrom && !customTo ? "Pick the dates." : "No moves on these days."}</p> : (
        <ul className="list-group">
          {rows.map((m) => (
            <li key={m.id} className="list-group-item small d-flex align-items-center gap-2">
              <div className="me-auto">
                <b>{m.quantity} × {m.productName}</b> · {m.from} → {m.to}
                <div className="text-muted">{m.docNumber} · {new Date(m.at).toLocaleString("en-PH")}{m.note && m.note !== "Moved" ? ` · ${m.note}` : ""}</div>
              </div>
              <button type="button" className="btn btn-outline-dark text-nowrap" aria-label={`Receipt ${m.docNumber ?? ""}`.trim()} onClick={() => printSlip(slip(m))}><i className="bi bi-receipt me-1" aria-hidden="true"></i>Receipt</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

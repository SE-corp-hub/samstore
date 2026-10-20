"use client";

// Move stock: one step — pick from, to, product and how many. Both counts change at once and a record is kept.
// Staff can move rice out of, or into, their own store.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import StoreBar from "./StoreBar";

interface Place { id: string; name: string; code: string | null; isActive: boolean }
interface ProductOption { id: string; name: string }
interface MoveRow { id: string; docNumber: string | null; productName: string; quantity: number; from: string; to: string; note: string | null; at: string }
type Body = { message?: string; errors?: string[]; docNumber?: string };

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

  const loadRows = useCallback(async () => {
    const r = await fetch(`${API_URL}/admin/moves`, { headers: adminHeaders() });
    if (r.ok) setRows(((await r.json()).moves ?? []) as MoveRow[]);
  }, []);

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
      await loadRows();
    })().catch(() => setError("Could not load the stores"));
  }, [loadRows]);

  const n = Number(qty || "0");
  const fromName = places.find((p) => p.id === from)?.name;
  const toName = places.find((p) => p.id === to)?.name;
  const ready = !!from && !!to && from !== to && !!productId && n >= 1;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await sendStep("/admin/moves", { fromLocationId: from, toLocationId: to, productId, quantity: n, note }, "Move stock");
    setBusy(false);
    if (r.status === "queued") { toast("No signal — saved on this phone, will be sent when the signal is back"); return; }
    const d = r.data as Body | null;
    if (!r.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "The move did not go through"); return; }
    toast(`Moved ${n} — ${d?.docNumber ?? "done"}`);
    setQty("1"); setNote(""); setProductId("");
    void loadRows();
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

      <h6>Recent moves</h6>
      {rows.length === 0 ? <p className="text-muted small">None yet.</p> : (
        <ul className="list-group">
          {rows.map((m) => (
            <li key={m.id} className="list-group-item small">
              <b>{m.quantity} × {m.productName}</b> · {m.from} → {m.to}
              <div className="text-muted">{m.docNumber} · {new Date(m.at).toLocaleString()}{m.note && m.note !== "Moved" ? ` · ${m.note}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

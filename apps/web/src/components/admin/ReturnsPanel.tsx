"use client";

// Returned by a customer: product, how many, good or damaged, reason. Good rice goes back on the shelf now;
// damaged rice does not. The owner gets a note to refund or lower the credit. When the sale it came from is picked,
// that refund or credit can be worked out, and at a consignment store the cost charge for the rice comes off.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import StoreBar from "./StoreBar";
import { kg } from "../../lib/number-format";

interface Place { id: string; name: string; code: string | null; isActive: boolean }
interface ProductOption { id: string; name: string }
interface ReturnRow { id: string; docNumber: string; productName: string; quantity: number; condition: "GOOD" | "DAMAGED"; reason: string; locationName: string; orderNumber: string | null; at: string }
interface SaleChoice { orderId: string; orderNumber: string; at: string; customerName: string | null; paymentMethod: string; bought: number; returned: number; left: number; loose: boolean }
type Body = { message?: string; errors?: string[]; docNumber?: string };

/** Loose rice is counted in grams: show kilos. */
const amountText = (loose: boolean, v: number) => (loose ? kg(v) : String(v));

export default function ReturnsPanel() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [condition, setCondition] = useState<"GOOD" | "DAMAGED">("GOOD");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [sales, setSales] = useState<SaleChoice[]>([]);
  const [orderId, setOrderId] = useState("");

  const loadRows = useCallback(async () => {
    const r = await fetch(`${API_URL}/admin/returns`, { headers: adminHeaders() });
    if (r.ok) setRows(((await r.json()).returns ?? []) as ReturnRow[]);
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
      setLocationId(me?.homeLocationId ?? active[0]?.id ?? "");
      setProducts(((ps?.products ?? ps?.items ?? []) as ProductOption[]).map((p) => ({ id: p.id, name: p.name })));
      await loadRows();
    })().catch(() => setError("Could not load the stores"));
  }, [loadRows]);

  // The sales this rice could have come from (recent sales at this store that include it).
  useEffect(() => {
    setOrderId("");
    setSales([]);
    if (!locationId || !productId) return undefined;
    let cancelled = false;
    void fetch(`${API_URL}/admin/returns/sales?locationId=${encodeURIComponent(locationId)}&productId=${encodeURIComponent(productId)}`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setSales((d.sales ?? []) as SaleChoice[]); })
      .catch(() => { /* optional: the return can still be saved without a sale */ });
    return () => { cancelled = true; };
  }, [locationId, productId]);

  const n = Number(qty || "0");
  const ready = !!locationId && !!productId && n >= 1 && reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await sendStep("/admin/returns", { locationId, productId, quantity: n, condition, reason: reason.trim(), ...(orderId ? { orderId } : {}) }, "Customer return");
    setBusy(false);
    if (r.status === "queued") { setQty("1"); setReason(""); setProductId(""); setCondition("GOOD"); setOrderId(""); return; } // saved offline: shown in the upload bar
    const d = r.data as Body | null;
    if (!r.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "The return did not go through"); return; }
    toast(condition === "GOOD" ? `Back on the shelf — ${d?.docNumber ?? "done"}. The owner was told to refund or lower the credit.` : `Recorded — ${d?.docNumber ?? "done"}. Damaged rice is not added to stock.`);
    setQty("1"); setReason(""); setProductId(""); setCondition("GOOD"); setOrderId("");
    void loadRows();
  };

  return (
    <div className="container py-3" style={{ maxWidth: 640 }}>
      <h5 className="mb-3">Returned by a customer</h5>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      <StoreBar label="Returned to" locations={places} value={locationId} homeLocationId={home} onPick={setLocationId} />
      <label className="form-label small text-muted" htmlFor="rt-product">Product</label>
      <select id="rt-product" className="form-select form-select-lg mb-3" value={productId} onChange={(e) => setProductId(e.target.value)}>
        <option value="">Choose the product…</option>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {productId && (
        <>
          <label className="form-label small text-muted" htmlFor="rt-sale">Which sale was it? (if you know)</label>
          <select id="rt-sale" className="form-select form-select-lg mb-1" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">I do not know / not a recent sale</option>
            {sales.map((o) => (
              <option key={o.orderId} value={o.orderId}>
                {o.orderNumber} · {new Date(o.at).toLocaleDateString("en-PH")}{o.customerName ? ` · ${o.customerName}` : ""} · bought {amountText(o.loose, o.bought)}{o.returned > 0 ? `, ${amountText(o.loose, o.returned)} already back` : ""}
              </option>
            ))}
          </select>
          <div className="form-text mb-3">Pick the sale so the refund or the lower credit can be worked out. At a consignment store it also takes the charge for this rice off.</div>
        </>
      )}
      <label className="form-label small text-muted" htmlFor="rt-qty">How many came back</label>
      <div className="input-group input-group-lg mb-3" style={{ maxWidth: 280 }}>
        <button type="button" className="btn btn-outline-dark" style={{ minWidth: 64, fontSize: 28 }} aria-label="One less" disabled={n <= 1} onClick={() => setQty(String(Math.max(1, n - 1)))}>−</button>
        <input id="rt-qty" className="form-control text-center" style={{ fontSize: 28 }} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 5))} />
        <button type="button" className="btn btn-outline-dark" style={{ minWidth: 64, fontSize: 28 }} aria-label="One more" onClick={() => setQty(String(n + 1))}>+</button>
      </div>
      <div className="d-flex gap-2 mb-3" role="group" aria-label="Condition">
        <button type="button" className={`btn btn-lg flex-fill ${condition === "GOOD" ? "btn-success" : "btn-outline-success"}`} onClick={() => setCondition("GOOD")}>Good — back on the shelf</button>
        <button type="button" className={`btn btn-lg flex-fill ${condition === "DAMAGED" ? "btn-danger" : "btn-outline-danger"}`} onClick={() => setCondition("DAMAGED")}>Damaged</button>
      </div>
      <input className="form-control form-control-lg mb-3" placeholder="Reason (why was it returned?)" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn btn-success btn-lg w-100 mb-4" disabled={!ready || busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save return"}</button>

      <h6>Recent returns</h6>
      {rows.length === 0 ? <p className="text-muted small">None yet.</p> : (
        <ul className="list-group">
          {rows.map((r) => (
            <li key={r.id} className="list-group-item small">
              <b>{r.quantity} × {r.productName}</b> · <span className={r.condition === "GOOD" ? "text-success" : "text-danger"}>{r.condition === "GOOD" ? "good" : "damaged"}</span> · {r.locationName}
              <div className="text-muted">{r.docNumber}{r.orderNumber ? ` · order ${r.orderNumber}` : ""} · {r.reason} · {new Date(r.at).toLocaleString()}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

// Rice Ops M1 — Locations (stores + warehouse), transfers between them, and each
// location's own selling prices. A "warehouse" row in the API is a stock location.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import SignCapture, { type SignatureOut } from "./SignCapture";
import { peso } from "../../lib/number-format";

type LocationType = "STORE" | "WAREHOUSE" | "BUFFER";
interface Location {
  id: string;
  name: string;
  code: string | null;
  type: LocationType;
  address: string | null;
  isActive: boolean;
  isDefault: boolean;
  needsReview?: boolean;
  consignment?: boolean;
  stockCount: number;
}
interface Transfer {
  id: string;
  docNumber?: string | null;
  kind?: "RESTOCK" | "ORDER_RELEASE";
  shortQty?: number;
  status: string;
  quantity: number;
  reason: string | null;
  createdAt: string;
  fromWarehouse: { name: string; code: string | null };
  toWarehouse: { name: string; code: string | null };
  product: { name: string; sku: string };
}
interface ProductOption { id: string; name: string; sku: string }
interface PriceRow {
  productId: string;
  name: string;
  sku: string;
  mainPriceMinor: number;
  locationPriceMinor: number | null;
  effectivePriceMinor: number;
}
type ApiBody = { message?: string; errors?: string[]; prices?: PriceRow[] };

const label = (l: { name: string; code: string | null }) => (l.code ? `${l.code} · ${l.name}` : l.name);
const emptyForm = { name: "", code: "", type: "STORE" as LocationType, address: "", consignment: false };
const errorText = (d: ApiBody, fallback: string) => d?.errors?.join(", ") ?? d?.message ?? fallback;

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: ApiBody }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? adminHeaders() : { "Content-Type": "application/json", ...adminHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ApiBody;
  return { ok: res.ok, data };
}

const STATUS_BADGE: Record<string, string> = {
  REQUESTED: "text-bg-warning", APPROVED: "text-bg-info", IN_TRANSIT: "text-bg-primary",
  COMPLETED: "text-bg-success", CANCELLED: "text-bg-secondary", RETURNING: "text-bg-warning",
};

export default function WarehousesPanel() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [transfer, setTransfer] = useState({ from: "", to: "", productId: "", quantity: "", reason: "" });
  const [requesting, setRequesting] = useState(false);
  // Rice Ops M2: receiving is signed — the step waits here until the receiver signs.
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const [signingBusy, setSigningBusy] = useState(false);
  const [priceLocation, setPriceLocation] = useState("");
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, t, p] = await Promise.all([
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/transfers`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setLocations(w.warehouses ?? []);
      setTransfers(t.transfers ?? []);
      setProducts(p.products ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load locations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const active = useMemo(() => locations.filter((l) => l.isActive), [locations]);

  const loadPrices = useCallback(async (locationId: string) => {
    setPriceLocation(locationId);
    setPrices([]);
    setPriceDraft({});
    if (!locationId) return;
    const { ok, data } = await call(`${API_URL}/admin/warehouses/${locationId}/prices`, "GET");
    if (!ok) { setError(errorText(data, "Could not load prices")); return; }
    setPrices(data.prices ?? []);
  }, []);

  const saveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = { name: form.name, code: form.code || null, type: form.type, address: form.address || null, consignment: form.consignment };
    const { ok, data } = editingId
      ? await call(`${API_URL}/admin/warehouses/${editingId}`, "PATCH", body)
      : await call(`${API_URL}/admin/warehouses`, "POST", body);
    setSaving(false);
    if (!ok) { setError(errorText(data, "Could not save the location")); return; }
    toast(editingId ? "Location saved" : "Location added");
    setForm(emptyForm);
    setEditingId(null);
    await load();
  };

  const patchLocation = async (l: Location, patch: Partial<Pick<Location, "isActive" | "isDefault" | "needsReview">>, done: string) => {
    setError(null);
    const { ok, data } = await call(`${API_URL}/admin/warehouses/${l.id}`, "PATCH", patch);
    if (!ok) { setError(errorText(data, "Could not update the location")); return; }
    toast(done);
    await load();
  };

  const startEdit = (l: Location) => {
    setEditingId(l.id);
    setForm({ name: l.name, code: l.code ?? "", type: l.type, address: l.address ?? "", consignment: l.consignment === true });
  };

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    setRequesting(true);
    setError(null);
    const { ok, data } = await call(`${API_URL}/admin/moves`, "POST", {
      fromLocationId: transfer.from,
      toLocationId: transfer.to,
      productId: transfer.productId,
      quantity: parseInt(transfer.quantity, 10),
      note: transfer.reason || undefined,
    });
    setRequesting(false);
    if (!ok) { setError(errorText(data, "Could not move the stock")); return; }
    toast("Moved — both counts changed");
    setTransfer({ from: "", to: "", productId: "", quantity: "", reason: "" });
    await load();
  };

  const act = async (t: Transfer, step: "approve" | "cancel", done: string) => {
    setError(null);
    const { ok, data } = await call(`${API_URL}/admin/transfers/${t.id}/${step}`, "PATCH", step === "cancel" ? {} : undefined);
    if (!ok) { setError(errorText(data, "Action failed")); return; }
    toast(done);
    await load();
  };

  const receive = async (t: Transfer, signatures: SignatureOut[]) => {
    setSigningBusy(true);
    setError(null);
    const { ok, data } = await call(`${API_URL}/admin/transfers/${t.id}/complete`, "PATCH", { signatures });
    setSigningBusy(false);
    setReceiving(null);
    if (!ok) { setError(errorText(data, "Not received")); return; }
    toast("Received");
    await load();
  };

  const savePrice = async (row: PriceRow, clear = false) => {
    setError(null);
    let priceMinor: number | null = null;
    if (!clear) {
      const raw = priceDraft[row.productId];
      const value = Number(raw);
      if (!raw || !Number.isFinite(value) || value <= 0) { setError("Enter a price above ₱0, or choose Use main."); return; }
      priceMinor = Math.round(value * 100);
    }
    const { ok, data } = await call(`${API_URL}/admin/warehouses/${priceLocation}/prices/${row.productId}`, "PUT", { priceMinor });
    if (!ok) { setError(errorText(data, "Could not save the price")); return; }
    toast(clear ? "Main price restored" : "Price saved");
    await loadPrices(priceLocation);
  };

  return (
    <div>
      <h1 className="h4 mb-1"><i className="bi bi-geo-alt me-2" aria-hidden="true"></i>Locations &amp; transfers</h1>
      <p className="text-muted small mb-3">Your stores and warehouse share one stock ledger. Every move between them is recorded.</p>
      {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}

      <div className="row g-3 mb-3">
        <div className="col-lg-5">
          <form onSubmit={saveLocation} className="card h-100">
            <div className="card-body">
              <h2 className="h6 card-title">{editingId ? "Edit location" : "Add a location"}</h2>
              <div className="row g-2">
                <div className="col-8">
                  <label className="form-label small mb-1" htmlFor="loc-name">Name</label>
                  <input id="loc-name" className="form-control form-control-sm" placeholder="e.g. Store 2" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={60} />
                </div>
                <div className="col-4">
                  <label className="form-label small mb-1" htmlFor="loc-code">Code</label>
                  <input id="loc-code" className="form-control form-control-sm text-uppercase" placeholder="S2" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={6} />
                </div>
                <div className="col-12">
                  <label className="form-label small mb-1" htmlFor="loc-type">Type</label>
                  <select id="loc-type" className="form-select form-select-sm" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as LocationType })}>
                    <option value="STORE">Store (counter)</option>
                    <option value="WAREHOUSE">Warehouse (bulk stock)</option>
                    <option value="BUFFER">Buffer store (covers shortages, no limit)</option>
                  </select>
                </div>
                {form.type === "STORE" && (
                  <div className="col-12">
                    <div className="form-check">
                      <input id="loc-consign" type="checkbox" className="form-check-input" checked={form.consignment} onChange={(e) => setForm({ ...form, consignment: e.target.checked })} />
                      <label className="form-check-label small" htmlFor="loc-consign">Consignment store: sells the main store&apos;s rice and owes its cost for each sale</label>
                    </div>
                  </div>
                )}
                <div className="col-12">
                  <label className="form-label small mb-1" htmlFor="loc-address">Address (for the porter)</label>
                  <input id="loc-address" className="form-control form-control-sm" placeholder="Street, barangay" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={300} />
                </div>
              </div>
              <div className="d-flex gap-2 mt-3">
                <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? "Saving…" : editingId ? "Save location" : "Add location"}</button>
                {editingId && <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel</button>}
              </div>
              {locations.length === 0 && <p className="text-muted small mt-2 mb-0">The first location becomes the default.</p>}
            </div>
          </form>
        </div>

        <div className="col-lg-7">
          <form onSubmit={request} className="card h-100">
            <div className="card-body">
              <h2 className="h6 card-title">Move stock now</h2>
              <div className="row g-2">
                <div className="col-md-6">
                  <label className="form-label small mb-1" htmlFor="tr-from">From</label>
                  <select id="tr-from" className="form-select form-select-sm" required value={transfer.from} onChange={(e) => setTransfer({ ...transfer, from: e.target.value })}>
                    <option value="">Choose…</option>
                    {active.map((l) => <option key={l.id} value={l.id}>{label(l)}</option>)}
                  </select>
                </div>
                <div className="col-md-6">
                  <label className="form-label small mb-1" htmlFor="tr-to">To</label>
                  <select id="tr-to" className="form-select form-select-sm" required value={transfer.to} onChange={(e) => setTransfer({ ...transfer, to: e.target.value })}>
                    <option value="">Choose…</option>
                    {active.filter((l) => l.id !== transfer.from).map((l) => <option key={l.id} value={l.id}>{label(l)}</option>)}
                  </select>
                </div>
                <div className="col-md-8">
                  <label className="form-label small mb-1" htmlFor="tr-product">Product</label>
                  <select id="tr-product" className="form-select form-select-sm" required value={transfer.productId} onChange={(e) => setTransfer({ ...transfer, productId: e.target.value })}>
                    <option value="">Choose…</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="col-md-4">
                  <label className="form-label small mb-1" htmlFor="tr-qty">Quantity</label>
                  <input id="tr-qty" className="form-control form-control-sm" type="number" inputMode="numeric" min="1" step="1" required value={transfer.quantity} onChange={(e) => setTransfer({ ...transfer, quantity: e.target.value })} />
                </div>
                <div className="col-md-8">
                  <label className="form-label small mb-1" htmlFor="tr-reason">Reason (optional)</label>
                  <input id="tr-reason" className="form-control form-control-sm" placeholder="e.g. restock for the weekend" value={transfer.reason} onChange={(e) => setTransfer({ ...transfer, reason: e.target.value })} />
                </div>
                <div className="col-md-4 d-flex align-items-end">
                  <button className="btn btn-primary btn-sm w-100" type="submit" disabled={requesting || active.length < 2}>{requesting ? "Moving…" : "Move now"}</button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>

      <div className="row g-3 mb-3">
        <div className="col-lg-5">
          <div className="card h-100"><div className="card-body">
            <h2 className="h6 card-title">Locations</h2>
            {loading ? <p className="text-muted small">Loading…</p> : locations.length === 0 ? (
              <p className="text-muted small mb-0">No locations yet — add your first store above.</p>
            ) : (
              <ul className="list-group list-group-flush">
                {locations.map((l) => (
                  <li key={l.id} className={`list-group-item px-0 ${l.isActive ? "" : "opacity-50"}`}>
                    <div className="d-flex justify-content-between align-items-start gap-2">
                      <div>
                        <div className="fw-semibold">{label(l)}</div>
                        <div className="small text-muted">
                          {l.type === "WAREHOUSE" ? "Warehouse" : l.type === "BUFFER" ? "Buffer" : l.consignment ? "Consignment store" : "Store"} · {l.stockCount} products stocked
                          {l.isDefault && <span className="badge text-bg-primary ms-2">Default</span>}
                          {!l.isActive && <span className="badge text-bg-secondary ms-2">Switched off</span>}
                          {l.needsReview && <span className="badge text-bg-warning ms-2">Added by staff — please check</span>}
                        </div>
                        {l.address && <div className="small text-muted">{l.address}</div>}
                      </div>
                      <div className="d-flex flex-wrap gap-1 justify-content-end">
                        {l.needsReview && <button type="button" className="btn btn-sm btn-warning" onClick={() => void patchLocation(l, { needsReview: false }, `${l.name} checked`)}>Mark checked</button>}
                        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => startEdit(l)}>Edit</button>
                        {!l.isDefault && l.isActive && (
                          <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => void patchLocation(l, { isDefault: true }, `${l.name} is now the default`)}>Make default</button>
                        )}
                        {!l.isDefault && (
                          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void patchLocation(l, { isActive: !l.isActive }, l.isActive ? "Location switched off" : "Location switched on")}>
                            {l.isActive ? "Switch off" : "Switch on"}
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div></div>
        </div>

        <div className="col-lg-7">
          <div className="card h-100"><div className="card-body">
            <h2 className="h6 card-title">Moves</h2>
            {receiving && (
              <SignCapture
                sentence={`Tatanggapin: ${receiving.quantity} × ${receiving.product.name}, mula ${label(receiving.fromWarehouse)} papuntang ${label(receiving.toWarehouse)}.`}
                staffName="you (staff)"
                busy={signingBusy}
                onCancel={() => setReceiving(null)}
                onDone={(sigs) => void receive(receiving, sigs)}
              />
            )}
            {loading ? <p className="text-muted small">Loading…</p> : transfers.length === 0 ? (
              <p className="text-muted small mb-0">No transfers yet.</p>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm align-middle mb-0">
                  <thead><tr><th>Product</th><th>From → To</th><th className="text-end">Qty</th><th>Status</th><th className="text-end">Actions</th></tr></thead>
                  <tbody>
                    {transfers.map((t) => (
                      <tr key={t.id}>
                        <td className="small">{t.docNumber && <div className="text-muted">{t.docNumber}</div>}{t.product.name}{t.reason && <div className="text-muted">{t.reason}</div>}{!!t.shortQty && <div><span className="badge text-bg-danger">Short {t.shortQty}</span></div>}</td>
                        <td className="small text-muted">{label(t.fromWarehouse)} → {label(t.toWarehouse)}</td>
                        <td className="text-end">{t.quantity}</td>
                        <td><span className={`badge ${STATUS_BADGE[t.status] ?? "text-bg-secondary"}`}>{t.status}</span></td>
                        <td className="text-end text-nowrap">
                          {(t.status === "REQUESTED" || t.status === "APPROVED") && t.kind !== "ORDER_RELEASE" && (
                            <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => void act(t, "cancel", "Transfer cancelled")}>Cancel</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div></div>
        </div>
      </div>

      <div className="card"><div className="card-body">
        <div className="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-2">
          <div>
            <h2 className="h6 card-title mb-0">Selling price per location</h2>
            <p className="text-muted small mb-0">Cost is the same everywhere. A location without its own price sells at the main price.</p>
          </div>
          <div>
            <label className="form-label small mb-1" htmlFor="price-loc">Location</label>
            <select id="price-loc" className="form-select form-select-sm" value={priceLocation} onChange={(e) => void loadPrices(e.target.value)}>
              <option value="">Choose…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{label(l)}</option>)}
            </select>
          </div>
        </div>
        {priceLocation && (prices.length === 0 ? <p className="text-muted small mb-0">No active products.</p> : (
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead><tr><th>Product</th><th className="text-end">Main price</th><th className="text-end">This location</th><th style={{ width: 260 }}>Set price (₱)</th></tr></thead>
              <tbody>
                {prices.map((row) => (
                  <tr key={row.productId}>
                    <td className="small">{row.name}<div className="text-muted">{row.sku}</div></td>
                    <td className="text-end small">{peso(row.mainPriceMinor)}</td>
                    <td className="text-end small fw-semibold">{row.locationPriceMinor === null ? <span className="text-muted fw-normal">uses main</span> : peso(row.locationPriceMinor)}</td>
                    <td>
                      <div className="input-group input-group-sm">
                        <input
                          aria-label={`Price for ${row.name} at this location`}
                          className="form-control"
                          type="number"
                          inputMode="decimal"
                          min="0.01"
                          step="0.01"
                          placeholder={(row.effectivePriceMinor / 100).toFixed(2)}
                          value={priceDraft[row.productId] ?? ""}
                          onChange={(e) => setPriceDraft({ ...priceDraft, [row.productId]: e.target.value })}
                        />
                        <button type="button" className="btn btn-outline-primary" onClick={() => void savePrice(row)}>Save</button>
                        {row.locationPriceMinor !== null && (
                          <button type="button" className="btn btn-outline-secondary" onClick={() => void savePrice(row, true)}>Use main</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div></div>
    </div>
  );
}

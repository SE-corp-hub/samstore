"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface Warehouse { id: string; name: string; isDefault: boolean; stockCount: number; }
interface Transfer {
  id: string;
  status: string;
  quantity: number;
  reason: string | null;
  createdAt: string;
  fromWarehouse: { name: string };
  toWarehouse: { name: string };
  product: { name: string; sku: string };
}
interface ProductOption { id: string; name: string; sku: string; }

export default function WarehousesPanel() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [transfer, setTransfer] = useState({ from: "", to: "", productId: "", quantity: "", reason: "" });
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, t, p] = await Promise.all([
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/transfers`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setWarehouses(w.warehouses ?? []);
      setTransfers(t.transfers ?? []);
      setProducts(p.products ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/warehouses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.errors?.join(", ") ?? data?.message ?? "Create failed"); return; }
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    setRequesting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          fromWarehouseId: transfer.from,
          toWarehouseId: transfer.to,
          productId: transfer.productId,
          quantity: parseInt(transfer.quantity, 10),
          reason: transfer.reason || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.errors?.join(", ") ?? data?.message ?? "Request failed"); return; }
      setTransfer({ from: "", to: "", productId: "", quantity: "", reason: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setRequesting(false);
    }
  };

  const act = async (url: string, method: string) => {
    setError(null);
    const res = await fetch(url, { method, headers: adminHeaders() });
    if (!res.ok) { const d = await res.json().catch(() => null); setError(d?.message ?? "Action failed"); return; }
    await load();
  };

  const STATUS_BADGE: Record<string, string> = {
    REQUESTED: "text-bg-warning", APPROVED: "text-bg-info", IN_TRANSIT: "text-bg-primary",
    COMPLETED: "text-bg-success", CANCELLED: "text-bg-danger",
  };

  return (
    <div>
      <h1 className="h4 mb-3">Warehouses &amp; Transfers</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <div className="row g-3 mb-3">
        <div className="col-md-5">
          <form onSubmit={create} className="card">
            <div className="card-body">
              <h6 className="card-title">New warehouse</h6>
              <div className="d-flex gap-2">
                <input className="form-control form-control-sm" placeholder="e.g. Warehouse 2" value={name} onChange={(e) => setName(e.target.value)} required />
                <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>{creating ? "…" : "Create"}</button>
              </div>
              {warehouses.length === 0 && <p className="text-muted small mt-2 mb-0">First warehouse becomes the default.</p>}
            </div>
          </form>
        </div>
        <div className="col-md-7">
          <form onSubmit={request} className="card">
            <div className="card-body">
              <h6 className="card-title">Request transfer</h6>
              <div className="row g-2">
                <div className="col-md-4">
                  <select className="form-select form-select-sm" required value={transfer.from} onChange={(e) => setTransfer({ ...transfer, from: e.target.value })}>
                    <option value="">From…</option>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
                <div className="col-md-4">
                  <select className="form-select form-select-sm" required value={transfer.to} onChange={(e) => setTransfer({ ...transfer, to: e.target.value })}>
                    <option value="">To…</option>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
                <div className="col-md-4">
                  <select className="form-select form-select-sm" required value={transfer.productId} onChange={(e) => setTransfer({ ...transfer, productId: e.target.value })}>
                    <option value="">Product…</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="col-md-4">
                  <input className="form-control form-control-sm" type="number" min="1" placeholder="Qty" required value={transfer.quantity} onChange={(e) => setTransfer({ ...transfer, quantity: e.target.value })} />
                </div>
                <div className="col-md-6">
                  <input className="form-control form-control-sm" placeholder="Reason (optional)" value={transfer.reason} onChange={(e) => setTransfer({ ...transfer, reason: e.target.value })} />
                </div>
                <div className="col-md-2">
                  <button className="btn btn-primary btn-sm w-100" type="submit" disabled={requesting || warehouses.length < 2}>{requesting ? "…" : "Request"}</button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-md-5">
          <div className="card"><div className="card-body">
            <h6 className="card-title">Warehouses</h6>
            {loading ? <p className="text-muted small">Loading…</p> : warehouses.length === 0 ? (
              <p className="text-muted small mb-0">No warehouses yet.</p>
            ) : (
              <ul className="list-group list-group-flush">
                {warehouses.map((w) => (
                  <li key={w.id} className="list-group-item px-0 d-flex justify-content-between">
                    <span>{w.name} {w.isDefault && <span className="badge text-bg-primary ms-1">default</span>}</span>
                    <span className="text-muted small">{w.stockCount} stock rows</span>
                  </li>
                ))}
              </ul>
            )}
          </div></div>
        </div>
        <div className="col-md-7">
          <div className="card"><div className="card-body">
            <h6 className="card-title">Transfers</h6>
            {loading ? <p className="text-muted small">Loading…</p> : transfers.length === 0 ? (
              <p className="text-muted small mb-0">No transfers yet.</p>
            ) : (
              <table className="table table-sm align-middle mb-0">
                <thead><tr><th>Product</th><th>From → To</th><th className="text-end">Qty</th><th>Status</th><th className="text-end">Actions</th></tr></thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id}>
                      <td className="small">{t.product.name}</td>
                      <td className="small text-muted">{t.fromWarehouse.name} → {t.toWarehouse.name}</td>
                      <td className="text-end">{t.quantity}</td>
                      <td><span className={`badge ${STATUS_BADGE[t.status] ?? "text-bg-secondary"}`}>{t.status}</span></td>
                      <td className="text-end">
                        {t.status === "REQUESTED" && (
                          <button className="btn btn-sm btn-outline-success" onClick={() => act(`${API_URL}/admin/transfers/${t.id}/approve`, "PATCH")}>Approve</button>
                        )}
                        {(t.status === "APPROVED" || t.status === "IN_TRANSIT") && (
                          <button className="btn btn-sm btn-outline-primary" onClick={() => act(`${API_URL}/admin/transfers/${t.id}/complete`, "PATCH")}>Complete</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div></div>
        </div>
      </div>
    </div>
  );
}
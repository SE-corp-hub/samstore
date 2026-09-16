"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface ProductOption { id: string; name: string; sku: string; availableQuantity: number }
interface ReplenishItem { id: string; name: string; sku: string; availableQuantity: number; reorderThreshold: number }
interface Line { productId: string; quantity: number; costMinor: number; productName?: string; unitCostPesos?: number }
interface PurchaseRow {
  id: string; vendor: string | null; vendorId: string | null; supplier: { name: string } | null; note: string | null; totalCostMinor: number; purchasedAt: string;
  items: { id: string; product: { name: string; sku: string }; quantity: number; costMinor: number; lineCostMinor: number }[];
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

export default function PurchasesPanel() {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [replenish, setReplenish] = useState<ReplenishItem[]>([]);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [vendor, setVendor] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [supplierOptions, setSupplierOptions] = useState<{ id: string; name: string }[]>([]);
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r, x, s] = await Promise.all([
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((x) => x.json()),
        fetch(`${API_URL}/admin/purchases/replenishment`, { headers: adminHeaders() }).then((x) => x.json()),
        fetch(`${API_URL}/admin/purchases`, { headers: adminHeaders() }).then((x) => x.json()),
        fetch(`${API_URL}/admin/suppliers`, { headers: adminHeaders() }).then((x) => x.json()),
      ]);
      setProducts((p.products ?? []).map((q: ProductOption) => q));
      setReplenish(r.items ?? []);
      setRows(x.purchases ?? []);
      setSupplierOptions((s.suppliers ?? []).map((q: { id: string; name: string }) => q));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addLine = (productId: string) => {
    const prod = products.find((p) => p.id === productId);
    if (!prod) return;
    setLines((ls) => [...ls, { productId, quantity: 1, costMinor: 0, productName: prod.name }]);
  };

  const patchLine = (idx: number, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const removeLine = (idx: number) => setLines((ls) => ls.filter((_, i) => i !== idx));

  const totalCost = lines.reduce((s, l) => s + l.quantity * l.costMinor, 0);

  const submit = async () => {
    setError(null);
    if (lines.length === 0) { setError("Add at least one line"); return; }
    const res = await fetch(`${API_URL}/admin/purchases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({
        vendor: vendor || undefined,
        supplierId: supplierId || undefined,
        note: note || undefined,
        items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, costMinor: l.costMinor })),
      }),
    });
    if (res.ok) {
      setShowForm(false);
      setVendor("");
      setSupplierId("");
      setNote("");
      setLines([]);
      toast("Purchase completed — stock added");
      await load();
    } else {
      const d = await res.json();
      setError(d?.message ?? "Purchase failed");
    }
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h1 className="h4 mb-0"><i className="bi bi-box-seam me-2"></i>Purchases</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
          <i className="bi bi-plus-lg me-1"></i>New purchase
        </button>
      </div>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {replenish.length > 0 && (
        <div className="alert alert-warning py-2 small">
          <strong>Replenish needed:</strong>{" "}
          {replenish.slice(0, 6).map((r) => (
            <button key={r.id} className="btn btn-outline-warning btn-sm me-1 mb-1"
              onClick={() => { setShowForm(true); addLine(r.id); }}>
              {r.name} ({r.availableQuantity}/{r.reorderThreshold})
            </button>
          ))}
          {replenish.length > 6 && <span>+{replenish.length - 6} more</span>}
        </div>
      )}

      {showForm && (
        <div className="card mb-3">
          <div className="card-body">
            <div className="row g-2 mb-2">
              <div className="col-4">
                <input className="form-control form-control-sm" placeholder="Vendor (legacy, optional)" value={vendor} onChange={(e) => setVendor(e.target.value)} />
              </div>
              <div className="col-4">
                <select
                  className="form-select form-select-sm"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">— Supplier (or type to add) —</option>
                  {supplierOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="col-4">
                <input className="form-control form-control-sm" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
            {supplierId && (
              <div className="mb-2">
                <button className="btn btn-outline-primary btn-sm" onClick={() => { setSupplierId(""); setVendor(""); }}>Clear supplier</button>
              </div>
            )}
            {lines.length === 0 ? (
              <p className="text-muted small mb-1">No lines yet — pick a product above (or tap a replenish button).</p>
            ) : (
              <table className="table table-sm">
                <thead><tr><th>Product</th><th className="text-end" style={{ width: 90 }}>Qty</th><th className="text-end" style={{ width: 120 }}>Unit cost ₱</th><th className="text-end" style={{ width: 110 }}>Line</th><th style={{ width: 40 }}></th></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.productName}</td>
                      <td><input className="form-control form-control-sm text-end" type="number" min="1" value={l.quantity} onChange={(e) => patchLine(i, { quantity: Math.max(1, parseInt(e.target.value) || 1) })} /></td>
                      <td><input className="form-control form-control-sm text-end" type="number" min="0" step="0.01" value={(l.costMinor / 100).toFixed(2)} onChange={(e) => patchLine(i, { costMinor: Math.round(parseFloat(e.target.value || "0") * 100) })} /></td>
                      <td className="text-end">{toPesos(l.quantity * l.costMinor)}</td>
                      <td><button className="btn btn-sm btn-outline-danger py-0" onClick={() => removeLine(i)}><i className="bi bi-x"></i></button></td>
                    </tr>
                  ))}
                  <tr className="fw-bold"><td colSpan={3} className="text-end">Total</td><td className="text-end">{toPesos(totalCost)}</td><td></td></tr>
                </tbody>
              </table>
            )}
            {lines.length > 0 && (
              <button className="btn btn-success btn-sm" onClick={submit}><i className="bi bi-check-lg me-1"></i>Complete purchase (+stock)</button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted">No purchases yet.</p>
      ) : (
        <table className="table table-hover align-middle">
          <thead><tr><th>Date</th><th>Supplier</th><th>Vendor (legacy)</th><th>Items</th><th className="text-end">Total</th><th>Note</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small text-muted">{new Date(r.purchasedAt).toLocaleString()}</td>
                <td>{r.supplier?.name ?? r.vendor ?? "—"}</td>
                <td className="small text-muted">{r.supplier ? (r.vendor ?? "—") : "—"}</td>
                <td className="small text-muted">{r.items.map((i) => `${i.product.name} ×${i.quantity}`).join(", ")}</td>
                <td className="text-end fw-semibold">{toPesos(r.totalCostMinor)}</td>
                <td className="small text-muted">{r.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
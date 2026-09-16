"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface InvItem {
  id: string; name: string; sku: string; category: string | null;
  quantityOnHand: number; quantityReserved: number; availableQuantity: number;
  reorderThreshold: number; costMinor: number; valueMinor: number; status: "in" | "low" | "out";
}
interface Warehouse { id: string; name: string; isDefault: boolean }
interface Category { id: string; name: string }

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const STATUS_BADGE: Record<string, string> = { in: "text-bg-success", low: "text-bg-warning", out: "text-bg-danger" };

export default function InventoryPanel() {
  const [items, setItems] = useState<InvItem[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [totalValue, setTotalValue] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<"name" | "qty" | "value">("name");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (search) q.set("search", search);
      if (categoryId) q.set("categoryId", categoryId);
      if (warehouseId) q.set("warehouseId", warehouseId);
      if (status) q.set("status", status);
      const res = await fetch(`${API_URL}/admin/inventory?${q.toString()}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load inventory");
      const data = await res.json();
      let rows: InvItem[] = data.items ?? [];
      if (sort === "qty") rows = [...rows].sort((a, b) => a.quantityOnHand - b.quantityOnHand);
      else if (sort === "value") rows = [...rows].sort((a, b) => b.valueMinor - a.valueMinor);
      else rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
      setItems(rows);
      setWarehouses(data.warehouses ?? []);
      setCategories(data.categories ?? []);
      setTotalValue(data.totalValueMinor ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [search, categoryId, warehouseId, status, sort]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  // ── M2: reasoned adjustments + the ledger views ──
  const [view, setView] = useState<"stock" | "history">("stock");
  const [adjust, setAdjust] = useState<InvItem | null>(null);
  const [adjustMode, setAdjustMode] = useState<"delta" | "setTo">("delta");
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustAllowNegative, setAdjustAllowNegative] = useState(false);
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [historyProduct, setHistoryProduct] = useState("");
  const [history, setHistory] = useState<{
    id: string; productName: string; sku: string | null; delta: number; type: string;
    note: string | null; balanceAfter: number | null; actor: string | null; createdAt: string;
  }[]>([]);

  const loadHistory = useCallback(async () => {
    const q = new URLSearchParams({ limit: "100" });
    if (historyProduct) q.set("productId", historyProduct);
    const res = await fetch(`${API_URL}/admin/stock/movements?${q.toString()}`, { headers: adminHeaders() });
    if (res.ok) {
      const d = await res.json();
      setHistory(d.movements ?? []);
    }
  }, [historyProduct]);

  useEffect(() => { if (view === "history") void loadHistory(); }, [view, loadHistory]);

  const submitAdjust = async () => {
    if (!adjust) return;
    setAdjustBusy(true);
    setAdjustError(null);
    try {
      const qty = Number.parseInt(adjustQty, 10);
      if (!Number.isFinite(qty)) { setAdjustError("Enter a quantity"); return; }
      if (adjustReason.trim().length < 3) { setAdjustError("A reason is required (3+ characters) — it is stored on the ledger row"); return; }
      const body: Record<string, unknown> = {
        productId: adjust.id,
        reason: adjustReason.trim(),
        allowNegative: adjustAllowNegative,
      };
      if (adjustMode === "delta") body.delta = qty;
      else body.setTo = qty;
      const res = await fetch(`${API_URL}/admin/stock/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setAdjustError(d?.message ?? (Array.isArray(d?.errors) ? d.errors.join("; ") : "Adjustment failed"));
        return;
      }
      setAdjust(null); setAdjustQty(""); setAdjustReason(""); setAdjustAllowNegative(false);
      await load();
      if (view === "history") await loadHistory();
    } catch (e) {
      setAdjustError(e instanceof Error ? e.message : "Adjustment failed");
    } finally {
      setAdjustBusy(false);
    }
  };

  return (
    <div>
      <h1 className="h4 mb-3"><i className="bi bi-boxes me-2"></i>Inventory</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <div className="row g-2 mb-2">
        <div className="col-md-3">
          <input className="form-control form-control-sm" placeholder="Search name or SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="col-md-2">
          <select className="form-select form-select-sm" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="col-md-2">
          <select className="form-select form-select-sm" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">All warehouses</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}{w.isDefault ? " (default)" : ""}</option>)}
          </select>
        </div>
        <div className="col-md-2">
          <select className="form-select form-select-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All stock</option>
            <option value="in">In stock</option>
            <option value="low">Low</option>
            <option value="out">Out</option>
          </select>
        </div>
        <div className="col-md-3">
          <select className="form-select form-select-sm" value={sort} onChange={(e) => setSort(e.target.value as "name" | "qty" | "value")}>
            <option value="name">Sort: name</option>
            <option value="qty">Sort: quantity</option>
            <option value="value">Sort: value</option>
          </select>
        </div>
      </div>

      <div className="alert alert-primary py-2 small d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span><strong>{items.length}</strong> products</span>
        <span>Inventory value (cost): <strong>{toPesos(totalValue)}</strong></span>
        <div className="btn-group btn-group-sm" role="group" aria-label="Inventory view">
          <button type="button" className={`btn ${view === "stock" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setView("stock")}>
            <i className="bi bi-boxes me-1"></i>Stock
          </button>
          <button type="button" className={`btn ${view === "history" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setView("history")}>
            <i className="bi bi-clock-history me-1"></i>Stock flow
          </button>
        </div>
      </div>

      {view === "history" ? (
        <div>
          <div className="row g-2 mb-2">
            <div className="col-md-4">
              <select className="form-select form-select-sm" value={historyProduct} onChange={(e) => setHistoryProduct(e.target.value)}>
                <option value="">All products</option>
                {items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="col-md-3">
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void loadHistory()}>
                <i className="bi bi-arrow-clockwise me-1"></i>Refresh
              </button>
            </div>
          </div>
          {history.length === 0 ? (
            <p className="text-muted">No stock movements yet.</p>
          ) : (
            <table className="table table-sm table-hover align-middle">
              <thead>
                <tr>
                  <th>When</th><th>Product</th><th>Type</th>
                  <th className="text-end">Change</th><th className="text-end">Balance</th>
                  <th>Reason / note</th><th>By</th>
                </tr>
              </thead>
              <tbody>
                {history.map((m) => (
                  <tr key={m.id}>
                    <td className="small text-muted">{new Date(m.createdAt).toLocaleString()}</td>
                    <td className="small">{m.productName}{m.sku ? <span className="text-muted"> · {m.sku}</span> : null}</td>
                    <td><span className="badge text-bg-secondary">{m.type}</span></td>
                    <td className={`text-end fw-semibold ${m.delta < 0 ? "text-danger" : "text-success"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                    <td className="text-end">{m.balanceAfter ?? "—"}</td>
                    <td className="small">{m.note ?? "—"}</td>
                    <td className="small text-muted">{m.actor ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : loading ? (
        <p className="text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-muted">No products match.</p>
      ) : (
        <table className="table table-hover align-middle">
          <thead>
            <tr>
              <th>Product</th><th>SKU</th><th>Category</th>
              <th className="text-end">On hand</th><th className="text-end">Reserved</th>
              <th className="text-end">Available</th><th className="text-end">Unit cost</th>
              <th className="text-end">Value</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="fw-semibold">{r.name}</td>
                <td className="small text-muted">{r.sku}</td>
                <td className="small text-muted">{r.category ?? "—"}</td>
                <td className="text-end">{r.quantityOnHand}</td>
                <td className="text-end text-muted">{r.quantityReserved}</td>
                <td className="text-end fw-semibold">{r.availableQuantity}</td>
                <td className="text-end">{toPesos(r.costMinor)}</td>
                <td className="text-end">{toPesos(r.valueMinor)}</td>
                <td><span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status}</span></td>
                <td className="text-end">
                  <button type="button" className="btn btn-sm btn-outline-primary"
                    onClick={() => { setAdjust(r); setAdjustMode("delta"); setAdjustQty(""); setAdjustReason(""); setAdjustAllowNegative(false); setAdjustError(null); }}>
                    <i className="bi bi-sliders me-1"></i>Adjust
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* M2: the 5-step adjustment — product → current stock → delta/count + reason → confirm */}
      {adjust && (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="adjustModalTitle">
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title" id="adjustModalTitle"><i className="bi bi-sliders me-1"></i>Adjust {adjust.name}</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setAdjust(null)}></button>
                </div>
                <div className="modal-body">
                  <p className="small mb-2">
                    Current stock: <strong>{adjust.quantityOnHand}</strong> on hand · {adjust.quantityReserved} reserved · {adjust.availableQuantity} available
                  </p>
                  <div className="btn-group btn-group-sm w-100 mb-2" role="group" aria-label="Adjustment mode">
                    <button type="button" className={`btn ${adjustMode === "delta" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setAdjustMode("delta")}>
                      Add / remove
                    </button>
                    <button type="button" className={`btn ${adjustMode === "setTo" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setAdjustMode("setTo")}>
                      Counted total
                    </button>
                  </div>
                  <label className="form-label small mb-1" htmlFor="adjustQty">
                    {adjustMode === "delta" ? "Change (+ to add, − to remove)" : "Counted quantity on the shelf"}
                  </label>
                  <input id="adjustQty" className="form-control form-control-sm mb-2" type="number" step="1" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} placeholder={adjustMode === "delta" ? "e.g. 5 or -2" : "e.g. 37"} />
                  <label className="form-label small mb-1" htmlFor="adjustReason">Reason (stored on the ledger row)</label>
                  <input id="adjustReason" className="form-control form-control-sm mb-2" type="text" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="e.g. Delivery received / spillage / stock-take" />
                  <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" id="adjustAllowNegative" checked={adjustAllowNegative} onChange={(e) => setAdjustAllowNegative(e.target.checked)} />
                    <label className="form-check-label small" htmlFor="adjustAllowNegative">
                      Allow a negative balance (stock-take correction — recorded, never hidden)
                    </label>
                  </div>
                  {adjustMode === "delta" && adjustQty !== "" && Number.isFinite(Number.parseInt(adjustQty, 10)) && (
                    <div className="small text-muted mt-2">
                      New on hand: <strong>{adjust.quantityOnHand + Number.parseInt(adjustQty, 10)}</strong>
                    </div>
                  )}
                  {adjustError && <div className="alert alert-danger py-1 px-2 small mt-2 mb-0">{adjustError}</div>}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setAdjust(null)}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={adjustBusy} onClick={() => void submitAdjust()}>
                    {adjustBusy ? "Saving…" : "Save adjustment"}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
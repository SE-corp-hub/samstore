"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface InvItem {
  id: string; name: string; sku: string; category: string | null;
  quantityOnHand: number; quantityReserved: number; availableQuantity: number;
  reorderThreshold: number; costMinor: number; valueMinor: number; status: "in" | "low" | "out";
  stockBaseUnit: string | null; stockBaseQuantity: number | null;
  stockConversionFamily: string | null;
  stockLevels: { warehouseId: string | null; quantityOnHand: number; quantityReserved: number }[];
  variants: { id: string; name: string; sku: string; costMinor: number; stockBaseQuantity: number | null; quantityOnHand: number; quantityReserved: number; availableQuantity: number; isActive: boolean }[];
}
interface Warehouse { id: string; name: string; isDefault: boolean }
interface Category { id: string; name: string }
interface ConversionOption {
  key: string;
  productId: string;
  variantId?: string;
  label: string;
  sku: string;
  baseUnit: string;
  baseQuantity: number;
  conversionFamily: string;
  available: number;
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const formatBaseQty = (qty: number, unit: string) => {
  if ((unit === "g" || unit === "ml") && qty % 1000 === 0) return `${qty / 1000} ${unit === "g" ? "kg" : "L"}`;
  return `${qty} ${unit}`;
};
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
    id: string; productName: string; sku: string | null; variantName?: string | null; variantSku?: string | null; delta: number; type: string;
    note: string | null; balanceAfter: number | null; actor: string | null; createdAt: string; conversionId?: string | null;
  }[]>([]);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [conversionItems, setConversionItems] = useState<InvItem[]>([]);
  const [conversionWarehouses, setConversionWarehouses] = useState<Warehouse[]>([]);
  const [conversionWarehouseId, setConversionWarehouseId] = useState("__none__");
  const [sourceKey, setSourceKey] = useState("");
  const [destinationKey, setDestinationKey] = useState("");
  const [sourceQuantity, setSourceQuantity] = useState("1");
  const [outputQuantity, setOutputQuantity] = useState("");
  const [conversionReason, setConversionReason] = useState("");
  const [wasteReason, setWasteReason] = useState("");
  const [conversionIdempotencyKey, setConversionIdempotencyKey] = useState<string | null>(null);
  const [conversionBusy, setConversionBusy] = useState(false);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [conversionMessage, setConversionMessage] = useState<string | null>(null);

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

  const openConversion = async () => {
    setConversionError(null);
    setConversionMessage(null);
    try {
      const res = await fetch(`${API_URL}/admin/inventory`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Could not load conversion stock items");
      const data = await res.json();
      const allWarehouses = (data.warehouses ?? []) as Warehouse[];
      setConversionItems((data.items ?? []) as InvItem[]);
      setConversionWarehouses(allWarehouses);
      setConversionWarehouseId(warehouseId || allWarehouses.find((w) => w.isDefault)?.id || allWarehouses[0]?.id || "__none__");
      setSourceKey("");
      setDestinationKey("");
      setSourceQuantity("1");
      setOutputQuantity("");
      setConversionReason("");
      setWasteReason("");
      setConversionIdempotencyKey(null);
      setConversionOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load conversion stock items");
    }
  };

  const conversionOptions: ConversionOption[] = conversionItems.flatMap((item) => {
    const productLevel = conversionWarehouseId === "__none__"
      ? item.stockLevels.find((level) => level.warehouseId === null)
      : item.stockLevels.find((level) => level.warehouseId === conversionWarehouseId);
    const options: ConversionOption[] = [];
    if (item.stockBaseUnit && item.stockBaseQuantity && item.stockConversionFamily) {
      options.push({
        key: `product:${item.id}`,
        productId: item.id,
        label: item.name,
        sku: item.sku,
        baseUnit: item.stockBaseUnit,
        baseQuantity: item.stockBaseQuantity,
        conversionFamily: item.stockConversionFamily,
        available: (productLevel?.quantityOnHand ?? 0) - (productLevel?.quantityReserved ?? 0),
      });
    }
    for (const variant of item.variants ?? []) {
      const baseQuantity = variant.stockBaseQuantity ?? item.stockBaseQuantity;
      if (!item.stockBaseUnit || !item.stockConversionFamily || !baseQuantity || !variant.isActive) continue;
      options.push({
        key: `variant:${variant.id}`,
        productId: item.id,
        variantId: variant.id,
        label: `${item.name} — ${variant.name}`,
        sku: variant.sku,
        baseUnit: item.stockBaseUnit,
        baseQuantity,
        conversionFamily: item.stockConversionFamily,
        available: variant.availableQuantity,
      });
    }
    return options;
  });

  const sourceOption = conversionOptions.find((item) => item.key === sourceKey);
  const destinationOption = conversionOptions.find((item) => item.key === destinationKey);
  const sourceQtyNumber = Number.parseInt(sourceQuantity, 10);
  const outputQtyNumber = Number.parseInt(outputQuantity, 10);
  const maxOutputQuantity = sourceOption && destinationOption
    && sourceOption.baseUnit === destinationOption.baseUnit
    && Number.isInteger(sourceQtyNumber) && sourceQtyNumber > 0
    ? Math.floor((sourceQtyNumber * sourceOption.baseQuantity) / destinationOption.baseQuantity)
    : 0;
  const wasteBaseQuantity = sourceOption && destinationOption
    && Number.isInteger(sourceQtyNumber) && sourceQtyNumber > 0
    && Number.isInteger(outputQtyNumber) && outputQtyNumber > 0
    ? sourceQtyNumber * sourceOption.baseQuantity - outputQtyNumber * destinationOption.baseQuantity
    : 0;

  const submitConversion = async () => {
    if (!sourceOption || !destinationOption) { setConversionError("Choose both a source and an output item"); return; }
    if (sourceKey === destinationKey) { setConversionError("Source and output must be different stock items"); return; }
    if (!Number.isInteger(sourceQtyNumber) || sourceQtyNumber < 1 || sourceQtyNumber > sourceOption.available) {
      setConversionError(`Enter a source quantity from 1 to ${sourceOption.available} available`); return;
    }
    if (!Number.isInteger(outputQtyNumber) || outputQtyNumber < 1 || outputQtyNumber > maxOutputQuantity) {
      setConversionError(`Output quantity must be 1–${maxOutputQuantity} based on the pack contents`); return;
    }
    if (conversionReason.trim().length < 3) { setConversionError("A conversion reason is required (3+ characters)"); return; }
    if (wasteBaseQuantity > 0 && wasteReason.trim().length < 3) { setConversionError("Explain the leftover/waste (3+ characters)"); return; }

    setConversionBusy(true);
    setConversionError(null);
    const idempotencyKey = conversionIdempotencyKey ?? (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `convert-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setConversionIdempotencyKey(idempotencyKey);
    try {
      const res = await fetch(`${API_URL}/admin/stock/conversions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          idempotencyKey,
          sourceProductId: sourceOption.productId,
          sourceVariantId: sourceOption.variantId,
          destinationProductId: destinationOption.productId,
          destinationVariantId: destinationOption.variantId,
          warehouseId: conversionWarehouseId === "__none__" ? undefined : conversionWarehouseId,
          sourceQuantity: sourceQtyNumber,
          outputQuantity: outputQtyNumber,
          reason: conversionReason.trim(),
          wasteReason: wasteBaseQuantity > 0 ? wasteReason.trim() : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setConversionError(data?.message ?? (Array.isArray(data?.errors) ? data.errors.join("; ") : "Conversion failed"));
        return;
      }
      setConversionMessage(`Converted ${sourceQtyNumber} ${sourceOption.label} into ${outputQtyNumber} ${destinationOption.label}${wasteBaseQuantity > 0 ? ` · ${formatBaseQty(wasteBaseQuantity, sourceOption.baseUnit)} recorded as waste` : ""}.`);
      setConversionOpen(false);
      await load();
      if (view === "history") await loadHistory();
    } catch (e) {
      setConversionError(e instanceof Error ? e.message : "Conversion failed");
    } finally {
      setConversionBusy(false);
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
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-sm btn-outline-success" onClick={() => void openConversion()}>
            <i className="bi bi-arrow-left-right me-1"></i>Convert stock
          </button>
          <div className="btn-group btn-group-sm" role="group" aria-label="Inventory view">
            <button type="button" className={`btn ${view === "stock" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setView("stock")}>
              <i className="bi bi-boxes me-1"></i>Stock
            </button>
            <button type="button" className={`btn ${view === "history" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setView("history")}>
              <i className="bi bi-clock-history me-1"></i>Stock flow
            </button>
          </div>
        </div>
      </div>
      {conversionMessage && <div className="alert alert-success py-2 small">{conversionMessage}</div>}

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
                    <td className="small">{m.productName}{m.variantName ? ` — ${m.variantName}` : ""}{(m.variantSku ?? m.sku) ? <span className="text-muted"> · {m.variantSku ?? m.sku}</span> : null}</td>
                    <td>
                      <span className="badge text-bg-secondary">{m.type}</span>
                      {m.conversionId && <small className="d-block text-muted" title={m.conversionId}>Conv. {m.conversionId.slice(0, 8)}</small>}
                    </td>
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
                <td><span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status}{r.reorderThreshold > 0 ? ` ≤${r.reorderThreshold}` : ""}</span></td>
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

      {conversionOpen && (
        <>
          <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="conversionModalTitle">
            <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title" id="conversionModalTitle"><i className="bi bi-arrow-left-right me-1"></i>Convert stock</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={() => setConversionOpen(false)}></button>
                </div>
                <div className="modal-body">
                  <p className="small text-muted">Convert available stock between products or variants. The system calculates the maximum output from each item's configured pack contents; reserved stock cannot be converted.</p>
                  {conversionError && <div className="alert alert-danger py-2 small">{conversionError}</div>}
                  {conversionOptions.length === 0 ? (
                    <div className="alert alert-warning small">No stock items have conversion unit and contents configured. Set these in Products first.</div>
                  ) : (
                    <>
                      <div className="mb-3">
                        <label className="form-label small" htmlFor="conversionWarehouse">Warehouse</label>
                        <select id="conversionWarehouse" className="form-select form-select-sm" value={conversionWarehouseId} onChange={(e) => { setConversionWarehouseId(e.target.value); setConversionIdempotencyKey(null); }}>
                          {conversionWarehouses.length === 0 && <option value="__none__">No warehouse</option>}
                          {conversionWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.isDefault ? " (default)" : ""}</option>)}
                          <option value="__none__">Warehouse-less stock</option>
                        </select>
                      </div>
                      <div className="row g-2">
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionSource">Convert from</label>
                          <select id="conversionSource" className="form-select" value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setOutputQuantity(""); setConversionIdempotencyKey(null); }}>
                            <option value="">Select source item…</option>
                            {conversionOptions.map((item) => <option key={item.key} value={item.key}>{item.label} · {item.sku} · {formatBaseQty(item.baseQuantity, item.baseUnit)} · {item.available} available</option>)}
                          </select>
                          {sourceOption && <small className="text-muted">Available here: {sourceOption.available}</small>}
                        </div>
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionDestination">Convert into</label>
                          <select id="conversionDestination" className="form-select" value={destinationKey} onChange={(e) => { setDestinationKey(e.target.value); setOutputQuantity(""); setConversionIdempotencyKey(null); }}>
                            <option value="">Select output item…</option>
                            {conversionOptions.filter((item) => item.key !== sourceKey && (!sourceOption || (item.baseUnit === sourceOption.baseUnit && item.conversionFamily === sourceOption.conversionFamily))).map((item) => <option key={item.key} value={item.key}>{item.label} · {item.sku} · {formatBaseQty(item.baseQuantity, item.baseUnit)}</option>)}
                          </select>
                          {destinationOption && <small className="text-muted">Current stock here: {destinationOption.available}</small>}
                        </div>
                      </div>
                      <div className="row g-2 mt-1">
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionSourceQty">Source quantity</label>
                          <input id="conversionSourceQty" className="form-control" type="number" min="1" max={sourceOption?.available ?? 1} step="1" value={sourceQuantity} onChange={(e) => { setSourceQuantity(e.target.value); setConversionIdempotencyKey(null); }} />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label small" htmlFor="conversionOutputQty">Actual output quantity</label>
                          <input id="conversionOutputQty" className="form-control" type="number" min="1" max={maxOutputQuantity || undefined} step="1" value={outputQuantity} onChange={(e) => { setOutputQuantity(e.target.value); setConversionIdempotencyKey(null); }} />
                          <small className="text-muted">Maximum possible: {maxOutputQuantity} unit(s)</small>
                        </div>
                      </div>
                      {wasteBaseQuantity > 0 && sourceOption && <div className="alert alert-warning py-2 small mt-2 mb-2">Remainder recorded as waste: {formatBaseQty(wasteBaseQuantity, sourceOption.baseUnit)}.</div>}
                      <div className="mt-2">
                        <label className="form-label small" htmlFor="conversionReason">Conversion reason</label>
                        <input id="conversionReason" className="form-control" maxLength={200} value={conversionReason} onChange={(e) => { setConversionReason(e.target.value); setConversionIdempotencyKey(null); }} placeholder="e.g. Repacked rice for retail sale" />
                      </div>
                      {wasteBaseQuantity > 0 && (
                        <div className="mt-2">
                          <label className="form-label small" htmlFor="conversionWasteReason">Waste/loss reason *</label>
                          <input id="conversionWasteReason" className="form-control" required maxLength={200} value={wasteReason} onChange={(e) => { setWasteReason(e.target.value); setConversionIdempotencyKey(null); }} placeholder="e.g. Spillage during repacking" />
                        </div>
                      )}
                      <div className="small text-muted mt-2">Both stock movements and the conversion audit record are saved together. The remaining material is recorded as waste when actual output is below the maximum.</div>
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConversionOpen(false)}>Cancel</button>
                  <button type="button" className="btn btn-success" disabled={conversionBusy || conversionOptions.length === 0} onClick={() => void submitConversion()}>
                    {conversionBusy ? "Converting…" : "Confirm conversion"}
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

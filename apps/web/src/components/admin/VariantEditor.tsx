"use client";

// P2c: manage a product's variants + add-on groups from the admin Products panel.
// All writes go through the tenant-scoped /admin/products/* endpoints.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

export interface AdminVariant { id: string; name: string; sku: string; priceMinor: number; costMinor: number; stockBaseQuantity: number | null; quantityOnHand: number; availableQuantity: number; isActive: boolean }
export interface AdminAddonOption { id: string; name: string; priceMinor: number; isActive: boolean }
export interface AdminAddon { id: string; name: string; required: boolean; options: AdminAddonOption[] }
export interface VariantEditableProduct {
  id: string;
  name: string;
  stockBaseUnit: string | null;
  stockBaseQuantity: number | null;
  variants: AdminVariant[];
  addons: AdminAddon[];
}

interface VariantEditorProps {
  product: VariantEditableProduct;
  onClose: () => void;
  onChanged: () => void;
}

export default function VariantEditor({ product, onClose, onChanged }: VariantEditorProps) {
  const variants = product.variants;
  const addons = product.addons;
  const [vForm, setVForm] = useState({ name: "", sku: "", price: "", cost: "", stock: "", stockBaseQuantity: "" });
  const [aForm, setAForm] = useState({ name: "", optionName: "", optionPrice: "" });
  // P3e: per-group "add an option" forms.
  const [addOpt, setAddOpt] = useState<Record<string, { name: string; price: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const api = (path: string, method = "POST", body?: unknown) =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: { ...adminHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  const fail = (res: Response, d: { errors?: string[]; message?: string }) =>
    `(${res.status}) ${d?.errors?.join(", ") ?? d?.message ?? "failed"}`;

  const addVariant = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await api(`/admin/products/${product.id}/variants`, "POST", {
        name: vForm.name.trim(), sku: vForm.sku.trim(),
        priceMinor: Math.round(parseFloat(vForm.price || "0") * 100),
        costMinor: Math.round(parseFloat(vForm.cost || "0") * 100),
        ...(vForm.stockBaseQuantity ? { stockBaseQuantity: parseInt(vForm.stockBaseQuantity, 10) } : {}),
        quantityOnHand: vForm.stock ? parseInt(vForm.stock, 10) : 0,
      });
      if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
      setVForm({ name: "", sku: "", price: "", cost: "", stock: "", stockBaseQuantity: "" });
      onChanged();
      close();
    } finally { setBusy(false); }
  };

  const saveVar = async (id: string, patch: Partial<AdminVariant>) => {
    const res = await api(`/admin/products/variants/${id}`, "PATCH", patch);
    if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
    onChanged();
    close();
  };

  const delVar = async (id: string) => {
    const res = await api(`/admin/products/variants/${id}`, "DELETE");
    if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
    onChanged();
    close();
  };

  const addGroup = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await api(`/admin/products/${product.id}/addons`, "POST", {
        name: aForm.name.trim(),
        options: aForm.optionName.trim() ? [{ name: aForm.optionName.trim(), priceMinor: Math.round(parseFloat(aForm.optionPrice || "0") * 100) }] : [],
      });
      if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
      setAForm({ name: "", optionName: "", optionPrice: "" });
      onChanged();
      close();
    } finally { setBusy(false); }
  };

  const delGroup = async (id: string) => {
    const res = await api(`/admin/products/addons/${id}`, "DELETE");
    if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
    onChanged();
    close();
  };

  const delOption = async (id: string) => {
    const res = await api(`/admin/products/addons/options/${id}`, "DELETE");
    if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
    onChanged();
    close();
  };

  const setPrice = async (id: string, priceMinor: number) => saveVar(id, { priceMinor });
  const setStock = async (id: string, quantityOnHand: number) => saveVar(id, { quantityOnHand });
  // P3e: rename variant + active toggle.
  const renameVar = async (id: string, name: string) => saveVar(id, { name });
  const toggleVar = async (id: string, isActive: boolean) => saveVar(id, { isActive });

  // P3e: add-on group edit (name / required).
  const saveGroup = async (id: string, patch: Partial<AdminAddon>) => {
    const res = await api(`/admin/products/addons/${id}`, "PATCH", patch);
    if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
    onChanged();
    close();
  };

  // P3e: add an option to an existing group.
  const addOptionToGroup = async (groupId: string) => {
    setBusy(true); setErr(null);
    try {
      const f = addOpt[groupId] ?? { name: "", price: "" };
      const res = await api(`/admin/products/addons/${groupId}/options`, "POST", {
        name: f.name.trim(), priceMinor: Math.round(parseFloat(f.price || "0") * 100),
      });
      if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
      onChanged();
      close();
    } finally { setBusy(false); }
  };

  // P3e: edit an option's name/price inline.
  const saveOption = async (id: string, patch: Partial<AdminAddonOption>) => {
    const res = await api(`/admin/products/addons/options/${id}`, "PATCH", patch);
    if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
    onChanged();
    close();
  };

  // Deliberately a "reload to continue" flow: after any write the panel refetches and
  // this modal closes, keeping state simple and authoritative.
  const close = () => onClose();

  return (
    <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
      <div className="modal-dialog modal-dialog-scrollable modal-lg">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Variants &amp; Add-ons — {product.name}</h5>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close"></button>
          </div>
          <div className="modal-body">
            {err && <div className="alert alert-danger py-2 small">{err}</div>}

            <h6 className="small fw-bold">Variants (own price + stock)</h6>
            {variants.length === 0 && <p className="text-muted small">No variants — this product sells as-is.</p>}
            <ul className="list-group list-group-flush mb-2">
              {variants.map((v) => (
                <li key={v.id} className="list-group-item px-2 py-1 d-flex align-items-center gap-2 small">
                  <input type="text" className="form-control form-control-sm" style={{ width: 104 }} defaultValue={v.name} title="name"
                    onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== v.name) renameVar(v.id, n); }} />
                  <span className="text-muted flex-fill text-truncate">{v.sku}</span>
                  <input type="number" className="form-control form-control-sm" style={{ width: 84 }} min={0} step={0.01}
                    defaultValue={(v.priceMinor / 100).toFixed(2)} title="price (pesos)" onBlur={(e) => setPrice(v.id, Math.round(parseFloat(e.target.value || "0") * 100))} />
                  <input type="number" className="form-control form-control-sm" style={{ width: 84 }} min={0} step={0.01}
                    defaultValue={(v.costMinor / 100).toFixed(2)} title="unit acquisition cost (pesos)" onBlur={(e) => saveVar(v.id, { costMinor: Math.round(parseFloat(e.target.value || "0") * 100) })} />
                  <input type="number" className="form-control form-control-sm" style={{ width: 76 }} min={0}
                    defaultValue={v.quantityOnHand} title="on hand" onBlur={(e) => setStock(v.id, parseInt(e.target.value, 10) || 0)} />
                  {product.stockBaseUnit && <input type="number" className="form-control form-control-sm" style={{ width: 84 }} min={1} step={1}
                    defaultValue={v.stockBaseQuantity ?? ""} title={`contents (${product.stockBaseUnit})`} placeholder={product.stockBaseUnit}
                    onBlur={(e) => saveVar(v.id, { stockBaseQuantity: e.target.value ? parseInt(e.target.value, 10) : null })} />}
                  <div className="form-check form-switch" title={v.isActive ? "active" : "inactive"}>
                    <input className="form-check-input" type="checkbox" id={`vact-${v.id}`} defaultChecked={v.isActive} onChange={(e) => toggleVar(v.id, e.target.checked)} />
                    <label className="form-check-label small" htmlFor={`vact-${v.id}`}></label>
                  </div>
                  <button className="btn btn-sm btn-outline-danger py-0" onClick={() => delVar(v.id)} title="Delete variant"><i className="bi bi-x"></i></button>
                </li>
              ))}
            </ul>
            <div className="row g-1 mb-3">
              <div className="col"><input className="form-control form-control-sm" placeholder="Variant name (e.g. Large)" value={vForm.name} onChange={(e) => setVForm({ ...vForm, name: e.target.value })} /></div>
              <div className="col"><input className="form-control form-control-sm" placeholder="SKU" value={vForm.sku} onChange={(e) => setVForm({ ...vForm, sku: e.target.value })} /></div>
              <div className="col-2"><input className="form-control form-control-sm" type="number" min={0} step={0.01} placeholder="Sale ₱" value={vForm.price} onChange={(e) => setVForm({ ...vForm, price: e.target.value })} /></div>
              <div className="col-2"><input className="form-control form-control-sm" type="number" min={0} step={0.01} placeholder="Cost ₱" value={vForm.cost} onChange={(e) => setVForm({ ...vForm, cost: e.target.value })} /></div>
              <div className="col-1"><input className="form-control form-control-sm" type="number" min={0} placeholder="Qty" value={vForm.stock} onChange={(e) => setVForm({ ...vForm, stock: e.target.value })} /></div>
              {product.stockBaseUnit && <div className="col-2"><input className="form-control form-control-sm" type="number" min={1} step={1} placeholder={`Size (${product.stockBaseUnit})`} value={vForm.stockBaseQuantity} onChange={(e) => setVForm({ ...vForm, stockBaseQuantity: e.target.value })} /></div>}
              <div className="col-auto"><button className="btn btn-primary btn-sm" disabled={busy || !vForm.name.trim() || !vForm.sku.trim()} onClick={addVariant}>Add variant</button></div>
            </div>

            <h6 className="small fw-bold">Add-on groups / modifiers</h6>
            {addons.length === 0 && <p className="text-muted small">No add-on groups.</p>}
            <ul className="list-group list-group-flush mb-2">
              {addons.map((g) => (
                <li key={g.id} className="list-group-item px-2 py-1 small">
                  <div className="d-flex justify-content-between align-items-center gap-2">
                    <div className="d-flex align-items-center gap-2">
                      <input type="text" className="form-control form-control-sm" style={{ width: 140 }} defaultValue={g.name} title="group name"
                        onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== g.name) saveGroup(g.id, { name: n }); }} />
                      <div className="form-check form-switch" title="required at checkout">
                        <input className="form-check-input" type="checkbox" id={`greq-${g.id}`} defaultChecked={g.required} onChange={(e) => saveGroup(g.id, { required: e.target.checked })} />
                        <label className="form-check-label small" htmlFor={`greq-${g.id}`}>required</label>
                      </div>
                    </div>
                    <button className="btn btn-sm btn-outline-danger py-0" onClick={() => delGroup(g.id)} title="Delete group"><i className="bi bi-trash"></i></button>
                  </div>
                  <div className="d-flex flex-wrap gap-1 mt-1">
                    {g.options.map((o) => (
                      <span key={o.id} className="badge text-bg-light border d-inline-flex align-items-center gap-1">
                        <input type="text" className="form-control form-control-sm border-0" style={{ width: 90 }} defaultValue={o.name} title="option name"
                          onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== o.name) saveOption(o.id, { name: n }); }} />
                        <input type="number" className="form-control form-control-sm border-0" style={{ width: 72 }} min={0} step={0.01} defaultValue={(o.priceMinor / 100).toFixed(2)} title="price (pesos)"
                          onBlur={(e) => saveOption(o.id, { priceMinor: Math.round(parseFloat(e.target.value || "0") * 100) })} />
                        <button className="btn-close ms-1" style={{ fontSize: "0.5em" }} onClick={() => delOption(o.id)} aria-label={`Delete ${o.name}`}></button>
                      </span>
                    ))}
                    {g.options.length === 0 && <span className="text-muted">no options</span>}
                  </div>
                  <div className="row g-1 mt-1">
                    <div className="col"><input className="form-control form-control-sm" placeholder="Option name" value={addOpt[g.id]?.name ?? ""} onChange={(e) => setAddOpt({ ...addOpt, [g.id]: { name: e.target.value, price: addOpt[g.id]?.price ?? "" } })} /></div>
                    <div className="col-2"><input className="form-control form-control-sm" type="number" min={0} step={0.01} placeholder="+₱" value={addOpt[g.id]?.price ?? ""} onChange={(e) => setAddOpt({ ...addOpt, [g.id]: { name: addOpt[g.id]?.name ?? "", price: e.target.value } })} /></div>
                    <div className="col-auto"><button className="btn btn-outline-primary btn-sm" disabled={busy || !(addOpt[g.id]?.name ?? "").trim()} onClick={() => addOptionToGroup(g.id)}>Add option</button></div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="row g-1">
              <div className="col"><input className="form-control form-control-sm" placeholder="Group name (e.g. Extras)" value={aForm.name} onChange={(e) => setAForm({ ...aForm, name: e.target.value })} /></div>
              <div className="col"><input className="form-control form-control-sm" placeholder="First option (e.g. Extra shot)" value={aForm.optionName} onChange={(e) => setAForm({ ...aForm, optionName: e.target.value })} /></div>
              <div className="col-2"><input className="form-control form-control-sm" type="number" min={0} step={0.01} placeholder="+₱" value={aForm.optionPrice} onChange={(e) => setAForm({ ...aForm, optionPrice: e.target.value })} /></div>
              <div className="col-auto"><button className="btn btn-primary btn-sm" disabled={busy || !aForm.name.trim()} onClick={addGroup}>Add group</button></div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-outline-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

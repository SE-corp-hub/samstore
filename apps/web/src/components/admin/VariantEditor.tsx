"use client";

// P2c: manage a product's variants + add-on groups from the admin Products panel.
// All writes go through the tenant-scoped /admin/products/* endpoints.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

export interface AdminVariant { id: string; name: string; sku: string; priceMinor: number; quantityOnHand: number; availableQuantity: number; isActive: boolean }
export interface AdminAddonOption { id: string; name: string; priceMinor: number; isActive: boolean }
export interface AdminAddon { id: string; name: string; required: boolean; options: AdminAddonOption[] }
export interface VariantEditableProduct {
  id: string;
  name: string;
  variants: AdminVariant[];
  addons: AdminAddon[];
}

interface VariantEditorProps {
  product: VariantEditableProduct;
  onClose: () => void;
  onChanged: () => void;
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

export default function VariantEditor({ product, onClose, onChanged }: VariantEditorProps) {
  const [variants, setVariants] = useState<AdminVariant[]>(product.variants);
  const [addons, setAddons] = useState<AdminAddon[]>(product.addons);
  const [vForm, setVForm] = useState({ name: "", sku: "", price: "", stock: "" });
  const [aForm, setAForm] = useState({ name: "", optionName: "", optionPrice: "" });
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
        quantityOnHand: vForm.stock ? parseInt(vForm.stock, 10) : 0,
      });
      if (!res.ok) { const d = await res.json().catch(() => null); setErr(fail(res, d)); return; }
      setVForm({ name: "", sku: "", price: "", stock: "" });
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
                  <span className="fw-semibold flex-fill">{v.name}</span>
                  <span className="text-muted">{v.sku}</span>
                  <input type="number" className="form-control form-control-sm" style={{ width: 84 }} min={0} step={0.01}
                    defaultValue={(v.priceMinor / 100).toFixed(2)} title="price (pesos)" onBlur={(e) => setPrice(v.id, Math.round(parseFloat(e.target.value || "0") * 100))} />
                  <input type="number" className="form-control form-control-sm" style={{ width: 76 }} min={0}
                    defaultValue={v.quantityOnHand} title="on hand" onBlur={(e) => setStock(v.id, parseInt(e.target.value, 10) || 0)} />
                  <span className="text-muted">{toPesos(v.priceMinor)}</span>
                  <button className="btn btn-sm btn-outline-danger py-0" onClick={() => delVar(v.id)} title="Delete variant"><i className="bi bi-x"></i></button>
                </li>
              ))}
            </ul>
            <div className="row g-1 mb-3">
              <div className="col"><input className="form-control form-control-sm" placeholder="Variant name (e.g. Large)" value={vForm.name} onChange={(e) => setVForm({ ...vForm, name: e.target.value })} /></div>
              <div className="col"><input className="form-control form-control-sm" placeholder="SKU" value={vForm.sku} onChange={(e) => setVForm({ ...vForm, sku: e.target.value })} /></div>
              <div className="col-2"><input className="form-control form-control-sm" type="number" min={0} step={0.01} placeholder="Price" value={vForm.price} onChange={(e) => setVForm({ ...vForm, price: e.target.value })} /></div>
              <div className="col-2"><input className="form-control form-control-sm" type="number" min={0} placeholder="Qty" value={vForm.stock} onChange={(e) => setVForm({ ...vForm, stock: e.target.value })} /></div>
              <div className="col-auto"><button className="btn btn-primary btn-sm" disabled={busy || !vForm.name.trim() || !vForm.sku.trim()} onClick={addVariant}>Add variant</button></div>
            </div>

            <h6 className="small fw-bold">Add-on groups / modifiers</h6>
            {addons.length === 0 && <p className="text-muted small">No add-on groups.</p>}
            <ul className="list-group list-group-flush mb-2">
              {addons.map((g) => (
                <li key={g.id} className="list-group-item px-2 py-1 small">
                  <div className="d-flex justify-content-between align-items-center">
                    <span className="fw-semibold">{g.name}{g.required ? " *" : ""}</span>
                    <span>
                      <button className="btn btn-sm btn-outline-danger py-0 me-1" onClick={() => delGroup(g.id)} title="Delete group"><i className="bi bi-trash"></i></button>
                    </span>
                  </div>
                  <div className="d-flex flex-wrap gap-1 mt-1">
                    {g.options.map((o) => (
                      <span key={o.id} className="badge text-bg-light border d-inline-flex align-items-center gap-1">
                        {o.name} +{toPesos(o.priceMinor)}
                        <button className="btn-close ms-1" style={{ fontSize: "0.5em" }} onClick={() => delOption(o.id)} aria-label={`Delete ${o.name}`}></button>
                      </span>
                    ))}
                    {g.options.length === 0 && <span className="text-muted">no options</span>}
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
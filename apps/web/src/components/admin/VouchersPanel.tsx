"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { peso } from "../../lib/number-format";

interface Voucher {
  id: string;
  code: string;
  description: string | null;
  discountMinor: number;
  type: string;
  percentBp: number | null;
  minOrderMinor: number;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
  firstOrderOnly: boolean;
  scopeType: string;
  scopeRefId: string | null;
  stackable: boolean;
  isActive: boolean;
  redemptionCount: number;
}

const toPesos = (m: number) => peso(m);

export default function VouchersPanel() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    code: "",
    type: "fixed" as "fixed" | "percent" | "free_delivery",
    discountPesos: "",
    percent: "",
    maxRedemptions: "",
    perCustomerLimit: "",
    firstOrderOnly: false,
    scopeType: "all" as "all" | "product" | "category",
    scopeSku: "",
    scopeCategorySlug: "",
    stackable: false,
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/vouchers`, { headers: { ...adminHeaders() } });
      if (!res.ok) throw new Error("Failed to load vouchers");
      const data = await res.json();
      setVouchers(data.vouchers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        code: form.code,
        type: form.type,
        maxRedemptions: form.maxRedemptions === "" ? null : parseInt(form.maxRedemptions, 10),
        perCustomerLimit: form.perCustomerLimit === "" ? null : parseInt(form.perCustomerLimit, 10),
        firstOrderOnly: form.firstOrderOnly,
        scopeType: form.scopeType,
        scopeSku: form.scopeSku.trim() || undefined,
        scopeCategorySlug: form.scopeCategorySlug.trim() || undefined,
        stackable: form.stackable,
      };
      if (form.type === "fixed") payload.discountMinor = Math.round(parseFloat(form.discountPesos || "0") * 100);
      if (form.type === "percent") payload.percentBp = Math.round(parseFloat(form.percent || "0") * 100);
      const res = await fetch(`${API_URL}/admin/vouchers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Create failed");
        return;
      }
      setForm({ code: "", type: "fixed", discountPesos: "", percent: "", maxRedemptions: "", perCustomerLimit: "", firstOrderOnly: false, scopeType: "all", scopeSku: "", scopeCategorySlug: "", stackable: false });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (v: Voucher) => {
    await fetch(`${API_URL}/admin/vouchers/${v.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ isActive: !v.isActive }),
    });
    await load();
  };

  const scopeLabel = (v: Voucher) =>
    v.scopeType === "all" ? "All items" : v.scopeType === "product" ? `Product ${v.scopeRefId?.slice(-6) ?? ""}` : `Category ${v.scopeRefId?.slice(-6) ?? ""}`;

  return (
    <div>
      <h1 className="h4 mb-3">Vouchers</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <form onSubmit={create} className="card mb-4">
        <div className="card-body">
          <h6 className="card-title">Create voucher</h6>
          <div className="row g-2">
            <div className="col-md-2">
              <input className="form-control form-control-sm" placeholder="CODE (e.g. PINDIAN10)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
            </div>
            <div className="col-md-2">
              <select className="form-select form-select-sm" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as typeof form.type })}>
                <option value="fixed">Fixed (₱ off)</option>
                <option value="percent">Percent (%)</option>
                <option value="free_delivery">Free delivery</option>
              </select>
            </div>
            {form.type === "fixed" ? (
              <div className="col-md-2">
                <input className="form-control form-control-sm" type="number" step="0.01" min="0" placeholder="Discount (₱)" value={form.discountPesos} onChange={(e) => setForm({ ...form, discountPesos: e.target.value })} />
              </div>
            ) : form.type === "percent" ? (
              <div className="col-md-2">
                <input className="form-control form-control-sm" type="number" step="0.1" min="0.1" max="100" placeholder="% off" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} />
              </div>
            ) : (
              <div className="col-md-2"><input className="form-control form-control-sm" disabled placeholder="No amount — fee waived" /></div>
            )}
            <div className="col-md-2">
              <input className="form-control form-control-sm" type="number" min="1" placeholder="Max uses (∞)" value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} />
            </div>
            <div className="col-md-2">
              <input className="form-control form-control-sm" type="number" min="1" placeholder="Per customer" value={form.perCustomerLimit} onChange={(e) => setForm({ ...form, perCustomerLimit: e.target.value })} />
            </div>
            <div className="col-md-2">
              <select className="form-select form-select-sm" value={form.scopeType} onChange={(e) => setForm({ ...form, scopeType: e.target.value as typeof form.scopeType })}>
                <option value="all">All items</option>
                <option value="product">Specific product (SKU)</option>
                <option value="category">Specific category (slug)</option>
              </select>
            </div>
            {form.scopeType === "product" && (
              <div className="col-md-2">
                <input className="form-control form-control-sm" placeholder="Product SKU" value={form.scopeSku} onChange={(e) => setForm({ ...form, scopeSku: e.target.value })} />
              </div>
            )}
            {form.scopeType === "category" && (
              <div className="col-md-2">
                <input className="form-control form-control-sm" placeholder="Category slug (e.g. drinks)" value={form.scopeCategorySlug} onChange={(e) => setForm({ ...form, scopeCategorySlug: e.target.value })} />
              </div>
            )}
          </div>
          <div className="form-check form-switch d-inline-block mt-2 me-3">
            <input className="form-check-input" type="checkbox" id="fo" checked={form.firstOrderOnly} onChange={(e) => setForm({ ...form, firstOrderOnly: e.target.checked })} />
            <label className="form-check-label small" htmlFor="fo">First order only</label>
          </div>
          <div className="form-check form-switch d-inline-block mt-2">
            <input className="form-check-input" type="checkbox" id="st" checked={form.stackable} onChange={(e) => setForm({ ...form, stackable: e.target.checked })} />
            <label className="form-check-label small" htmlFor="st">Stackable with loyalty points</label>
          </div>
          <div className="mt-2">
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving || !form.code || (form.type === "fixed" && !form.discountPesos) || (form.type === "percent" && !form.percent)}>
              {saving ? "…" : "Create"}
            </button>
          </div>
        </div>
      </form>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : vouchers.length === 0 ? (
        <p className="text-muted">No vouchers yet.</p>
      ) : (
        <table className="table table-hover align-middle">
          <thead>
            <tr>
              <th>Code</th>
              <th>Value</th>
              <th className="text-end">Used</th>
              <th>Rules</th>
              <th>Status</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {vouchers.map((v) => (
              <tr key={v.id}>
                <td className="fw-semibold">{v.code}</td>
                <td>
                  {v.type === "percent" ? `${((v.percentBp ?? 0) / 100).toFixed(1)}% off` : v.type === "free_delivery" ? "Free delivery" : toPesos(v.discountMinor)}
                </td>
                <td className="text-end">{v.redemptionCount}</td>
                <td className="small">
                  {v.maxRedemptions != null ? `${v.maxRedemptions} uses max · ` : ""}
                  {v.perCustomerLimit != null ? `${v.perCustomerLimit}/customer · ` : ""}
                  {v.firstOrderOnly ? "first order · " : ""}
                  {!v.stackable ? "no loyalty stack · " : ""}
                  {scopeLabel(v)}
                </td>
                <td>
                  <span className={`badge ${v.isActive ? "text-bg-success" : "text-bg-secondary"}`}>
                    {v.isActive ? "Active" : "Disabled"}
                  </span>
                </td>
                <td className="text-end">
                  <button className="btn btn-sm btn-outline-secondary" onClick={() => toggle(v)}>
                    <i className={`bi ${v.isActive ? "bi-pause" : "bi-play"}`}></i>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
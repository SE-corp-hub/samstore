"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { getAdminToken, adminHeaders } from "../../lib/admin";

interface Voucher {
  id: string;
  code: string;
  description: string | null;
  discountMinor: number;
  minOrderMinor: number;
  maxRedemptions: number | null;
  isActive: boolean;
  redemptionCount: number;
}

export default function VouchersPanel() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", discountPesos: "", maxRedemptions: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/vouchers`, {
        headers: { ...adminHeaders() },
      });
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
      const res = await fetch(`${API_URL}/admin/vouchers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          code: form.code,
          discountMinor: Math.round(parseFloat(form.discountPesos || "0") * 100),
          maxRedemptions: form.maxRedemptions === "" ? null : parseInt(form.maxRedemptions, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Create failed");
        return;
      }
      setForm({ code: "", discountPesos: "", maxRedemptions: "" });
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

  return (
    <div>
      <h1 className="h4 mb-3">Vouchers</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <form onSubmit={create} className="card mb-4">
        <div className="card-body">
          <h6 className="card-title">Create voucher</h6>
          <div className="row g-2">
            <div className="col-md-3">
              <input className="form-control form-control-sm" placeholder="CODE (e.g. SAM10)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
            </div>
            <div className="col-md-3">
              <input className="form-control form-control-sm" type="number" step="0.01" min="0" placeholder="Discount (₱)" value={form.discountPesos} onChange={(e) => setForm({ ...form, discountPesos: e.target.value })} />
            </div>
            <div className="col-md-3">
              <input className="form-control form-control-sm" type="number" min="1" placeholder="Max uses (blank = ∞)" value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} />
            </div>
            <div className="col-md-3">
              <button className="btn btn-primary btn-sm w-100" type="submit" disabled={saving || !form.code || !form.discountPesos}>
                {saving ? "…" : "Create"}
              </button>
            </div>
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
              <th className="text-end">Discount</th>
              <th className="text-end">Used</th>
              <th>Limit</th>
              <th>Status</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {vouchers.map((v) => (
              <tr key={v.id}>
                <td className="fw-semibold">{v.code}</td>
                <td className="text-end">₱{(v.discountMinor / 100).toFixed(2)}</td>
                <td className="text-end">{v.redemptionCount}</td>
                <td>{v.maxRedemptions ?? "∞"}</td>
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
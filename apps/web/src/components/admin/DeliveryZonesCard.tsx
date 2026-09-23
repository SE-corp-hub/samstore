"use client";

// P5a: delivery zones editor — per-city/barangay delivery fee + ETA. When zones are
// configured, checkout prices delivery from the matched zone (or rejects out-of-coverage
// addresses); with none, the legacy flat delivery fee applies.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface ZoneRow {
  id: string;
  name: string;
  cityCode: string | null;
  barangayCodes: string[];
  feeMinor: number;
  etaMinutes: number;
  isActive: boolean;
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

export default function DeliveryZonesCard() {
  const [zones, setZones] = useState<ZoneRow[] | null>(null);
  const [form, setForm] = useState({ name: "", cityCode: "", barangays: "", fee: "", eta: "45" });
  const [editId, setEditId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await fetch(`${API_URL}/admin/delivery-zones`, { headers: adminHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.errors?.join(", ") ?? d?.message ?? `Loading zones failed (${r.status})`);
      setZones(d?.zones ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't load delivery zones");
    }
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: form.name.trim(),
        cityCode: form.cityCode.trim() || null,
        barangayCodes: form.barangays.split(",").map((c) => c.trim()).filter((c) => c.length > 0),
        feeMinor: Math.round(parseFloat(form.fee || "0") * 100),
        etaMinutes: parseInt(form.eta || "45", 10),
      };
      const res = await fetch(
        `${API_URL}/admin/delivery-zones${editId ? `/${editId}` : ""}`,
        { method: editId ? "PATCH" : "POST", headers: { ...adminHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      const d = await res.json();
      if (!res.ok) { setErr(d?.errors?.join(", ") ?? d?.message ?? `Save failed (${res.status})`); return; }
      setForm({ name: "", cityCode: "", barangays: "", fee: "", eta: "45" });
      setEditId(null);
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${API_URL}/admin/delivery-zones/${id}`, { method: "DELETE", headers: adminHeaders() });
      if (!res.ok) { const d = await res.json().catch(() => null); setErr(d?.message ?? "Delete failed"); return; }
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const edit = (z: ZoneRow) => {
    setEditId(z.id);
    setForm({ name: z.name, cityCode: z.cityCode ?? "", barangays: z.barangayCodes.join(", "), fee: (z.feeMinor / 100).toFixed(2), eta: z.etaMinutes.toString() });
  };

  return (
    <div className="card mb-4">
      <div className="card-body">
        <h6 className="card-title small fw-bold">Delivery zones</h6>
        {err && <div className="alert alert-danger py-2 small">{err}</div>}
        {zones === null ? (
          <p className="text-muted small">Loading…</p>
        ) : (
          <>
            <table className="table table-sm align-middle mb-2">
              <thead>
                <tr><th>Name</th><th>City code</th><th>Barangays</th><th className="text-end">Fee</th><th className="text-end">ETA</th><th></th></tr>
              </thead>
              <tbody>
                {zones.length === 0 && (
                  <tr><td colSpan={6} className="text-muted small">No zones — the flat delivery fee applies everywhere.</td></tr>
                )}
                {zones.map((z) => (
                  <tr key={z.id}>
                    <td className="fw-semibold">{z.name}</td>
                    <td className="small text-muted">{z.cityCode ?? "catch-all"}</td>
                    <td className="small text-muted">{z.barangayCodes.length === 0 ? "whole city" : `${z.barangayCodes.length} barangays`}</td>
                    <td className="text-end">{toPesos(z.feeMinor)}</td>
                    <td className="text-end">{z.etaMinutes} min</td>
                    <td className="text-end">
                      <button className="btn btn-sm btn-outline-secondary py-0 me-1" onClick={() => edit(z)} title="Edit"><i className="bi bi-pencil"></i></button>
                      <button className="btn btn-sm btn-outline-danger py-0" onClick={() => void del(z.id)} title="Delete"><i className="bi bi-trash"></i></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row g-1">
              <div className="col"><input className="form-control form-control-sm" placeholder="Zone name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="col"><input className="form-control form-control-sm" placeholder="City code (PSGC)" value={form.cityCode} onChange={(e) => setForm({ ...form, cityCode: e.target.value })} /></div>
              <div className="col"><input className="form-control form-control-sm" placeholder="Barangay codes, comma-sep (empty = whole city)" value={form.barangays} onChange={(e) => setForm({ ...form, barangays: e.target.value })} /></div>
              <div className="col-2"><input className="form-control form-control-sm" type="number" min="0" step="0.01" placeholder="Fee ₱" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></div>
              <div className="col-1"><input className="form-control form-control-sm" type="number" min="1" placeholder="ETA min" value={form.eta} onChange={(e) => setForm({ ...form, eta: e.target.value })} /></div>
              <div className="col-auto">
                <button className="btn btn-primary btn-sm" disabled={busy || !form.name.trim()} onClick={save}>
                  {busy ? "…" : editId ? "Save" : "Add zone"}
                </button>
              </div>
            </div>
            <small className="text-muted d-block">Blank city code = catch-all. Configuring zones switches checkout to per-zone pricing (unmatched addresses are out of coverage).</small>
          </>
        )}
      </div>
    </div>
  );
}

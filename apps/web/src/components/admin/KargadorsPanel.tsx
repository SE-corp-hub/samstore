"use client";

// Rice Ops M2 — the kargador list. Kargadors carry and repack rice; they have no
// login and no device. Staff pick them from this list when they sign on a staff phone.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminRole, roleCan } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface Kargador { id: string; name: string; phone: string | null; photoUrl: string | null; homeLocationId: string | null; isActive: boolean }
interface Location { id: string; name: string; code: string | null; isActive: boolean }
type ApiBody = { message?: string; errors?: string[] };

const empty = { name: "", phone: "", photoUrl: "", homeLocationId: "" };
const errText = (d: ApiBody | null, fallback: string) => d?.errors?.join(", ") ?? d?.message ?? fallback;

export default function KargadorsPanel() {
  const [rows, setRows] = useState<Kargador[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canEdit = roleCan(getAdminRole(), "voidRefund"); // owner or manager

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [kr, lr] = await Promise.all([
        fetch(`${API_URL}/admin/kargadors?all=1`, { headers: adminHeaders() }),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }),
      ]);
      if (!kr.ok) throw new Error("Could not load the porters");
      setRows((await kr.json()).kargadors);
      if (lr.ok) setLocations((await lr.json()).warehouses);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const locLabel = (id: string | null) => {
    const l = locations.find((x) => x.id === id);
    return l ? (l.code ? `${l.code} · ${l.name}` : l.name) : "Anywhere";
  };

  const send = async (url: string, method: string, body: unknown) => {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = { name: form.name, phone: form.phone || null, photoUrl: form.photoUrl || null, homeLocationId: form.homeLocationId || null };
    const { ok, data } = editingId ? await send(`${API_URL}/admin/kargadors/${editingId}`, "PATCH", body) : await send(`${API_URL}/admin/kargadors`, "POST", body);
    setSaving(false);
    if (!ok) { setError(errText(data, "Not saved")); return; }
    toast(editingId ? "Saved" : "Porter added");
    setForm(empty);
    setEditingId(null);
    await load();
  };

  const toggle = async (k: Kargador) => {
    const { ok, data } = await send(`${API_URL}/admin/kargadors/${k.id}`, "PATCH", { isActive: !k.isActive });
    if (!ok) { setError(errText(data, "Not saved")); return; }
    toast(k.isActive ? "No longer active" : "Active again");
    await load();
  };

  return (
    <div>
      <h1 className="h4 mb-1">Porters</h1>
      <p className="text-muted small mb-3">Porters have no login. They sign on a staff phone each time they take or hand over rice.</p>
      {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}

      {canEdit && (
        <form onSubmit={save} className="card mb-4">
          <div className="card-body">
            <h2 className="h6">{editingId ? "Edit porter" : "Add a porter"}</h2>
            <div className="row g-2">
              <div className="col-md-3">
                <label className="form-label small mb-1" htmlFor="kg-name">Name</label>
                <input id="kg-name" className="form-control" required minLength={2} maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mang Boy" />
              </div>
              <div className="col-md-3">
                <label className="form-label small mb-1" htmlFor="kg-phone">Mobile (optional)</label>
                <input id="kg-phone" className="form-control" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0917 123 4567" />
              </div>
              <div className="col-md-3">
                <label className="form-label small mb-1" htmlFor="kg-home">Usually at</label>
                <select id="kg-home" className="form-select" value={form.homeLocationId} onChange={(e) => setForm({ ...form, homeLocationId: e.target.value })}>
                  <option value="">Anywhere</option>
                  {locations.filter((l) => l.isActive).map((l) => <option key={l.id} value={l.id}>{locLabel(l.id)}</option>)}
                </select>
              </div>
              <div className="col-md-3">
                <label className="form-label small mb-1" htmlFor="kg-photo">Photo (https link, optional)</label>
                <input id="kg-photo" className="form-control" type="url" value={form.photoUrl} onChange={(e) => setForm({ ...form, photoUrl: e.target.value })} />
              </div>
            </div>
            <div className="d-flex gap-2 mt-3">
              <button className="btn btn-success" type="submit" disabled={saving}>{saving ? "Saving…" : editingId ? "Save" : "Add"}</button>
              {editingId && <button type="button" className="btn btn-outline-secondary" onClick={() => { setEditingId(null); setForm(empty); }}>Back</button>}
            </div>
          </div>
        </form>
      )}

      {loading ? <p className="text-muted">Loading…</p> : rows.length === 0 ? (
        <p className="text-muted">No porters yet.</p>
      ) : (
        <div className="list-group">
          {rows.map((k) => (
            <div key={k.id} className="list-group-item d-flex align-items-center gap-3">
              {k.photoUrl
                ? <img src={k.photoUrl} alt="" width={48} height={48} className="rounded-circle object-fit-cover" referrerPolicy="no-referrer" />
                : <span className="rounded-circle bg-light d-inline-flex align-items-center justify-content-center" style={{ width: 48, height: 48 }}><i className="bi bi-person fs-4" aria-hidden="true"></i></span>}
              <div className="flex-grow-1">
                <div className="fw-semibold" style={{ fontSize: 18 }}>{k.name} {!k.isActive && <span className="badge text-bg-secondary ms-1">Not active</span>}</div>
                <div className="small text-muted">{k.phone ?? "No number"} · {locLabel(k.homeLocationId)}</div>
              </div>
              {canEdit && (
                <div className="d-flex gap-1">
                  <button className="btn btn-sm btn-outline-secondary" onClick={() => { setEditingId(k.id); setForm({ name: k.name, phone: k.phone ?? "", photoUrl: k.photoUrl ?? "", homeLocationId: k.homeLocationId ?? "" }); }}>Edit</button>
                  <button className="btn btn-sm btn-outline-secondary" onClick={() => void toggle(k)}>{k.isActive ? "Remove" : "Bring back"}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

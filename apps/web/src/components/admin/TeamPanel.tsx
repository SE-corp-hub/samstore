"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: string;
}

const ROLES = ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"];

export default function TeamPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "STAFF" });
  const [inviting, setInviting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/admin/team`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load team");
      const data = await res.json();
      setMembers(data.members);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setError(null);
    setTempPassword(null);
    try {
      const res = await fetch(`${API_URL}/admin/team/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Invite failed");
        return;
      }
      if (data.tempPassword) setTempPassword(data.tempPassword);
      setForm({ email: "", name: "", role: "STAFF" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (userId: string, role: string) => {
    await fetch(`${API_URL}/admin/team/${userId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ role }),
    });
    await load();
  };

  const deactivate = async (userId: string) => {
    if (!confirm("Remove this member from the store?")) return;
    await fetch(`${API_URL}/admin/team/${userId}`, { method: "DELETE", headers: adminHeaders() });
    await load();
  };

  return (
    <div>
      <h1 className="h4 mb-3">Team &amp; Roles</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {tempPassword && (
        <div className="alert alert-warning py-2 small">
          <strong>New member created.</strong> Temporary password (share securely, change on first login):{" "}
          <code>{tempPassword}</code>
        </div>
      )}

      <form onSubmit={invite} className="card mb-4">
        <div className="card-body">
          <h6 className="card-title">Invite to store</h6>
          <div className="row g-2">
            <div className="col-md-3">
              <input className="form-control form-control-sm" type="email" placeholder="Email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="col-md-2">
              <input className="form-control form-control-sm" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="col-md-2">
              <select className="form-select form-select-sm" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="col-md-2">
              <button className="btn btn-primary btn-sm w-100" type="submit" disabled={inviting}>{inviting ? "…" : "Invite"}</button>
            </div>
          </div>
          <p className="text-muted small mt-2 mb-0">
            Roles: <strong>MANAGER</strong> runs the store · <strong>STAFF</strong> fulfils orders · <strong>SALES_AGENT</strong> views orders and updates delivery status · <strong>DELIVERY</strong> courier (delivery app only).
          </p>
        </div>
      </form>

      {loading ? <p className="text-muted">Loading…</p> : (
        <table className="table table-hover align-middle">
          <thead>
            <tr>
              <th>Member</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
              <th className="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td className="fw-semibold">{m.name ?? "—"}</td>
                <td>{m.email}</td>
                <td>
                  <select
                    className="form-select form-select-sm"
                    style={{ width: 140 }}
                    value={m.role}
                    disabled={m.role === "OWNER"}
                    onChange={(e) => changeRole(m.userId, e.target.value)}
                  >
                    <option value="OWNER">OWNER</option>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="small text-muted">{new Date(m.joinedAt).toLocaleDateString()}</td>
                <td className="text-end">
                  <div className="d-flex flex-wrap gap-1 justify-content-end">
                    {m.role !== "OWNER" && (
                      <>
                        <button
                          className="btn btn-sm btn-outline-secondary"
                          title="Reset password"
                          onClick={async () => {
                            const res = await fetch(`${API_URL}/admin/team/${m.userId}/reset-password`, {
                              method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
                              body: JSON.stringify({}),
                            });
                            const d = await res.json().catch(() => null);
                            if (res.ok && typeof d?.tempPassword === "string") {
                              setTempPassword(d.tempPassword);
                            } else {
                              setError(d?.message ?? "Reset failed");
                            }
                          }}
                        >
                          <i className="bi bi-key me-1"></i>Reset password
                        </button>
                        <button className="btn btn-sm btn-outline-danger" onClick={() => deactivate(m.userId)}>
                          <i className="bi bi-person-x"></i>
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
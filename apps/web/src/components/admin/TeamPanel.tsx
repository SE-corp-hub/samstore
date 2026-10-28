"use client";

// Team & roles. Rice Ops M2: staff can be added by mobile number (no email needed),
// each person gets a home location (where they may release, receive, count and sign)
// and a 4-digit PIN for quick login on their own phone.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminRole, roleCan } from "../../lib/admin";
import { askConfirm } from "../../lib/ask";

interface Member {
  userId: string;
  email: string | null;
  phone?: string | null;
  name: string | null;
  role: string;
  joinedAt?: string;
  homeLocationId?: string | null;
  hasPin?: boolean;
  pinLocked?: boolean;
  addedBy?: string | null;
  lastReset?: { kind: "PIN" | "password"; by: string | null; at: string } | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });

interface Location { id: string; name: string; code: string | null; isActive: boolean }

const ROLES = ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"];
const errText = (d: { errors?: string[]; message?: string } | null, fallback: string) => d?.errors?.join(", ") ?? d?.message ?? fallback;

export default function TeamPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ phone: "", email: "", name: "", role: "STAFF", homeLocationId: "" });
  const [inviting, setInviting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pinValue, setPinValue] = useState("");
  const canManage = roleCan(getAdminRole(), "manageTeam");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [teamRes, peopleRes, locRes] = await Promise.all([
        fetch(`${API_URL}/admin/team`, { headers: adminHeaders() }),
        fetch(`${API_URL}/admin/people`, { headers: adminHeaders() }),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }),
      ]);
      if (!teamRes.ok) throw new Error("Failed to load team");
      const team = (await teamRes.json()).members as Member[];
      const people = peopleRes.ok ? ((await peopleRes.json()).members as Member[]) : [];
      const byId = new Map(people.map((p) => [p.userId, p]));
      setMembers(team.map((m) => ({ ...m, ...(byId.get(m.userId) ?? {}) })));
      if (locRes.ok) setLocations(((await locRes.json()).warehouses as Location[]).filter((l) => l.isActive));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const locLabel = (id: string | null | undefined) => {
    if (!id) return "All locations";
    const l = locations.find((x) => x.id === id);
    return l ? `${l.code ? `${l.code} · ` : ""}${l.name}` : "—";
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setError(null);
    setNotice(null);
    setTempPassword(null);
    try {
      const res = await fetch(`${API_URL}/admin/team/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          phone: form.phone.trim() || undefined,
          email: form.email.trim() || undefined,
          name: form.name.trim() || undefined,
          role: form.role,
          homeLocationId: form.homeLocationId || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errText(data, "Invite failed"));
        return;
      }
      if (data?.tempPassword) setTempPassword(data.tempPassword);
      setForm({ phone: "", email: "", name: "", role: "STAFF", homeLocationId: "" });
      setNotice("Added. Set a PIN so they can log in on their own phone.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setInviting(false);
    }
  };

  const patchPerson = async (userId: string, body: Record<string, unknown>, done: string) => {
    setError(null);
    setNotice(null);
    const res = await fetch(`${API_URL}/admin/people/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setError(errText(d, "Not saved"));
      return false;
    }
    setNotice(done);
    await load();
    return true;
  };

  const savePin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinFor) return;
    if (await patchPerson(pinFor, { pin: pinValue }, "PIN set. They were signed out on every phone; log in again with the new PIN.")) {
      setPinFor(null);
      setPinValue("");
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
    if (!(await askConfirm("Remove this person from the store? They will be logged out on every phone.", { ok: "Remove", danger: true }))) return;
    await fetch(`${API_URL}/admin/team/${userId}`, { method: "DELETE", headers: adminHeaders() });
    await load();
  };

  return (
    <div>
      <h1 className="h4 mb-3">Team &amp; Roles</h1>
      {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}
      {notice && <div className="alert alert-success py-2 small" role="status">{notice}</div>}
      {tempPassword && (
        <div className="alert alert-warning py-2 small">
          <strong>New member created.</strong> Temporary password (share securely, change on first login):{" "}
          <code>{tempPassword}</code>
        </div>
      )}

      {canManage && (
        <form onSubmit={invite} className="card mb-4">
          <div className="card-body">
            <h2 className="h6 card-title">Add a person</h2>
            <div className="row g-2">
              <div className="col-md-3">
                <label className="form-label small mb-1" htmlFor="tm-phone">Mobile number</label>
                <input id="tm-phone" className="form-control" inputMode="tel" placeholder="0917 123 4567" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="col-md-3">
                <label className="form-label small mb-1" htmlFor="tm-email">Email (optional)</label>
                <input id="tm-email" className="form-control" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="col-md-2">
                <label className="form-label small mb-1" htmlFor="tm-name">Name</label>
                <input id="tm-name" className="form-control" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="col-md-2">
                <label className="form-label small mb-1" htmlFor="tm-role">Role</label>
                <select id="tm-role" className="form-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="col-md-2">
                <label className="form-label small mb-1" htmlFor="tm-home">Location</label>
                <select id="tm-home" className="form-select" value={form.homeLocationId} onChange={(e) => setForm({ ...form, homeLocationId: e.target.value })}>
                  <option value="">All</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l.id)}</option>)}
                </select>
              </div>
            </div>
            <button className="btn btn-success mt-3" type="submit" disabled={inviting || (!form.phone.trim() && !form.email.trim())}>
              {inviting ? "Adding…" : "Add"}
            </button>
            <p className="text-muted small mt-2 mb-0">
              <strong>MANAGER</strong> runs the store · <strong>STAFF</strong> sells, releases and receives at their location · <strong>SALES_AGENT</strong> takes orders · <strong>DELIVERY</strong> courier app only.
              Owners and managers work at every location.
            </p>
          </div>
        </form>
      )}

      {pinFor && (
        <form onSubmit={savePin} className="card mb-4 border-success">
          <div className="card-body">
            <h2 className="h6">PIN for {members.find((m) => m.userId === pinFor)?.name ?? "staff"}</h2>
            <label className="form-label small" htmlFor="tm-pin">4 digits (not 1111 or 1234)</label>
            <div className="d-flex gap-2" style={{ maxWidth: 320 }}>
              <input
                id="tm-pin" className="form-control form-control-lg text-center" inputMode="numeric" autoComplete="off"
                maxLength={4} pattern="\d{4}" value={pinValue} onChange={(e) => setPinValue(e.target.value.replace(/\D/g, "").slice(0, 4))}
                style={{ letterSpacing: "0.5em", fontVariantNumeric: "tabular-nums" }}
              />
              <button className="btn btn-success" type="submit" disabled={pinValue.length !== 4}>Save</button>
              <button className="btn btn-outline-secondary" type="button" onClick={() => { setPinFor(null); setPinValue(""); }}>Back</button>
            </div>
            <div className="form-text">Tell them the PIN in person. They can change it on their own phone.</div>
          </div>
        </form>
      )}

      {loading ? <p className="text-muted">Loading…</p> : (
        <div className="table-responsive">
          <table className="table table-hover align-middle">
            <thead>
              <tr>
                <th>Person</th>
                <th>Mobile / email</th>
                <th>Role</th>
                <th>Location</th>
                <th>PIN</th>
                <th className="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <div className="fw-semibold">{m.name ?? "—"}</div>
                    <div className="small text-muted">
                      {m.addedBy ? `Added by ${m.addedBy}` : "Joined"}{m.joinedAt ? ` · ${day(m.joinedAt)}` : ""}
                      {m.lastReset && <><br />{m.lastReset.kind === "PIN" ? "PIN set" : "Password reset"}{m.lastReset.by ? ` by ${m.lastReset.by}` : ""} · {day(m.lastReset.at)}</>}
                    </div>
                  </td>
                  <td className="small">{m.phone ?? ""}{m.phone && m.email ? <br /> : null}{m.email ?? ""}</td>
                  <td>
                    <select
                      className="form-select form-select-sm" style={{ width: 140 }} aria-label={`Role of ${m.name ?? m.userId}`}
                      value={m.role} disabled={!canManage || m.role === "OWNER"}
                      onChange={(e) => changeRole(m.userId, e.target.value)}
                    >
                      {(m.role === "OWNER" ? ["OWNER"] : ROLES).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td>
                    {canManage && m.role !== "OWNER" && m.role !== "MANAGER" ? (
                      <select
                        className="form-select form-select-sm" style={{ width: 170 }} aria-label={`Home location of ${m.name ?? m.userId}`}
                        value={m.homeLocationId ?? ""}
                        onChange={(e) => patchPerson(m.userId, { homeLocationId: e.target.value || null }, "Location saved.")}
                      >
                        <option value="">All locations</option>
                        {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l.id)}</option>)}
                      </select>
                    ) : (
                      <span className="small">{m.role === "OWNER" || m.role === "MANAGER" ? "All locations" : locLabel(m.homeLocationId)}</span>
                    )}
                  </td>
                  <td>
                    {m.pinLocked ? <span className="badge text-bg-danger">Locked</span>
                      : m.hasPin ? <span className="badge text-bg-success">Has PIN</span>
                      : <span className="badge text-bg-secondary">None yet</span>}
                  </td>
                  <td className="text-end">
                    {canManage && (
                      <div className="d-flex flex-wrap gap-1 justify-content-end">
                        <button className="btn btn-sm btn-outline-success" onClick={() => { setPinFor(m.userId); setPinValue(""); }}>
                          <i className="bi bi-123 me-1"></i>{m.hasPin ? "Change PIN" : "Set PIN"}
                        </button>
                        {m.pinLocked && (
                          <button className="btn btn-sm btn-outline-warning" onClick={() => patchPerson(m.userId, { unlock: true }, "PIN unlocked.")}>
                            <i className="bi bi-unlock me-1"></i>Unlock
                          </button>
                        )}
                        {m.role !== "OWNER" && (
                          <>
                            <button
                              className="btn btn-sm btn-outline-secondary"
                              onClick={async () => {
                                const res = await fetch(`${API_URL}/admin/team/${m.userId}/reset-password`, {
                                  method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
                                  body: JSON.stringify({}),
                                });
                                const d = await res.json().catch(() => null);
                                if (res.ok && typeof d?.tempPassword === "string") setTempPassword(d.tempPassword);
                                else setError(d?.message ?? "Reset failed");
                              }}
                            >
                              <i className="bi bi-key me-1"></i>Reset password
                            </button>
                            <button className="btn btn-sm btn-outline-danger" onClick={() => deactivate(m.userId)} aria-label={`Remove ${m.name ?? "member"}`}>
                              <i className="bi bi-person-x"></i>
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

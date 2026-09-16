"use client";

// User Access — unified user management for:
//  - STORE_OWNER: their own store's team (MANAGER/STAFF/SALES_AGENT/DELIVERY)
//  - PLATFORM_ADMIN: users of ANY store (incl. OWNER + PLATFORM_ADMIN roles) via a store picker
// Actions: add (invite w/ temp password), edit role, reset password (temp once, must-change),
//          deactivate / reactivate (delete), and remove-as-delete.
// Backed by: GET/POST /admin/team..., GET/POST /admin/stores/:id/users..., /auth/change-password.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminRole, roleCan } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status?: string;
  mustChangePassword?: boolean;
  joinedAt?: string;
}
interface StoreRow2 { id: string; name: string; slug: string }

const INVITABLE = ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"];
const ALL_ROLES = ["OWNER", "MANAGER", "STAFF", "SALES_AGENT", "DELIVERY", "PLATFORM_ADMIN"];

const apiError = (d: unknown, fb: string) =>
  (d && typeof d === "object" && (d as any).message) || (Array.isArray((d as any)?.errors) ? (d as any).errors.join(", ") : fb);

export default function UserAccessPanel() {
  const role = getAdminRole();
  const isPlatform = role === "PLATFORM_ADMIN";

  const [stores, setStores] = useState<StoreRow2[]>([]);
  const [storeId, setStoreId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add / invite
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addName, setAddName] = useState("");
  const [addRole, setAddRole] = useState(INVITABLE[0]);
  const [addSaving, setAddSaving] = useState(false);
  const [lastTemp, setLastTemp] = useState<string | null>(null);

  // Role edit / reset / delete
  const [resetTarget, setResetTarget] = useState<Member | null>(null);
  const [resetSaving, setResetSaving] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Member | null>(null);
  const [confirmAction, setConfirmAction] = useState<"deactivate" | "reactivate">("deactivate");

  // M7: roles × permissions deny matrix
  const [showMatrix, setShowMatrix] = useState(false);
  const [matrixKeys, setMatrixKeys] = useState<string[]>([]);
  const [matrixCells, setMatrixCells] = useState<{ role: string; key: string; allowed: boolean }[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixSaving, setMatrixSaving] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);

  const canEditMatrix = () => isPlatform || roleCan(getAdminRole(), "manageTeam");

  const loadMatrix = useCallback(async () => {
    if (!storeId) return;
    setMatrixLoading(true); setMatrixError(null);
    try {
      const res = await fetch(`${API_URL}/admin/role-permissions`, { headers: adminHeaders() });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d, "Failed to load permissions"));
      setMatrixKeys(d.keys ?? []);
      setMatrixCells(d.cells ?? []);
    } catch (e) {
      setMatrixError(e instanceof Error ? e.message : "Load failed");
    } finally { setMatrixLoading(false); }
  }, [storeId]);

  const toggleCell = async (role: string, key: string, now: boolean) => {
    setMatrixSaving(true); setMatrixError(null);
    try {
      const res = await fetch(`${API_URL}/admin/role-permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ role, key, allowed: now }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d, "Permission change failed"));
      toast(now ? `Restored ${role} → ${key}` : `Revoked ${role} → ${key}`);
      await loadMatrix();
    } catch (e) {
      setMatrixError(e instanceof Error ? e.message : "Change failed");
      await loadMatrix();
    } finally { setMatrixSaving(false); }
  };

  const loadStores = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/admin/stores/mine`, { headers: adminHeaders() });
      const d = await res.json();
      const list = (d.stores ?? []).map((s: any) => ({ id: s.id, name: s.name, slug: s.slug }));
      setStores(list);
      if (!storeId && list.length > 0) setStoreId(list[0].id);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void loadStores(); }, [loadStores]);

  const loadMembers = useCallback(async () => {
    if (!storeId) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch(isPlatform
        ? `${API_URL}/admin/stores/${storeId}/users`
        : `${API_URL}/admin/team`, { headers: adminHeaders() });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d, "Failed to load users"));
      setMembers(isPlatform ? (d.members ?? []) : (d.members ?? []));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally { setLoading(false); }
  }, [storeId, isPlatform]);

  useEffect(() => { void loadMembers(); }, [loadMembers]);

  useEffect(() => { if (showMatrix && storeId && canEditMatrix()) void loadMatrix(); }, [showMatrix, storeId, loadMatrix]);

  const addUser = async () => {
    if (!addEmail.trim()) { setError("Email is required."); return; }
    setAddSaving(true); setError(null); setLastTemp(null);
    try {
      const url = isPlatform
        ? `${API_URL}/admin/stores/${storeId}/users`
        : `${API_URL}/admin/team/invite`;
      const body = isPlatform
        ? { email: addEmail.trim(), name: addName.trim() || undefined, role: addRole }
        : { email: addEmail.trim(), name: addName.trim() || undefined, role: addRole };
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d, "Could not add user"));
      if (typeof d?.tempPassword === "string") { setLastTemp(d.tempPassword); toast("User added"); }
      setShowAdd(false); setAddEmail(""); setAddName("");
      await loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
    } finally { setAddSaving(false); }
  };

  const changeRole = async (m: Member, newRole: string) => {
    setError(null);
    try {
      const url = isPlatform
        ? `${API_URL}/admin/stores/${storeId}/users/${m.userId}/role`
        : `${API_URL}/admin/team/${m.userId}/role`;
      const res = await fetch(url, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ role: newRole }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d, "Role change failed"));
      toast("Role updated");
      await loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Role change failed");
    }
  };

  const resetPassword = async () => {
    if (!resetTarget) return;
    setResetSaving(true); setError(null); setResetResult(null);
    try {
      const url = isPlatform
        ? `${API_URL}/admin/stores/${storeId}/users/${resetTarget.userId}/reset-password`
        : `${API_URL}/admin/team/${resetTarget.userId}/reset-password`;
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({}),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d, "Reset failed"));
      setResetResult(typeof d?.tempPassword === "string" ? d.tempPassword : "Password reset");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally { setResetSaving(false); }
  };

  const applyAccess = async () => {
    if (!confirmTarget) return;
    setError(null);
    const targetStatus = confirmAction === "deactivate" ? "DEACTIVATED" : "ACTIVE";
    try {
      const url = isPlatform
        ? `${API_URL}/admin/stores/${storeId}/users/${confirmTarget.userId}/access`
        : `${API_URL}/admin/team/${confirmTarget.userId}`;
      const method = isPlatform ? "PATCH" : "DELETE";
      const body = isPlatform ? { status: targetStatus } : undefined;
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json", ...adminHeaders() },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(apiError(d, "Action failed"));
      toast(confirmAction === "deactivate" ? "User deactivated" : "User reactivated");
      setConfirmTarget(null);
      await loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  };

  const canEdit = (m: Member) => {
    if (m.role === "PLATFORM_ADMIN") return false;
    if (!isPlatform) return m.role !== "OWNER";
    return m.role !== "OWNER" || m.userId !== sessionStorage.getItem("samstore.admin.token")?.split(".")[0]; // self guard (loose)
  };

  const roleOptions = (m: Member) => isPlatform ? ALL_ROLES.filter((r) => r !== "PLATFORM_ADMIN" || false) : INVITABLE;

  const roleSelect = (m: Member) => (
    <select
      className="form-select form-select-sm"
      style={{ width: 150 }}
      value={m.role}
      disabled={m.role === "OWNER" && !isPlatform || m.role === "PLATFORM_ADMIN"}
      onChange={(e) => changeRole(m, e.target.value)}
    >
      {(isPlatform ? ALL_ROLES : INVITABLE).map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
  );

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h1 className="h4 mb-0"><i className="bi bi-people me-2"></i>User Access</h1>
        <button className="btn btn-primary btn-sm ms-auto" onClick={() => { setShowAdd(true); setLastTemp(null); }}>
          <i className="bi bi-plus-lg me-1"></i>Add user
        </button>
      </div>

      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {lastTemp && (
        <div className="alert alert-warning py-2 small">
          <strong>New user created.</strong> Temporary password (share securely, change on first login): <code>{lastTemp}</code>
        </div>
      )}

      {isPlatform && (
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <label className="form-label small mb-0 me-1">Store</label>
          <select className="form-select form-select-sm" style={{ width: 220 }} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.slug}</option>)}
          </select>
          <span className="small text-muted">Platform admin — any store's users</span>
        </div>
      )}

      {canEditMatrix() && (
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <button className={`btn btn-sm ${showMatrix ? "btn-outline-primary" : "btn-outline-secondary"}`} onClick={() => setShowMatrix(!showMatrix)}>
            <i className="bi bi-table me-1"></i>Role permissions
          </button>
          <span className="small text-muted">Deny-only — removing a check narrows a role; changes are audit-logged.</span>
        </div>
      )}

      {showMatrix && canEditMatrix() && (
        <div className="card mb-3">
          <div className="card-body">
            {matrixError && <div className="alert alert-danger py-2 small">{matrixError}</div>}
            {matrixLoading ? <p className="text-muted small">Loading permissions…</p> : (
              <table className="table table-sm align-middle">
                <thead>
                  <tr>
                    <th>Role</th>
                    {matrixKeys.map((k) => <th key={k} className="text-center small">{k}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {["OWNER", "MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"].map((r) => (
                    <tr key={r}>
                      <td className="small">{r}</td>
                      {matrixKeys.map((k) => {
                        const cell = matrixCells.find((c) => c.role === r && c.key === k);
                        const allowed = cell?.allowed;
                        return (
                          <td key={k} className="text-center">
                            {allowed === undefined ? (
                              <span className="text-muted">—</span>
                            ) : (
                              <input
                                className="form-check-input"
                                type="checkbox"
                                checked={allowed}
                                disabled={matrixSaving || (allowed && r === "OWNER" && k === "MANAGE")}
                                title={`${allowed ? "Restore baseline" : "Revoke"} ${r} → ${k}`}
                                onChange={(e) => toggleCell(r, k, e.target.checked)}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {loading ? <p className="text-muted">Loading…</p> : members.length === 0 ? (
        <p className="text-muted text-center py-4"><i className="bi bi-people fs-3 d-block mb-2"></i>No users in this store.</p>
      ) : (
        <table className="table table-hover align-middle">
          <thead>
            <tr>
              <th>User</th><th>Email</th><th>Role</th><th>Status</th><th className="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td className="fw-semibold">{m.name ?? "—"}</td>
                <td className="small">{m.email}</td>
                <td>{roleSelect(m)}</td>
                <td>
                  <span className={`badge ${m.status === "DEACTIVATED" ? "text-bg-danger" : "text-bg-success"}`}>{m.status ?? "ACTIVE"}</span>
                  {m.mustChangePassword && <span className="badge text-bg-warning ms-1">must change</span>}
                </td>
                <td className="text-end">
                  <div className="d-flex flex-wrap gap-1 justify-content-end">
                    <button className="btn btn-sm btn-outline-secondary" title="Reset password" onClick={() => { setResetTarget(m); setResetResult(null); }}>
                      <i className="bi bi-key me-1"></i>Reset
                    </button>
                    {m.role !== "OWNER" && m.role !== "PLATFORM_ADMIN" && (m.status ?? "ACTIVE") === "ACTIVE" && (
                      <button className="btn btn-sm btn-outline-danger" title="Deactivate" onClick={() => { setConfirmTarget(m); setConfirmAction("deactivate"); }}>
                        <i className="bi bi-person-x me-1"></i>Delete
                      </button>
                    )}
                    {m.role !== "OWNER" && m.role !== "PLATFORM_ADMIN" && m.status === "DEACTIVATED" && (
                      <button className="btn btn-sm btn-outline-success" title="Reactivate" onClick={() => { setConfirmTarget(m); setConfirmAction("reactivate"); }}>
                        <i className="bi bi-check-lg me-1"></i>Restore
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Add modal */}
      {showAdd && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Add user{isPlatform ? ` — ${stores.find((s) => s.id === storeId)?.name ?? ""}` : ""}</h5>
                  <button type="button" className="btn-close" onClick={() => setShowAdd(false)}></button>
                </div>
                <div className="modal-body">
                  <label className="form-label small">Email <span className="text-danger">*</span></label>
                  <input className="form-control" type="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} />
                  <label className="form-label small mt-2">Name</label>
                  <input className="form-control" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="optional" />
                  <label className="form-label small mt-2">Role</label>
                  <select className="form-select" value={addRole} onChange={(e) => setAddRole(e.target.value)}>
                    {(isPlatform ? ALL_ROLES : INVITABLE).map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={addSaving} onClick={addUser}>{addSaving ? "Adding…" : "Add user"}</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Reset modal */}
      {resetTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Reset password — {resetTarget.email}</h5>
                  <button type="button" className="btn-close" onClick={() => setResetTarget(null)}></button>
                </div>
                <div className="modal-body">
                  {!resetResult ? (
                    <p className="small text-muted">A temporary password will be generated. The user must change it on next login.</p>
                  ) : (
                    <div className="alert alert-warning py-2 small">
                      <strong>Temporary password (shown once):</strong>
                      <div className="fs-5 font-monospace">{resetResult}</div>
                      <div className="text-muted">Copy it now — it won't be shown again.</div>
                    </div>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setResetTarget(null)}>Close</button>
                  {!resetResult && (
                    <button className="btn btn-primary" disabled={resetSaving} onClick={resetPassword}>{resetSaving ? "Resetting…" : "Reset password"}</button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Delete/restore confirm */}
      {confirmTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{confirmAction === "deactivate" ? "Deactivate" : "Restore"} — {confirmTarget.email}</h5>
                  <button type="button" className="btn-close" onClick={() => setConfirmTarget(null)}></button>
                </div>
                <div className="modal-body">
                  <p className="small">{confirmAction === "deactivate"
                    ? "This user will lose access to the store. Their data is kept — you can reactivate later."
                    : "Restore this user's access to the store."}</p>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setConfirmTarget(null)}>Cancel</button>
                  <button className="btn btn-danger" onClick={applyAccess}>{confirmAction === "deactivate" ? "Deactivate" : "Restore"}</button>
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
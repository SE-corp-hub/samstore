"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminRole } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  currencyCode: string;
  timezone: string;
  _count: { products: number; orders: number };
}

interface StoreUser {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  mustChangePassword: boolean;
  joinedAt: string;
}

interface StoreSummary {
  orders: number;
  salesTotalMinor: number;
  inventoryValueMinor: number;
  customers: number;
  members: number;
  lastActivityAt: string | null;
}

interface ProbeResult {
  isolated: boolean;
  status?: number;
}

type StatusAction = "SUSPEND" | "REINSTATE" | "ARCHIVE" | "CLOSE";

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "text-bg-success",
  SUSPENDED: "text-bg-danger",
  ARCHIVED: "text-bg-dark",
  CLOSED: "text-bg-secondary",
};

const STATUS_META: Record<StatusAction, { to: string; label: string; btn: string; body: string }> = {
  SUSPEND: {
    to: "SUSPENDED",
    label: "Suspend",
    btn: "btn-warning",
    body: "Suspended stores stop taking orders and lock staff out until reinstated.",
  },
  REINSTATE: {
    to: "ACTIVE",
    label: "Reinstate",
    btn: "btn-success",
    body: "Restores full access to the storefront, POS and team.",
  },
  ARCHIVE: {
    to: "ARCHIVED",
    label: "Archive",
    btn: "btn-outline-secondary",
    body: "Archives the store out of active rotation. It can be restored later.",
  },
  CLOSE: {
    to: "CLOSED",
    label: "Close",
    btn: "btn-danger",
    body: "Permanently closes the store — storefront goes offline and all staff are locked out. This can't be undone.",
  },
};

const MEMBER_ROLES = ["OWNER", "MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"];

const memberBadge = (status: string) => (status === "ACTIVE" ? "text-bg-success" : "text-bg-secondary");

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

const apiError = (d: unknown, fallback: string): string => {
  if (!d || typeof d !== "object") return fallback;
  const o = d as { message?: unknown; errors?: unknown };
  if (typeof o.message === "string" && o.message) return o.message;
  if (Array.isArray(o.errors) && o.errors.length > 0) {
    return o.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(", ");
  }
  return fallback;
};

export default function StoresPanel() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", slug: "", ownerEmail: "" });
  const [saving, setSaving] = useState(false);

  // Status change (suspend / reinstate / archive / close)
  const [statusTarget, setStatusTarget] = useState<{ store: StoreRow; action: StatusAction } | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);

  // Members directory
  const [membersStore, setMembersStore] = useState<StoreRow | null>(null);
  const [members, setMembers] = useState<StoreUser[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);

  // Password reset (inside members flow)
  const [resetTarget, setResetTarget] = useState<StoreUser | null>(null);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSaving, setResetSaving] = useState(false);

  // Data summary + isolation probe
  const [summaryStore, setSummaryStore] = useState<StoreRow | null>(null);
  const [summary, setSummary] = useState<StoreSummary | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const isPlatformAdmin = getAdminRole() === "PLATFORM_ADMIN";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/stores`, { headers: adminHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? `Failed (${res.status})`);
      }
      const data = await res.json();
      setStores(data.stores);
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
      const res = await fetch(`${API_URL}/admin/stores`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ name: form.name, slug: form.slug, ownerEmail: form.ownerEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Create failed");
        return;
      }
      setForm({ name: "", slug: "", ownerEmail: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  // ── Status change (suspend / reinstate / archive / close) ─────────────────
  const openStatus = (store: StoreRow, action: StatusAction) => {
    setStatusTarget({ store, action });
    setStatusReason("");
    setStatusError(null);
  };

  const confirmStatus = async () => {
    if (!statusTarget) return;
    setStatusSaving(true);
    setStatusError(null);
    const meta = STATUS_META[statusTarget.action];
    const body: Record<string, string> = { status: meta.to };
    if (statusReason.trim()) body.reason = statusReason.trim();
    try {
      const res = await fetch(`${API_URL}/admin/stores/${statusTarget.store.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (res.ok) {
        const verb =
          statusTarget.action === "REINSTATE" ? "reinstated"
          : statusTarget.action === "SUSPEND" ? "suspended"
          : statusTarget.action === "ARCHIVE" ? "archived"
          : "closed";
        const name = statusTarget.store.name;
        setStatusTarget(null);
        toast(`${name} ${verb}`);
        await load();
      } else {
        setStatusError(apiError(d, "Status change failed"));
      }
    } catch {
      setStatusError("Network error — status change failed.");
    } finally {
      setStatusSaving(false);
    }
  };

  // ── Members directory ─────────────────────────────────────────────────────
  const loadMembers = useCallback(async (store: StoreRow | null) => {
    if (!store) return;
    setMembersError(null);
    setMembers(null);
    try {
      const res = await fetch(`${API_URL}/admin/stores/${store.id}/users`, { headers: adminHeaders() });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setMembersError(apiError(d, "Could not load members"));
        return;
      }
      setMembers((d?.members ?? d?.users ?? []) as StoreUser[]);
    } catch {
      setMembersError("Network error — could not load members.");
    }
  }, []);

  const openMembers = async (store: StoreRow) => {
    setMembersStore(store);
    setResetTarget(null);
    await loadMembers(store);
  };

  const closeMembers = () => {
    setMembersStore(null);
    setResetTarget(null);
    setResetResult(null);
  };

  const changeRole = async (userId: string, role: string) => {
    const storeId = membersStore?.id;
    if (!storeId) return;
    const res = await fetch(`${API_URL}/admin/stores/${storeId}/users/${userId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ role }),
    });
    const d = await res.json().catch(() => null);
    if (res.ok) toast("Role updated");
    else toast(apiError(d, "Role change failed"), "danger");
    await loadMembers(membersStore);
  };

  const toggleAccess = async (user: StoreUser) => {
    const storeId = membersStore?.id;
    if (!storeId) return;
    const next = user.status === "DEACTIVATED" ? "ACTIVE" : "DEACTIVATED";
    const res = await fetch(`${API_URL}/admin/stores/${storeId}/users/${user.userId}/access`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ status: next }),
    });
    const d = await res.json().catch(() => null);
    if (res.ok) toast(next === "ACTIVE" ? "Account re-activated" : "Account deactivated");
    else toast(apiError(d, "Access update failed"), "danger");
    await loadMembers(membersStore);
  };

  // ── Password reset (temp shown once) ──────────────────────────────────────
  const openReset = (user: StoreUser) => {
    setResetTarget(user);
    setResetResult(null);
    setResetError(null);
  };

  const confirmReset = async () => {
    const storeId = membersStore?.id;
    if (!storeId || !resetTarget) return;
    setResetSaving(true);
    setResetError(null);
    try {
      const res = await fetch(`${API_URL}/admin/stores/${storeId}/users/${resetTarget.userId}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({}),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && typeof d?.tempPassword === "string") {
        setResetResult(d.tempPassword);
      } else {
        setResetError(apiError(d, "Password reset failed"));
      }
    } catch {
      setResetError("Network error — password reset failed.");
    } finally {
      setResetSaving(false);
    }
  };

  const closeReset = async () => {
    setResetTarget(null);
    setResetResult(null);
    await loadMembers(membersStore);
  };

  const copyTemp = async () => {
    if (!resetResult) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(resetResult);
      toast("Temporary password copied");
    } catch {
      toast("Copy failed", "danger");
    }
  };

  // ── Data summary + isolation probe ────────────────────────────────────────
  const openData = async (store: StoreRow) => {
    setSummaryStore(store);
    setSummary(null);
    setProbe(null);
    setSummaryError(null);
    const [summaryRes, probeRes] = await Promise.all([
      fetch(`${API_URL}/admin/stores/${store.id}/summary`, { headers: adminHeaders() }),
      fetch(`${API_URL}/admin/stores/${store.id}/probe`, { headers: adminHeaders() }),
    ]);
    const sd = await summaryRes.json().catch(() => null);
    if (summaryRes.ok && sd) setSummary(sd as StoreSummary);
    else setSummaryError(apiError(sd, "Could not load store data"));
    const pd = await probeRes.json().catch(() => null);
    if (probeRes.ok && pd) {
      setProbe({
        isolated: !!pd.isolated,
        status: typeof pd.status === "number" ? (pd.status as number) : undefined,
      });
    } else {
      setProbe({ isolated: false, status: probeRes.status });
    }
  };

  return (
    <div>
      <h1 className="h4 mb-3">Stores</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <form onSubmit={create} className="card mb-4">
        <div className="card-body">
          <h6 className="card-title">Create a new store</h6>
          <div className="row g-2">
            <div className="col-md-3">
              <input className="form-control form-control-sm" placeholder="Store name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="col-md-3">
              <input className="form-control form-control-sm" placeholder="slug (e.g. my-store)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().trim() })} required pattern="[a-z0-9-]{2,40}" />
            </div>
            <div className="col-md-4">
              <input className="form-control form-control-sm" type="email" placeholder="Owner email (registered admin)" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} required />
            </div>
            <div className="col-md-2">
              <button className="btn btn-primary btn-sm w-100" type="submit" disabled={saving}>
                {saving ? "…" : "Create store"}
              </button>
            </div>
          </div>
        </div>
      </form>

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : stores.length === 0 ? (
        <p className="text-muted">No stores yet.</p>
      ) : (
        <table className="table table-hover align-middle">
          <thead>
            <tr>
              <th>Store</th>
              <th>Slug</th>
              <th className="text-end">Products</th>
              <th className="text-end">Orders</th>
              <th>Currency</th>
              <th>Status</th>
              <th>Public link</th>
              {isPlatformAdmin && <th className="text-end">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td className="fw-semibold">{s.name}</td>
                <td><code>{s.slug}</code></td>
                <td className="text-end">{s._count.products}</td>
                <td className="text-end">{s._count.orders}</td>
                <td>{s.currencyCode}</td>
                <td><span className={`badge ${STATUS_BADGE[s.status] ?? "text-bg-secondary"}`}>{s.status}</span></td>
                <td>
                  <a className="small" href={`/sam-store`} target="_blank" rel="noreferrer">/storefront</a>
                </td>
                {isPlatformAdmin && (
                  <td>
                    <div className="d-flex flex-wrap gap-1 justify-content-end">
                      {s.status === "ACTIVE" && (
                        <>
                          <button className="btn btn-sm btn-outline-warning" title="Suspend store" onClick={() => openStatus(s, "SUSPEND")}>Suspend</button>
                          <button className="btn btn-sm btn-outline-secondary" title="Archive store" onClick={() => openStatus(s, "ARCHIVE")}>Archive</button>
                          <button className="btn btn-sm btn-outline-danger" title="Close store" onClick={() => openStatus(s, "CLOSE")}>Close</button>
                        </>
                      )}
                      {s.status === "SUSPENDED" && (
                        <>
                          <button className="btn btn-sm btn-outline-success" title="Reinstate store" onClick={() => openStatus(s, "REINSTATE")}>Reinstate</button>
                          <button className="btn btn-sm btn-outline-danger" title="Close store" onClick={() => openStatus(s, "CLOSE")}>Close</button>
                        </>
                      )}
                      {s.status === "ARCHIVED" && (
                        <>
                          <button className="btn btn-sm btn-outline-success" title="Restore store" onClick={() => openStatus(s, "REINSTATE")}>Restore</button>
                          <button className="btn btn-sm btn-outline-danger" title="Close store" onClick={() => openStatus(s, "CLOSE")}>Close</button>
                        </>
                      )}
                      <button className="btn btn-sm btn-outline-primary" title="Members" onClick={() => openMembers(s)}>
                        <i className="bi bi-people me-1"></i>Members
                      </button>
                      <button className="btn btn-sm btn-outline-primary" title="Store data" onClick={() => openData(s)}>
                        <i className="bi bi-bar-chart me-1"></i>Data
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Status change confirm modal */}
      {statusTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{STATUS_META[statusTarget.action].label} store — {statusTarget.store.name}</h5>
                  <button type="button" className="btn-close" onClick={() => setStatusTarget(null)}></button>
                </div>
                <div className="modal-body">
                  {statusError && <div className="alert alert-danger py-2 small mb-2">{statusError}</div>}
                  <p className="small text-muted mb-2">{STATUS_META[statusTarget.action].body}</p>
                  <label className="form-label small">Reason <span className="text-muted">(optional)</span></label>
                  <textarea
                    className="form-control"
                    rows={2}
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    placeholder="e.g. non-payment, temporary closure…"
                  />
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setStatusTarget(null)}>Cancel</button>
                  <button className={`btn ${STATUS_META[statusTarget.action].btn}`} disabled={statusSaving} onClick={confirmStatus}>
                    {statusSaving ? "…" : STATUS_META[statusTarget.action].label}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Members directory modal */}
      {membersStore && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Members — {membersStore.name}</h5>
                  <button type="button" className="btn-close" onClick={closeMembers}></button>
                </div>
                <div className="modal-body">
                  {membersError && <div className="alert alert-danger py-2 small mb-2">{membersError}</div>}
                  {members === null ? (
                    <p className="text-muted">Loading…</p>
                  ) : members.length === 0 ? (
                    <p className="text-muted">No members yet.</p>
                  ) : (
                    <table className="table table-sm align-middle">
                      <thead>
                        <tr>
                          <th>Member</th>
                          <th>Email</th>
                          <th>Role</th>
                          <th>Status</th>
                          <th className="text-end">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((m) => (
                          <tr key={m.userId}>
                            <td className="fw-semibold">{m.name ?? "—"}</td>
                            <td className="small text-muted">
                              {m.email}
                              <div className="small text-muted">{new Date(m.joinedAt).toLocaleDateString()}</div>
                            </td>
                            <td>
                              <select
                                className="form-select form-select-sm"
                                style={{ width: 140 }}
                                value={m.role}
                                disabled={m.role === "OWNER"}
                                onChange={(e) => changeRole(m.userId, e.target.value)}
                              >
                                {MEMBER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                              </select>
                            </td>
                            <td>
                              <span className={`badge ${memberBadge(m.status)}`}>{m.status}</span>
                              {m.mustChangePassword && <span className="badge text-bg-warning ms-1">must change</span>}
                            </td>
                            <td className="text-end">
                              <div className="d-flex flex-wrap gap-1 justify-content-end">
                                {m.role === "OWNER" && (
                                  <button className="btn btn-sm btn-outline-secondary" title="Reset password" onClick={() => openReset(m)}>
                                    <i className="bi bi-key me-1"></i>Reset password
                                  </button>
                                )}
                                {m.role !== "OWNER" && (
                                  m.status === "DEACTIVATED" ? (
                                    <button className="btn btn-sm btn-outline-success" title="Re-activate account" onClick={() => toggleAccess(m)}>Reactivate</button>
                                  ) : (
                                    <button className="btn btn-sm btn-outline-danger" title="Deactivate account" onClick={() => toggleAccess(m)}>Deactivate</button>
                                  )
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={closeMembers}>Close</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Password reset confirm / temp password modal */}
      {resetTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Reset password — {resetTarget.email}</h5>
                  <button type="button" className="btn-close" onClick={closeReset}></button>
                </div>
                <div className="modal-body">
                  {resetError && <div className="alert alert-danger py-2 small mb-2">{resetError}</div>}
                  {resetResult ? (
                    <>
                      <div className="alert alert-success py-2 small mb-2">
                        <i className="bi bi-check-circle me-1"></i>Temporary password generated — shown once. Copy it now.
                      </div>
                      <label className="form-label small">Temporary password</label>
                      <div className="input-group input-group-sm mb-2">
                        <input className="form-control" readOnly value={resetResult} />
                        <button className="btn btn-outline-secondary" type="button" onClick={copyTemp}>Click to copy</button>
                      </div>
                      <div className="alert alert-warning py-2 small mb-0">
                        <i className="bi bi-exclamation-triangle me-1"></i>Customer must change on next login.
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="small text-muted mb-3">
                        This invalidates the current password and generates a one-time temporary password. Share it securely with the member.
                      </p>
                      <div className="d-flex gap-2">
                        <button className="btn btn-outline-secondary" onClick={closeReset}>Cancel</button>
                        <button className="btn btn-warning" disabled={resetSaving} onClick={confirmReset}>
                          {resetSaving ? "…" : "Reset password"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  {resetResult && (
                    <button className="btn btn-primary" onClick={closeReset}>Done</button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {/* Store data summary + isolation probe modal */}
      {summaryStore && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered modal-lg">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Store data — {summaryStore.name}</h5>
                  <button type="button" className="btn-close" onClick={() => setSummaryStore(null)}></button>
                </div>
                <div className="modal-body">
                  {summaryError && <div className="alert alert-danger py-2 small mb-2">{summaryError}</div>}
                  {summary ? (
                    <div className="row g-2">
                      {([
                        ["Orders", String(summary.orders)],
                        ["Sales", toPesos(summary.salesTotalMinor)],
                        ["Inventory value", toPesos(summary.inventoryValueMinor)],
                        ["Customers", String(summary.customers)],
                        ["Members", String(summary.members)],
                        ["Last activity", summary.lastActivityAt ? new Date(summary.lastActivityAt).toLocaleDateString() : "—"],
                      ] as [string, string][]).map(([label, value]) => (
                        <div key={label} className="col-6 col-md-4">
                          <div className="card h-100">
                            <div className="card-body py-2">
                              <div className="small text-muted">{label}</div>
                              <div className="h6 mb-0">{value}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted">Loading…</p>
                  )}
                  <hr className="my-3" />
                  <div className="d-flex flex-wrap align-items-center gap-2">
                    <span className="small fw-semibold">Isolation probe:</span>
                    {!probe ? (
                      <span className="badge text-bg-secondary">Checking…</span>
                    ) : probe.isolated ? (
                      <span className="badge text-bg-success"><i className="bi bi-check-circle me-1"></i>Data isolated</span>
                    ) : (
                      <span className="badge text-bg-danger"><i className="bi bi-exclamation-triangle me-1"></i>Cross-store leak!</span>
                    )}
                    {probe && !probe.isolated && typeof probe.status === "number" && (
                      <span className="small text-muted">(HTTP {probe.status})</span>
                    )}
                  </div>
                  <p className="small text-muted mb-2 mt-1">
                    Each store can only see its own orders, inventory, customers, credit, expenses, purchases, products, vouchers, team.
                  </p>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setSummaryStore(null)}>Close</button>
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
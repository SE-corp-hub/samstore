"use client";

// Mobile delivery site (DELIVERY role, U7): all OUT_FOR_DELIVERY orders of the store with
// tap-to-call + navigate deep links, schedule sorting, logout, and a Recent section.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../config";
import { getAdminToken } from "../lib/admin";

interface DeliveryOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  deliveryAddressLine1: string;
  deliveryAddressLine2: string | null;
  landmark: string | null;
  deliverySchedule: string | null;
  notes: string | null;
  totalMinor: number;
  paymentMethod: string;
  createdAt: string;
  items: { productName: string; quantity: number; lineTotalMinor: number }[];
}

interface RecentOrder {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  customerPhone: string;
  deliveryAddressLine1: string;
  totalMinor: number;
  createdAt: string;
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const STATUS_BADGE: Record<string, string> = {
  DELIVERED: "text-bg-success",
  FAILED_DELIVERY: "text-bg-danger",
};
const mapsLink = (addr: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;

export default function DeliveryPanel() {
  const router = useRouter();
  const [deliveries, setDeliveries] = useState<DeliveryOrder[]>([]);
  const [recent, setRecent] = useState<RecentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failTarget, setFailTarget] = useState<{ id: string; orderNumber: string } | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${getAdminToken()}` };
      const [dRes, rRes] = await Promise.all([
        fetch(`${API_URL}/delivery/orders`, { headers }),
        fetch(`${API_URL}/delivery/recent`, { headers }),
      ]);
      if (!dRes.ok) throw new Error("Failed to load (DELIVERY role required)");
      const d = await dRes.json();
      const r = await rRes.json();
      setDeliveries(d.deliveries ?? []);
      setRecent(r.recent ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const logout = () => {
    sessionStorage.removeItem("samstore.admin.token");
    sessionStorage.removeItem("samstore.admin.storeId");
    router.push("/admin/login");
  };

  const mark = async (id: string, toStatus: "DELIVERED" | "FAILED_DELIVERY") => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/delivery/orders/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getAdminToken()}` },
        body: JSON.stringify({ toStatus, reason: toStatus === "FAILED_DELIVERY" ? (reason || "Delivery failed") : undefined }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.message ?? "Update failed"); return; }
      setFailTarget(null);
      setReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  // Sort: orders with a schedule first (by time), then by placed time.
  const sorted = [...deliveries].sort((a, b) => {
    if (a.deliverySchedule && b.deliverySchedule) return a.deliverySchedule.localeCompare(b.deliverySchedule);
    if (a.deliverySchedule) return -1;
    if (b.deliverySchedule) return 1;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });

  return (
    <div className="container py-4" style={{ maxWidth: 560 }}>
      <div className="d-flex align-items-center gap-2 mb-3">
        <i className="bi bi-truck fs-3"></i>
        <div className="flex-grow-1">
          <h1 className="h5 mb-0">My deliveries</h1>
          <small className="text-muted">All orders out for delivery · refresh every 15s</small>
        </div>
        <button className="btn btn-sm btn-outline-secondary" onClick={load} title="Refresh"><i className="bi bi-arrow-clockwise"></i></button>
        <button className="btn btn-sm btn-outline-danger" onClick={logout}><i className="bi bi-box-arrow-right me-1"></i>Log out</button>
      </div>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {loading && deliveries.length === 0 ? (
        <p className="text-muted">Loading…</p>
      ) : sorted.length === 0 ? (
        <div className="text-center py-5 text-muted">
          <i className="bi bi-box-seam fs-1 d-block mb-2"></i>
          No orders out for delivery right now.
        </div>
      ) : (
        <div className="d-grid gap-3">
          {sorted.map((o) => {
            const totalQty = o.items.reduce((s, i) => s + i.quantity, 0);
            const addr = `${o.deliveryAddressLine1}${o.deliveryAddressLine2 ? ", " + o.deliveryAddressLine2 : ""}`;
            return (
              <div className="card" key={o.id}>
                <div className="card-body">
                  <div className="d-flex justify-content-between align-items-start mb-2">
                    <div>
                      <span className="fw-bold">{o.orderNumber}</span>
                      {o.deliverySchedule && <span className="badge text-bg-info ms-2"><i className="bi bi-clock me-1"></i>{o.deliverySchedule}</span>}
                      <div className="small text-muted">{new Date(o.createdAt).toLocaleString()}</div>
                    </div>
                    <span className="badge text-bg-dark">{toPesos(o.totalMinor)} · {o.paymentMethod}</span>
                  </div>
                  <div className="mb-2">
                    <div className="fw-semibold"><i className="bi bi-person me-1"></i>{o.customerName}</div>
                    <div className="small"><i className="bi bi-telephone me-1"></i>{o.customerPhone || "no phone"}</div>
                    <div className="small"><i className="bi bi-geo-alt me-1"></i>{addr}</div>
                    {o.landmark && <div className="small text-muted"><i className="bi bi-signpost me-1"></i>Near: {o.landmark}</div>}
                    {o.notes && <div className="small text-muted"><i className="bi bi-chat-left-text me-1"></i>{o.notes}</div>}
                  </div>
                  <div className="small text-muted mb-3">
                    <span className="me-2">{o.items.length} item(s) · {totalQty} qty</span>
                    {o.items.slice(0, 3).map((i) => `${i.productName} ×${i.quantity}`).join(", ")}
                    {o.items.length > 3 && " …"}
                  </div>
                  <div className="d-flex gap-2 mb-2">
                    {o.customerPhone && (
                      <a className="btn btn-outline-primary btn-sm flex-fill" href={`tel:${o.customerPhone.replace(/[^+\d]/g, "")}`}>
                        <i className="bi bi-telephone me-1"></i>Call
                      </a>
                    )}
                    {o.deliveryAddressLine1 && (
                      <a className="btn btn-outline-secondary btn-sm flex-fill" href={mapsLink(addr)} target="_blank" rel="noreferrer">
                        <i className="bi bi-sign-turn-right me-1"></i>Navigate
                      </a>
                    )}
                  </div>
                  <div className="d-flex gap-2">
                    <button className="btn btn-success btn-sm flex-fill" disabled={busyId === o.id} onClick={() => mark(o.id, "DELIVERED")}>
                      <i className="bi bi-check-lg me-1"></i>Delivered
                    </button>
                    <button className="btn btn-outline-danger btn-sm flex-fill" disabled={busyId === o.id} onClick={() => setFailTarget({ id: o.id, orderNumber: o.orderNumber })}>
                      <i className="bi bi-x-lg me-1"></i>Failed
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent */}
      {recent.length > 0 && (
        <div className="mt-4">
          <h6 className="small fw-bold text-muted text-uppercase">Recent</h6>
          <ul className="list-group">
            {recent.map((r) => (
              <li key={r.id} className="list-group-item d-flex justify-content-between align-items-center">
                <div>
                  <div className="small fw-semibold">{r.orderNumber} · {r.customerName}</div>
                  <div className="small text-muted">{new Date(r.createdAt).toLocaleString()} · {toPesos(r.totalMinor)}</div>
                </div>
                <span className={`badge ${STATUS_BADGE[r.status] ?? "text-bg-secondary"}`}>{r.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Failed delivery reason modal */}
      {failTarget && (
        <>
          <div className="modal fade show d-block" tabIndex={-1}>
            <div className="modal-dialog modal-dialog-centered">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Failed delivery — {failTarget.orderNumber}</h5>
                  <button type="button" className="btn-close" onClick={() => setFailTarget(null)}></button>
                </div>
                <div className="modal-body">
                  <label className="form-label small">Reason (required)</label>
                  <textarea className="form-control" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer not home, wrong address…" />
                </div>
                <div className="modal-footer">
                  <button className="btn btn-outline-secondary" onClick={() => setFailTarget(null)}>Cancel</button>
                  <button className="btn btn-danger" disabled={reason.trim().length < 3} onClick={() => mark(failTarget.id, "FAILED_DELIVERY")}>
                    Mark failed
                  </button>
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
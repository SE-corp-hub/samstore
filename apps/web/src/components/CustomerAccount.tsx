"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../config";
import OrderTracker from "./OrderTracker";

// Customer account panel (U6): register / login + dashboard —
// loyalty points, credit status, recent orders (track), saved contact prefill.

const TOKEN_KEY = "samstore.customer.token";

export function getCustomerToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function clearCustomerToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

interface MeData {
  customer: { id: string; email: string; name: string | null; phone: string | null };
  profile: {
    storeId: string; loyaltyPoints: number; creditApproved: boolean;
    creditLimitMinor: number; creditBalanceMinor: number; approvalStatus: string;
  } | null;
  orders: { id: string; orderNumber: string; status: string; totalMinor: number; deliveryType: string; createdAt: string; claimToken: string | null }[];
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const STATUS_BADGE: Record<string, string> = {
  RECEIVED: "text-bg-secondary", CONFIRMED: "text-bg-info", PREPARING: "text-bg-warning",
  READY: "text-bg-primary", OUT_FOR_DELIVERY: "text-bg-dark", DELIVERED: "text-bg-success",
  COMPLETED: "text-bg-success", CANCELLED: "text-bg-danger", FAILED_DELIVERY: "text-bg-danger",
};

export function CustomerAccount() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<MeData | null>(null);
  const [trackOrder, setTrackOrder] = useState<string | null>(null);

  const loadMe = useCallback(async (t: string) => {
    try {
      const res = await fetch(`${API_URL}/auth/customer/me`, { headers: { Authorization: `Bearer ${t}` } });
      if (res.ok) {
        const d = await res.json();
        setMe(d);
        // Prefill checkout contact from the account profile
        if (d.customer?.name || d.customer?.phone) {
          try {
            localStorage.setItem("samstore.lastContact", JSON.stringify({ name: d.customer.name ?? "", phone: d.customer.phone ?? "" }));
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const t = getCustomerToken();
    if (!t) return;
    setToken(t);
    try {
      const payload = JSON.parse(atob(t.split(".")[1] ?? ""));
      setEmail(payload.email ?? "");
    } catch { /* ignore */ }
    void loadMe(t);
  }, [loadMe]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/auth/customer/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "register" ? { email, password, name } : { email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Failed");
        return;
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setError(null);
      void loadMe(data.token);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    clearCustomerToken();
    setToken(null);
    setMe(null);
    setTrackOrder(null);
  };

  if (token) {
    return (
      <div className="customer-account">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <span><i className="bi bi-person-check me-1 text-success"></i>Signed in as <strong>{me?.customer.name || email}</strong></span>
          <button className="btn btn-sm btn-outline-secondary" onClick={logout}>Log out</button>
        </div>

        {me?.profile ? (
          <div className="row g-2 mb-3">
            <div className="col-6">
              <div className="card"><div className="card-body text-center py-2">
                <div className="small text-muted">Loyalty points</div>
                <div className="h4 mb-0 text-primary">{me.profile.loyaltyPoints}</div>
                <small className="text-muted">100 pts = ₱1 off</small>
              </div></div>
            </div>
            <div className="col-6">
              <div className="card"><div className="card-body text-center py-2">
                <div className="small text-muted">Utang balance</div>
                <div className={`h4 mb-0 ${me.profile.creditBalanceMinor > 0 ? "text-danger" : "text-success"}`}>{toPesos(me.profile.creditBalanceMinor)}</div>
                {me.profile.creditApproved ? (
                  <small className="text-muted">credit approved · limit {toPesos(me.profile.creditLimitMinor)}</small>
                ) : (
                  <small className="text-muted">pay on delivery/pickup</small>
                )}
              </div></div>
            </div>
          </div>
        ) : (
          <p className="text-muted small mb-3">You have no order profile at this store yet — order once and you&apos;ll earn loyalty points here.</p>
        )}

        <h6 className="small fw-bold mb-2">My orders</h6>
        {trackOrder ? (
          <div className="mb-2">
            <OrderTracker initialToken={trackOrder} />
            <button className="btn btn-sm btn-outline-secondary mt-2" onClick={() => setTrackOrder(null)}>Back to orders</button>
          </div>
        ) : me && me.orders.length > 0 ? (
          <ul className="list-group list-group-flush mb-3">
            {me.orders.map((o) => (
              <li key={o.id} className="list-group-item px-0 d-flex justify-content-between align-items-center">
                <div>
                  <div className="fw-semibold small">{o.orderNumber}</div>
                  <div className="small text-muted">{new Date(o.createdAt).toLocaleDateString()} · {toPesos(o.totalMinor)} · {o.deliveryType === "pickup" ? "pickup" : "delivery"}</div>
                </div>
                <div className="d-flex align-items-center gap-2">
                  <span className={`badge ${STATUS_BADGE[o.status] ?? "text-bg-secondary"}`}>{o.status}</span>
                  {o.claimToken && (
                    <button className="btn btn-sm btn-outline-primary" onClick={() => setTrackOrder(o.claimToken!)}><i className="bi bi-search"></i></button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : me ? (
          <p className="text-muted small mb-3">No orders yet.</p>
        ) : (
          <p className="text-muted small mb-3">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div className="card card-body py-3">
      <ul className="nav nav-tabs mb-2">
        <li className="nav-item"><button className={`nav-link small ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>Log in</button></li>
        <li className="nav-item"><button className={`nav-link small ${mode === "register" ? "active" : ""}`} onClick={() => setMode("register")}>Register</button></li>
      </ul>
      <form onSubmit={submit}>
        {mode === "register" && (
          <div className="mb-2">
            <input className="form-control form-control-sm" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="mb-2">
          <input className="form-control form-control-sm" type="email" placeholder="Email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="mb-2">
          <input className="form-control form-control-sm" type="password" placeholder="Password (min 8)" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="alert alert-danger py-1 small mb-2">{error}</div>}
        <button className="btn btn-primary btn-sm w-100" type="submit" disabled={loading}>
          {loading ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>
        <p className="text-muted mb-0 mt-2">Accounts earn loyalty points on delivered orders and can pay on credit (utang) once approved.</p>
      </form>
    </div>
  );
}
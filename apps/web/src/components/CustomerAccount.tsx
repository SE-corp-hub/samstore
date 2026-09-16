"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../config";
import OrderTracker from "./OrderTracker";
import {
  fetchRegions,
  fetchProvinces,
  fetchCities,
  fetchBarangays,
  type PhRegionOption,
  type PhProvinceOption,
  type PhCityOption,
  type PhBarangayOption,
} from "../api/address";

// Customer account panel (U6): register / login + dashboard —
// loyalty points, credit status, recent orders (track), saved PH addresses (P1.portal),
// DPA consent, and "use at checkout" prefill for the saved-address book.

const TOKEN_KEY = "samstore.customer.token";
const SAVED_ADDRESS_USE_KEY = "samstore.savedAddress";

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

interface SavedAddress {
  id: string;
  label: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  landmark: string | null;
  regionCode: string | null;
  provinceCode: string | null;
  cityCode: string | null;
  barangayCode: string | null;
  regionName: string | null;
  provinceName: string | null;
  cityName: string | null;
  barangayName: string | null;
  isDefault: boolean;
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const STATUS_BADGE: Record<string, string> = {
  RECEIVED: "text-bg-secondary", CONFIRMED: "text-bg-info", PREPARING: "text-bg-warning",
  READY: "text-bg-primary", OUT_FOR_DELIVERY: "text-bg-dark", DELIVERED: "text-bg-success",
  COMPLETED: "text-bg-success", CANCELLED: "text-bg-danger", FAILED_DELIVERY: "text-bg-danger",
};

function fullLine(a: SavedAddress): string {
  return [a.addressLine1, a.addressLine2, a.barangayName, a.cityName, a.provinceName, a.regionName]
    .filter((x) => x && x.trim())
    .join(", ");
}

export function CustomerAccount({ storeId }: { storeId?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<MeData | null>(null);
  const [trackOrder, setTrackOrder] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [useMsg, setUseMsg] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const loadAddresses = useCallback(async (t: string) => {
    if (!storeId) { setAddresses([]); return; }
    try {
      const res = await fetch(`${API_URL}/auth/customer/addresses?storeId=${encodeURIComponent(storeId)}`, { headers: bearer(t) });
      if (res.ok) {
        const d = await res.json();
        setAddresses(d.addresses ?? []);
      }
    } catch { /* ignore */ }
  }, [storeId]);

  const loadMe = useCallback(async (t: string) => {
    try {
      const res = await fetch(`${API_URL}/auth/customer/me`, { headers: bearer(t) });
      if (res.ok) {
        const d = await res.json();
        setMe(d);
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
    void loadAddresses(t);
  }, [loadMe, loadAddresses]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/auth/customer/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "register"
          ? { email, password, name, consent: { scope: "dpv1", channel: "web", version: "2026.09" } }
          : { email, password }),
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
      void loadAddresses(data.token);
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
    setAddresses([]);
  };

  const useAtCheckout = (a: SavedAddress) => {
    try {
      localStorage.setItem(SAVED_ADDRESS_USE_KEY, JSON.stringify(a));
    } catch { /* ignore */ }
    setUseMsg(`"${a.label || "Saved address"}" will prefill in checkout.`);
    setTimeout(() => setUseMsg(null), 4000);
  };

  const removeAddress = async (a: SavedAddress) => {
    try {
      const res = await fetch(`${API_URL}/auth/customer/addresses/${a.id}?storeId=${encodeURIComponent(storeId ?? "")}`, { method: "DELETE", headers: bearer(token ?? "") });
      if (res.ok) {
        setAddresses(addresses.filter((x) => x.id !== a.id));
        try {
          const saved = localStorage.getItem(SAVED_ADDRESS_USE_KEY);
          if (saved && JSON.parse(saved).id === a.id) localStorage.removeItem(SAVED_ADDRESS_USE_KEY);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };

  const setDefault = async (a: SavedAddress) => {
    try {
      await fetch(`${API_URL}/auth/customer/addresses/${a.id}`, {
        method: "PATCH",
        headers: { ...bearer(token ?? ""), "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, isDefault: true }),
      });
      await loadAddresses(token ?? "");
    } catch { /* ignore */ }
  };

  // ——— Signed-in pane ———
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

        {storeId && (
          <AddressBook
            addresses={addresses}
            token={token}
            storeId={storeId}
            showAdd={showAdd}
            setShowAdd={setShowAdd}
            onChanged={() => loadAddresses(token)}
            onUse={useAtCheckout}
            onDelete={removeAddress}
            onSetDefault={setDefault}
            useMsg={useMsg}
          />
        )}
      </div>
    );
  }

  // ——— Login/register ———
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
        <div className="form-check small mb-2">
          <input className="form-check-input" type="checkbox" id="dp" defaultChecked />
          <label className="form-check-label" htmlFor="dp">I agree with the privacy &amp; data consent (DPA).</label>
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

// ——— Saved addresses (P1.portal) ———
interface AddressBookProps {
  addresses: SavedAddress[];
  token: string;
  storeId: string;
  showAdd: boolean;
  setShowAdd: (v: boolean) => void;
  onChanged: () => void;
  onUse: (a: SavedAddress) => void;
  onDelete: (a: SavedAddress) => void;
  onSetDefault: (a: SavedAddress) => void;
  useMsg: string | null;
}

function AddressBook(p: AddressBookProps) {
  const [regions, setRegions] = useState<PhRegionOption[]>([]);
  const [provinces, setProvinces] = useState<PhProvinceOption[]>([]);
  const [cities, setCities] = useState<PhCityOption[]>([]);
  const [barangays, setBarangays] = useState<PhBarangayOption[]>([]);
  const [region, setRegion] = useState("");
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [barangay, setBarangay] = useState("");
  const [f, setF] = useState({ label: "", addressLine1: "", addressLine2: "", landmark: "", instructions: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (regions.length === 0) fetchRegions().then((r) => { if (alive) setRegions(r); });
    return () => { alive = false; };
  }, [regions.length]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  const onRegion = async (code: string) => {
    setRegion(code); setProvince(""); setCity(""); setBarangay(""); setProvinces([]); setCities([]); setBarangays([]);
    if (code) setProvinces(await fetchProvinces(code));
  };
  const onProvince = async (code: string) => {
    setProvince(code); setCity(""); setBarangay(""); setCities([]); setBarangays([]);
    if (code) setCities(await fetchCities(code));
  };
  const onCity = async (code: string) => {
    setCity(code); setBarangay(""); setBarangays([]);
    if (code) setBarangays(await fetchBarangays(code));
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = {
        storeId: p.storeId, ...f,
        regionCode: region || undefined, provinceCode: province || undefined,
        cityCode: city || undefined, barangayCode: barangay || undefined,
      };
      const res = await fetch(`${API_URL}/auth/customer/addresses`, {
        method: "POST",
        headers: { ...{ Authorization: `Bearer ${p.token}` }, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr((data?.errors as string[])?.join(", ") ?? data?.message ?? "Failed to save");
        return;
      }
      setF({ label: "", addressLine1: "", addressLine2: "", landmark: "", instructions: "" });
      setRegion(""); setProvince(""); setCity(""); setBarangay("");
      setProvinces([]); setCities([]); setBarangays([]);
      p.setShowAdd(false);
      p.onChanged();
    } catch {
      setErr("Network error");
    } finally {
      setBusy(false);
    }
  };

  const full = p.addresses.length === 0;

  return (
    <div className="mb-3">
      <h6 className="small fw-bold mb-1 d-flex justify-content-between align-items-center">
        <span>Saved addresses</span>
        <button className="btn btn-sm btn-outline-primary" onClick={() => p.setShowAdd(!p.showAdd)}>
          {p.showAdd ? "Cancel" : "+ Add"}
        </button>
      </h6>

      {p.useMsg && <div className="alert alert-success py-1 small mb-2">{p.useMsg}</div>}

      {p.showAdd && (
        <div className="border rounded p-2 small mb-2">
          <div className="row g-1">
            <div className="col-6"><input className="form-control form-control-sm" placeholder="Label (Home/Office)" value={f.label} onChange={set("label")} /></div>
            <div className="col-6"><input className="form-control form-control-sm" placeholder="Street / House no." value={f.addressLine1} onChange={set("addressLine1")} /></div>
            <div className="col-6"><input className="form-control form-control-sm" placeholder="Building / Unit" value={f.addressLine2} onChange={set("addressLine2")} /></div>
            <div className="col-6"><input className="form-control form-control-sm" placeholder="Landmark" value={f.landmark} onChange={set("landmark")} /></div>
          </div>
          <select className="form-select form-select-sm mt-1" value={region} onChange={(e) => onRegion(e.target.value)}>
            <option value="">Region</option>
            {regions.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
          <select className="form-select form-select-sm mt-1" value={province} disabled={!region} onChange={(e) => onProvince(e.target.value)}>
            <option value="">Province</option>
            {provinces.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
          <select className="form-select form-select-sm mt-1" value={city} disabled={!province} onChange={(e) => onCity(e.target.value)}>
            <option value="">City / Municipality</option>
            {cities.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
          <select className="form-select form-select-sm mt-1" value={barangay} disabled={!city} onChange={(e) => setBarangay(e.target.value)}>
            <option value="">Barangay</option>
            {barangays.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
          <input className="form-control form-control-sm mt-1" placeholder="Delivery instructions (optional)" value={f.instructions} onChange={set("instructions")} />
          {err && <div className="alert alert-danger py-1 small mt-1 mb-1">{err}</div>}
          <button className="btn btn-primary btn-sm w-100" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save address"}</button>
        </div>
      )}

      {full && p.addresses.length === 0 && !p.showAdd && (
        <p className="text-muted small mb-1">No saved addresses yet.</p>
      )}

      <ul className="list-group list-group-flush">
        {p.addresses.map((a) => (
          <li key={a.id} className="list-group-item px-2 py-1 d-flex justify-content-between align-items-center">
            <div className="small">
              <span className="fw-semibold">{a.label || "Address"}</span>
              {a.isDefault && <span className="badge text-bg-primary ms-1">default</span>}
              <div className="text-muted">{fullLine(a)}</div>
            </div>
            <div className="d-flex gap-1">
              <button className="btn btn-sm btn-outline-success py-0" onClick={() => p.onUse(a)} title="Use at checkout"><i className="bi bi-bag-check"></i></button>
              {!a.isDefault && <button className="btn btn-sm btn-outline-secondary py-0" onClick={() => p.onSetDefault(a)} title="Set default"><i className="bi bi-star"></i></button>}
              <button className="btn btn-sm btn-outline-danger py-0" onClick={() => p.onDelete(a)} title="Delete"><i className="bi bi-trash"></i></button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
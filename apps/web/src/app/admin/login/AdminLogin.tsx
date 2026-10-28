"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../../config";
import { wakeFetch } from "../../../lib/wake-fetch";
import { getAuthItem, setAuthItem } from "../../../lib/admin";

export default function AdminLogin() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Forced password change on first login.
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  // Rice Ops M2: PIN login — mobile number + 4 digits on a big on-screen pad.
  const [pinMode, setPinMode] = useState(false);
  const [pinPhone, setPinPhone] = useState("");
  const [pin, setPin] = useState("");
  const [waking, setWaking] = useState(false); // the sleeping beta server is starting up

  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("pin") === "1") setPinMode(true);
      const last = localStorage.getItem("samstore.pin.phone");
      if (last) setPinPhone(last);
    } catch { /* storage may be blocked: start empty */ }
  }, []);

  // A phone that is still signed in goes straight to its screen. A rejected (expired) token is
  // cleared by handleUnauthorized on the next call, so this cannot loop back here forever.
  useEffect(() => {
    const saved = getAuthItem("samstore.admin.token");
    if (saved) goAfterAuth(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pinLogin = async (digits: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await wakeFetch(`${API_URL}/auth/pin-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: pinPhone, pin: digits }),
      }, setWaking);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "Could not log in");
        setPin("");
        return;
      }
      try { localStorage.setItem("samstore.pin.phone", pinPhone); } catch { /* convenience only */ }
      setAuthItem("samstore.admin.token", data.token);
      setAuthItem("samstore.admin.email", data.user?.name ?? data.user?.phone ?? pinPhone);
      goAfterAuth(data.token);
    } catch {
      setError("No internet. Try again.");
      setPin("");
    } finally {
      setLoading(false);
    }
  };

  const pressDigit = (d: string) => {
    if (loading) return;
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) void pinLogin(next);
  };

  const decodeRole = (token: string): string => {
    try {
      const parts = token.split(".");
      if (parts.length < 2) return "";
      const payloadPart = parts[1] ?? "";
      if (!payloadPart) return "";
      const payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")));
      return payload.role ?? "";
    } catch {
      return "";
    }
  };

  const goAfterAuth = (token: string) => {
    router.push(decodeRole(token) === "DELIVERY" ? "/admin/delivery" : "/admin/dashboard");
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await wakeFetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      }, setWaking);
      const data = await res.json();
      if (!res.ok) {
        // First-login guard: credentials are valid but a password change is required.
        const mc = data?.mustChangePassword === true || data?.error?.mustChangePassword === true;
        if (mc) {
          setMustChange(true);
          setChangeError(null);
          return;
        }
        setError(data?.message ?? "Login failed");
        return;
      }
      // Keep the sign-in on this phone for later visits (see lib/admin.ts).
      setAuthItem("samstore.admin.token", data.token);
      setAuthItem("samstore.admin.email", data.user?.email ?? identifier);
      goAfterAuth(data.token);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setChangeError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setChangeError("New passwords do not match.");
      return;
    }
    setChanging(true);
    setChangeError(null);
    try {
      const res = await fetch(`${API_URL}/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, currentPassword: password, newPassword, newPasswordConfirm }),
      });
      const data = await res.json();
      if (!res.ok) {
        setChangeError(data?.message ?? "Change failed");
        return;
      }
      // Password changed — the new token is now valid; continue to the app.
      setAuthItem("samstore.admin.token", data.token);
      goAfterAuth(data.token);
    } catch {
      setChangeError("Network error");
    } finally {
      setChanging(false);
    }
  };

  const backToLogin = () => {
    setMustChange(false);
    setChangeError(null);
    setNewPassword("");
    setNewPasswordConfirm("");
    setError(null);
  };

  return (
    <div className="admin-login">
      <div className="container d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
        {mustChange ? (
          <div className="card shadow-sm p-4" style={{ width: "100%", maxWidth: 420 }}>
            <div className="text-center mb-4">
              <i className="bi bi-shield-lock fs-1 text-warning"></i>
              <h4 className="mt-2 mb-0">You must change your password</h4>
              <p className="text-muted small">
                Signed in as <strong>{identifier}</strong> — set a new password to continue.
              </p>
            </div>
            {changeError && <div className="alert alert-danger py-2 small">{changeError}</div>}

            <form onSubmit={changePassword}>
              <div className="mb-3">
                <label className="form-label small">New password</label>
                <input
                  className="form-control"
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
                <div className="form-text small">Minimum 8 characters. You will be signed in with the new password.</div>
              </div>
              <div className="mb-3">
                <label className="form-label small">Retype new password</label>
                <input
                  className="form-control"
                  type="password"
                  required
                  minLength={8}
                  value={newPasswordConfirm}
                  onChange={(e) => setNewPasswordConfirm(e.target.value)}
                  placeholder="Retype the new password"
                />
              </div>
              <button className="btn btn-primary w-100" type="submit" disabled={changing}>
                {changing ? "Updating…" : "Confirm"}
              </button>
            </form>
            <button className="btn btn-link btn-sm w-100 mt-2" type="button" onClick={backToLogin}>
              ← Back to sign in
            </button>
          </div>
        ) : pinMode ? (
          <div className="card shadow-sm p-4" style={{ width: "100%", maxWidth: 420, fontSize: 18 }}>
            <div className="text-center mb-3">
              <i className="bi bi-person-badge fs-1 text-success"></i>
              <h1 className="h4 mt-2 mb-0">Log in with your PIN</h1>
            </div>
            {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
            {waking && <div className="alert alert-info py-2" role="status">Starting the server — this can take up to a minute. Please wait.</div>}
            <label className="form-label" htmlFor="pin-phone">Mobile number</label>
            <input
              id="pin-phone" className="form-control form-control-lg mb-3" inputMode="tel" autoComplete="tel"
              value={pinPhone} onChange={(e) => setPinPhone(e.target.value)} placeholder="0917 123 4567"
            />
            <div className="text-center mb-2" aria-live="polite" aria-label={`${pin.length} of 4 digits`}>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`d-inline-block rounded-circle mx-2 ${i < pin.length ? "bg-dark" : "border border-2 border-dark"}`} style={{ width: 18, height: 18 }} />
              ))}
            </div>
            <div className="row g-2" style={{ fontVariantNumeric: "tabular-nums" }}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <div className="col-4" key={d}>
                  <button type="button" className="btn btn-outline-dark w-100 py-3 fs-3" disabled={loading || !pinPhone.trim()} onClick={() => pressDigit(d)}>{d}</button>
                </div>
              ))}
              <div className="col-4">
                <button type="button" className="btn btn-outline-secondary w-100 py-3" disabled={loading || pin.length === 0} onClick={() => setPin(pin.slice(0, -1))} aria-label="Erase the last digit">
                  <i className="bi bi-backspace fs-4"></i>
                </button>
              </div>
              <div className="col-4">
                <button type="button" className="btn btn-outline-dark w-100 py-3 fs-3" disabled={loading || !pinPhone.trim()} onClick={() => pressDigit("0")}>0</button>
              </div>
              <div className="col-4">
                <button type="button" className="btn btn-outline-secondary w-100 py-3" disabled={loading} onClick={() => setPin("")}>Clear</button>
              </div>
            </div>
            {loading && <p className="text-center text-muted mt-3 mb-0">Please wait…</p>}
            <button className="btn btn-link w-100 mt-3" type="button" onClick={() => { setPinMode(false); setError(null); setPin(""); }}>
              Use password instead
            </button>
          </div>
        ) : (
          <div className="card shadow-sm p-4" style={{ width: "100%", maxWidth: 420 }}>
            <div className="text-center mb-4">
              <i className="bi bi-shop fs-1 text-primary"></i>
              <h4 className="mt-2 mb-0">Sam&apos;s Admin</h4>
              <p className="text-muted small">Sign in to manage your store</p>
            </div>
            {error && <div className="alert alert-danger py-2 small">{error}</div>}
            {waking && <div className="alert alert-info py-2" role="status">Starting the server — this can take up to a minute. Please wait.</div>}

            {/* Security: demo logins (with passwords) only when a developer turns them on —
                never on a real deployment. */}
            {process.env.NEXT_PUBLIC_SHOW_DEMO_LOGINS === "true" && (
            <div className="alert alert-light border small mb-3">
              <div className="fw-semibold small mb-1"><i className="bi bi-info-circle me-1"></i>Demo accounts — tap to fill</div>
              <div className="d-flex flex-wrap gap-1">
                {([
                  ["Owner", "admin@samstore.test", "admin-pass-123"],
                  ["Manager", "manager@samstore.test", "manager-pass-123"],
                  ["Staff", "staff@samstore.test", "staff-pass-123"],
                  ["Agent", "agent@samstore.test", "agent-pass-123"],
                  ["Delivery", "delivery@samstore.test", "delivery-pass-123"],
                  ["Customer", "customer@samstore.test", "customer-pass-123"],
                  ["Platform", "platform@samstore.test", "platform-pass-123"],
                ] as [string, string, string][]).map(([label, em, pw]) => (
                  <button
                    key={em}
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => { setIdentifier(em); setPassword(pw); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="text-muted small mt-1">Passwords shown for local demo only. Delivery opens the courier app; Customer is the storefront account.</div>
            </div>
            )}

            <form onSubmit={login}>
              <div className="mb-3">
                <label className="form-label small">Phone or email</label>
                <input
                  className="form-control"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="0917 123 4567 or owner@store.com"
                />
              </div>
              <div className="mb-3">
                <label className="form-label small">Password</label>
                <input
                  className="form-control"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <button className="btn btn-primary w-100" type="submit" disabled={loading}>
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>
            <button className="btn btn-outline-success w-100 mt-2" type="button" onClick={() => { setPinMode(true); setError(null); }}>
              <i className="bi bi-123 me-1"></i>Staff: log in with PIN
            </button>
            <hr className="my-4" />
            <p className="text-muted small mb-0 text-center">
              No account? The store owner will add you.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

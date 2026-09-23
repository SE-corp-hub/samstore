"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../../config";

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
      const res = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
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
      // Store token for subsequent API calls (demo: sessionStorage).
      sessionStorage.setItem("samstore.admin.token", data.token);
      sessionStorage.setItem("samstore.admin.email", data.user?.email ?? identifier);
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
      sessionStorage.setItem("samstore.admin.token", data.token);
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
        ) : (
          <div className="card shadow-sm p-4" style={{ width: "100%", maxWidth: 420 }}>
            <div className="text-center mb-4">
              <i className="bi bi-shop fs-1 text-primary"></i>
              <h4 className="mt-2 mb-0">Sam&apos;s Admin</h4>
              <p className="text-muted small">Sign in to manage your store</p>
            </div>
            {error && <div className="alert alert-danger py-2 small">{error}</div>}

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
            <hr className="my-4" />
            <p className="text-muted small mb-0 text-center">
              Don&apos;t have an account?{" "}
              <a href="/admin/register">Register a store owner</a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

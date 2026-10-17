"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../../config";
import { setAuthItem } from "../../../lib/admin";

export default function AdminRegister() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // Catch the typo before the round-trip — the API re-checks, this is just faster.
    if (password !== passwordConfirm) {
      setError("Passwords do not match.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          password,
          passwordConfirm,
          name,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.errors?.join(", ") ?? data?.message ?? "Registration failed");
        return;
      }
      setAuthItem("samstore.admin.token", data.token);
      router.push("/admin/dashboard");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-login">
      <div className="container d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
        <div className="card shadow-sm p-4" style={{ width: "100%", maxWidth: 420 }}>
          <div className="text-center mb-4">
            <i className="bi bi-shop fs-1 text-primary"></i>
            <h4 className="mt-2 mb-0">Create Admin Account</h4>
            <p className="text-muted small">Register to manage your store</p>
          </div>
          {error && <div className="alert alert-danger py-2 small">{error}</div>}
          <form onSubmit={register}>
            <div className="mb-3">
              <label className="form-label small">Name (optional)</label>
              <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="mb-3">
              <label className="form-label small">Mobile number (recommended)</label>
              <input
                className="form-control"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0917 123 4567"
              />
              <div className="form-text small">Optional for now. Used to identify your account and for verification/reset codes.</div>
            </div>
            <div className="mb-3">
              <label className="form-label small">Email</label>
              <input className="form-control" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@store.com" />
            </div>
<div className="mb-3">
                <label className="form-label small">Password (min 8)</label>
                <input
                  className="form-control"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null); // a stale mismatch banner is worse than none
                  }}
                />
              </div>
              <div className="mb-3">
                <label className="form-label small">Re-enter password</label>
                <input
                  className="form-control"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(e) => {
                    setPasswordConfirm(e.target.value);
                    setError(null);
                  }}
                  placeholder="Type the same password again"
                />
                {passwordConfirm && password !== passwordConfirm && (
                  <div className="form-text small text-danger">Passwords do not match.</div>
                )}
              </div>
            <button className="btn btn-primary w-100" type="submit" disabled={loading}>
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
          <hr className="my-4" />
          <p className="text-muted small mb-0 text-center">
            Already have an account? <a href="/admin/login">Sign in</a>
          </p>
        </div>
      </div>
    </div>
  );
}
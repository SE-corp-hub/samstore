"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

// Maintenance panel — cart sweeps, DB stats.

export default function MaintenancePanel() {
  const [stats, setStats] = useState<{ openCarts: number; expiredCarts: number; orders: number } | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/admin/maintenance/stats`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load stats");
      const d = await res.json();
      setStats({ openCarts: d.openCarts, expiredCarts: d.expiredCarts, orders: d.orders });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const sweep = async () => {
    setSweeping(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/admin/maintenance/sweep-expired-carts`, {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message ?? "Sweep failed");
      setResult(`Marked ${d.marked} expired cart(s) as ABANDONED.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sweep failed");
    } finally {
      setSweeping(false);
    }
  };

  return (
    <div>
      <h1 className="h4 mb-3">Maintenance</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {result && <div className="alert alert-success py-2 small">{result}</div>}
      <div className="card">
        <div className="card-body">
          <h6 className="card-title">Database health</h6>
          {stats ? (
            <ul className="list-group list-group-flush mb-3">
              <li className="list-group-item px-0 d-flex justify-content-between"><span>Open carts</span><span className="fw-semibold">{stats.openCarts}</span></li>
              <li className="list-group-item px-0 d-flex justify-content-between"><span>Expired carts (awaiting sweep)</span><span className="fw-semibold text-danger">{stats.expiredCarts}</span></li>
              <li className="list-group-item px-0 d-flex justify-content-between"><span>Total orders</span><span className="fw-semibold">{stats.orders}</span></li>
            </ul>
          ) : <p className="text-muted small">Loading…</p>}
          <button className="btn btn-warning btn-sm" onClick={sweep} disabled={sweeping || !stats?.expiredCarts}>
            <i className="bi bi-broom me-1"></i>{sweeping ? "Sweeping…" : "Sweep expired carts"}
          </button>
          <p className="text-muted small mt-2 mb-0">Marks expired OPEN carts as ABANDONED so stock reservations never leak.</p>
        </div>
      </div>
    </div>
  );
}
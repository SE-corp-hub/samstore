"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import BarChart from "./BarChart";

interface Summary {
  totalOrders: number;
  deliveredOrders: number;
  revenueMinor: number;
  uniqueCustomers: number;
  lowStock: { name: string; sku: string; quantityOnHand: number; reorderThreshold: number }[];
}

export default function AnalyticsPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [statusRows, setStatusRows] = useState<{ status: string; count: number }[]>([]);
  const [daily, setDaily] = useState<{ date: string; count: number; revenueMinor: number }[]>([]);
  const [top, setTop] = useState<{ name: string; qty: number; revenueMinor: number }[]>([]);
  const [vouchers, setVouchers] = useState<{ code: string; redemptionCount: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, st, d, p, v] = await Promise.all([
        fetch(`${API_URL}/admin/analytics/summary`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/analytics/status`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/analytics/daily`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/analytics/products`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/analytics/vouchers`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setSummary(s);
      setStatusRows(st.rows ?? []);
      setDaily(d.days ?? []);
      setTop(p.products ?? []);
      setVouchers(v.vouchers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

  return (
    <div>
      <h1 className="h4 mb-3">Analytics</h1>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {summary && (
        <div className="row g-3 mb-3">
          <div className="col-6 col-md-3">
            <div className="card"><div className="card-body py-3">
              <div className="text-muted small">Total orders</div>
              <div className="fs-4 fw-bold">{summary.totalOrders}</div>
            </div></div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card"><div className="card-body py-3">
              <div className="text-muted small">Delivered</div>
              <div className="fs-4 fw-bold">{summary.deliveredOrders}</div>
            </div></div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card"><div className="card-body py-3">
              <div className="text-muted small">Revenue</div>
              <div className="fs-4 fw-bold">{pesos(summary.revenueMinor)}</div>
            </div></div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card"><div className="card-body py-3">
              <div className="text-muted small">Unique customers</div>
              <div className="fs-4 fw-bold">{summary.uniqueCustomers}</div>
            </div></div>
          </div>
        </div>
      )}

      <div className="row g-3">
        <div className="col-md-7">
          <div className="card"><div className="card-body">
            <h6 className="card-title">Revenue last 14 days</h6>
            <BarChart data={daily.map((d) => ({ label: d.date.slice(5), value: d.revenueMinor, valueLabel: pesos(d.revenueMinor) }))} />
          </div></div>
        </div>
        <div className="col-md-5">
          <div className="card"><div className="card-body">
            <h6 className="card-title">Orders by status</h6>
            {statusRows.length === 0 ? <p className="text-muted small mb-0">No orders yet.</p> : (
              <ul className="list-group list-group-flush">
                {statusRows.map((r) => (
                  <li key={r.status} className="list-group-item px-0 d-flex justify-content-between">
                    <span>{r.status}</span>
                    <span className="fw-semibold">{r.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div></div>
        </div>
      </div>

      <div className="row g-3 mt-1">
        <div className="col-md-6">
          <div className="card"><div className="card-body">
            <h6 className="card-title">Top products</h6>
            {top.length === 0 ? <p className="text-muted small mb-0">No sales yet.</p> : (
              <table className="table table-sm mb-0">
                <thead><tr><th>Product</th><th className="text-end">Qty</th><th className="text-end">Revenue</th></tr></thead>
                <tbody>
                  {top.map((p) => (
                    <tr key={p.name}><td>{p.name}</td><td className="text-end">{p.qty}</td><td className="text-end">{pesos(p.revenueMinor)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div></div>
        </div>
        <div className="col-md-6">
          <div className="card"><div className="card-body">
            <h6 className="card-title">Voucher usage</h6>
            {vouchers.length === 0 ? <p className="text-muted small mb-0">No vouchers yet.</p> : (
              <ul className="list-group list-group-flush">
                {vouchers.map((v) => (
                  <li key={v.code} className="list-group-item px-0 d-flex justify-content-between">
                    <span><code>{v.code}</code></span>
                    <span className="fw-semibold">{v.redemptionCount} uses</span>
                  </li>
                ))}
              </ul>
            )}
          </div></div>
        </div>
      </div>

      {summary && summary.lowStock.length > 0 && (
        <div className="card mt-3 border-warning">
          <div className="card-body">
            <h6 className="card-title text-warning"><i className="bi bi-exclamation-triangle me-1"></i>Low stock</h6>
            {summary.lowStock.map((s) => (
              <div key={s.sku} className="small d-flex justify-content-between">
                <span>{s.name} <span className="text-muted">({s.sku})</span></span>
                <span className="text-danger fw-semibold">{s.quantityOnHand} left (threshold {s.reorderThreshold})</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
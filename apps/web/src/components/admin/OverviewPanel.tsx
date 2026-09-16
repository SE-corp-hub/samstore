"use client";

// Overview — KPI landing (U3): today's sales, pending, out-for-delivery, low stock, utang.
// Numbers come from the live API (analytics/status, analytics/daily, inventory, credit/utang).

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import BarChart from "./BarChart";

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

interface OverviewProps {
  onNavigate: (tab: string) => void;
  storeSlug?: string;
  storeName?: string;
}

interface StatusRow { status: string; count: number; revenueMinor: number }
interface DayRow { date: string; count: number; revenueMinor: number }

export default function OverviewPanel({ onNavigate, storeSlug, storeName }: OverviewProps) {
  const [status, setStatus] = useState<StatusRow[]>([]);
  const [daily, setDaily] = useState<DayRow[]>([]);
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [lowItems, setLowItems] = useState<{ name: string; availableQuantity: number }[]>([]);
  const [utangMinor, setUtangMinor] = useState<number | null>(null);
  const [utangOverdue, setUtangOverdue] = useState<number | null>(null);
  const [dailyTargetMinor, setDailyTargetMinor] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [partial, setPartial] = useState(false); // true when some widgets failed but page still renders

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPartial(false);
    // Each widget fetches independently — one failure never blanks the whole page.
    const [sRes, dRes, iRes] = await Promise.all([
      fetch(`${API_URL}/admin/analytics/status`, { headers: adminHeaders() }).catch(() => null),
      fetch(`${API_URL}/admin/analytics/daily?days=7`, { headers: adminHeaders() }).catch(() => null),
      fetch(`${API_URL}/admin/inventory?status=low`, { headers: adminHeaders() }).catch(() => null),
    ]);
    let failed = 0;
    if (sRes?.ok) setStatus((await sRes.json()).rows ?? []);
    else failed++;
    if (dRes?.ok) setDaily((await dRes.json()).days ?? []);
    else failed++;
    if (iRes?.ok) {
      const items = ((await iRes.json()).items ?? []);
      setLowStockCount(items.length);
      setLowItems(items.slice(0, 5).map((x: any) => ({ name: x.name ?? x.productName ?? "Item", availableQuantity: x.availableQuantity ?? 0 })));
    } else failed++;
    if (failed === 3) {
      setError("Failed to load overview");
      setPartial(false);
    } else if (failed > 0) {
      setPartial(true); // page renders; banner says some widgets couldn't load
      setError("Some widgets couldn't load — showing what's available.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Utang owed (owner/manager surface — silently skip on 403)
  useEffect(() => {
    fetch(`${API_URL}/admin/credit/utang`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null) as Promise<{ customers?: { balanceMinor: number; daysOverdue: number }[] } | null>)
      .then((d) => {
        const custs = d?.customers ?? [];
        setUtangMinor(custs.reduce((s, c) => s + (c.balanceMinor ?? 0), 0));
        setUtangOverdue(custs.filter((c) => (c.daysOverdue ?? 0) > 0).length);
      })
      .catch(() => setUtangMinor(null));
  }, []);

  // Daily sales target (from store settings) — 0/absent = off.
  useEffect(() => {
    fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null) as Promise<{ settings?: { dailySalesTargetMinor?: number } } | null>)
      .then((d) => setDailyTargetMinor(d?.settings?.dailySalesTargetMinor ?? 0))
      .catch(() => setDailyTargetMinor(0));
  }, []);

  // Auto-refresh toggle (30s) — persisted per browser.
  useEffect(() => {
    try { setAutoRefresh(localStorage.getItem("ovw.autoRefresh") === "1"); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const countOf = (s: string) => status.find((r) => r.status === s)?.count ?? 0;
  const today = daily.length > 0 ? daily[daily.length - 1] : null;
  const awaiting = countOf("RECEIVED") + countOf("CONFIRMED");
  const outForDelivery = countOf("OUT_FOR_DELIVERY");
  const chartData = daily.map((d) => ({ label: d.date.slice(5), value: d.revenueMinor }));

  if (loading) {
    return (
      <div className="d-flex justify-content-center py-5">
        <div className="spinner-border text-primary" role="status"></div>
        <span className="ms-2 text-muted">Loading overview…</span>
      </div>
    );
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center flex-wrap mb-3">
        <div>
          <h1 className="h4 mb-0">Good day! 👋</h1>
          {storeName && <small className="text-muted">Here&apos;s how {storeName} is doing today.</small>}
        </div>
        <div className="d-flex gap-2 align-items-center">
          {storeSlug && (
            <a className="btn btn-sm btn-outline-primary" href={`/${storeSlug}`} target="_blank" rel="noreferrer">
              <i className="bi bi-box-arrow-up-right me-1"></i>Open storefront
            </a>
          )}
          <button className="btn btn-sm btn-outline-secondary" onClick={load} title="Refresh" disabled={loading}>
            <i className="bi bi-arrow-clockwise"></i>
          </button>
          <div className="form-check form-switch form-check-sm ms-1" title="Auto-refresh every 30s">
            <input className="form-check-input" type="checkbox" id="ovwAuto" checked={autoRefresh} onChange={(e) => { setAutoRefresh(e.target.checked); try { localStorage.setItem("ovw.autoRefresh", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
            <label className="form-check-label small" htmlFor="ovwAuto">Auto</label>
          </div>
        </div>
      </div>

      {error && (
        <div className={`alert ${partial ? "alert-warning" : "alert-danger"} py-2 small d-flex justify-content-between align-items-center mb-2`}>
          <span>{error}</span>
          <button className="btn btn-sm btn-outline-secondary ms-2" onClick={load} disabled={loading}><i className="bi bi-arrow-clockwise me-1"></i>Retry</button>
        </div>
      )}

      <div className="row g-3 mb-3">
        <div className="col-6 col-md-3">
          <button className="btn card text-start h-100 p-3 shadow-sm" onClick={() => onNavigate("orders")}>
            <div className="small text-muted">Today&apos;s sales</div>
            <div className="h4 mb-0">{toPesos(today?.revenueMinor ?? 0)}</div>
            <small className="text-muted">{today?.count ?? 0} orders</small>
            {dailyTargetMinor && dailyTargetMinor > 0 && (
              <div className="progress mt-1" style={{ height: 6 }}>
                <div className="progress-bar" style={{ width: `${Math.min(100, Math.round(((today?.revenueMinor ?? 0) / dailyTargetMinor) * 100))}%` }}></div>
              </div>
            )}
            {dailyTargetMinor && dailyTargetMinor > 0 && (
              <small className="text-muted">{Math.round(((today?.revenueMinor ?? 0) / dailyTargetMinor) * 100)}% of {toPesos(dailyTargetMinor)}</small>
            )}
          </button>
        </div>
        <div className="col-6 col-md-3">
          <button className="btn card text-start h-100 p-3 shadow-sm" onClick={() => onNavigate("orders")}>
            <div className="small text-muted">Awaiting action</div>
            <div className={`h4 mb-0 ${awaiting > 0 ? "text-warning" : ""}`}>{awaiting}</div>
            <small className="text-muted">received + confirmed</small>
          </button>
        </div>
        <div className="col-6 col-md-3">
          <button className="btn card text-start h-100 p-3 shadow-sm" onClick={() => onNavigate("orders")}>
            <div className="small text-muted">Out for delivery</div>
            <div className={`h4 mb-0 ${outForDelivery > 0 ? "text-primary" : ""}`}>{outForDelivery}</div>
            <small className="text-muted">couriers on the road</small>
          </button>
        </div>
        <div className="col-6 col-md-3">
          <button className="btn card text-start h-100 p-3 shadow-sm" onClick={() => onNavigate("inventory")}>
            <div className="small text-muted">Low stock</div>
            <div className={`h4 mb-0 ${(lowStockCount ?? 0) > 0 ? "text-danger" : ""}`}>{lowStockCount ?? "—"}</div>
            <small className="text-muted">at or below reorder</small>
          </button>
        </div>
      </div>

      {/* Order funnel — where orders sit right now */}
      <div className="card mb-3 shadow-sm">
        <div className="card-body py-2">
          <h6 className="card-title small fw-bold mb-1"><i className="bi bi-bezier2 me-1"></i>Order pipeline</h6>
          <div className="d-flex align-items-center gap-2 flex-wrap small">
            {[
              ["New", countOf("RECEIVED"), "text-bg-info"],
              ["Confirmed", countOf("CONFIRMED"), "text-bg-primary"],
              ["Prepping", countOf("PREPARING"), "text-bg-warning"],
              ["Ready", countOf("READY"), "text-bg-success"],
              ["Out for delivery", countOf("OUT_FOR_DELIVERY"), "text-bg-dark"],
              ["Delivered", countOf("DELIVERED"), "text-bg-secondary"],
              ["Completed", countOf("COMPLETED"), "text-bg-success"],
            ].map(([stage, cnt, tone], i) => (
              <div key={stage} className="d-flex align-items-center">
                {i > 0 && <i className="bi bi-caret-right-fill text-muted ms-1 me-1"></i>}
                <span className={`badge ${tone}`}>{cnt}</span>
                <span className="ms-1">{stage}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-md-8">
          <div className="card h-100">
            <div className="card-body">
              <h6 className="card-title small fw-bold">Revenue — last 7 days</h6>
              <BarChart data={chartData} />
            </div>
          </div>
        </div>
        <div className="col-md-4">
          <div className="card h-100">
            <div className="card-body">
              <h6 className="card-title small fw-bold"><i className="bi bi-cone-striped me-1"></i>Utang — at risk</h6>
              {utangMinor === null ? (
                <p className="text-muted small mb-0">Not available for this role.</p>
              ) : utangMinor === 0 ? (
                <p className="text-success mb-0"><i className="bi bi-check-lg me-1"></i>No outstanding balances.</p>
              ) : (
                <>
                  <div className="h4 text-danger">{toPesos(utangMinor)}</div>
                  <span className={`badge ${(utangOverdue ?? 0) > 0 ? "text-bg-danger" : "text-bg-success"}`}>
                    {utangOverdue ?? 0} overdue
                  </span>
                </>
              )}
              <button className="btn btn-sm btn-outline-warning mt-2" onClick={() => onNavigate("utang")}>
                <i className="bi bi-journal-text me-1"></i>Utang list
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Low-stock quick list */}
      {lowItems.length > 0 && (
        <div className="card mt-3">
          <div className="card-body">
            <h6 className="card-title small fw-bold"><i className="bi bi-exclamation-triangle me-1"></i>Low stock — fix soon</h6>
            <ul className="list-group list-group-flush small">
              {lowItems.map((it) => (
                <li key={it.name} className="list-group-item d-flex justify-content-between align-items-center">
                  <span>{it.name}</span>
                  <span className={`badge ${it.availableQuantity <= 0 ? "text-bg-danger" : "text-bg-warning"}`}>{it.availableQuantity} left</span>
                </li>
              ))}
            </ul>
            <button className="btn btn-sm btn-outline-secondary mt-2" onClick={() => onNavigate("inventory")}>
              View all {lowStockCount ?? 0} low items
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
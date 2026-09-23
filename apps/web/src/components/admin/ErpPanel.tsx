"use client";

// P9: ERP + BIR panel — chart of accounts, trial balance, income statement,
// BIR journal CSV downloads, e-invoice status, and one-click backfill.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

interface AccountRow { id: string; code: string; name: string; type: string; isActive: boolean }

interface TrialBalanceRow { code: string; name: string; type: string; debitMinor: number; creditMinor: number; balanceMinor: number }

interface IncomeStatement { revenueMinor: number; cogsMinor: number; expensesMinor: number; grossProfitMinor: number; netProfitMinor: number }

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

export default function ErpPanel() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [tb, setTb] = useState<{ rows: TrialBalanceRow[]; balanced: boolean } | null>(null);
  const [stmt, setStmt] = useState<IncomeStatement | null>(null);
  const [einv, setEinv] = useState<{ ready: boolean; pendingCredentials: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr(null);
    try {
      const [a, t, s, e] = await Promise.all([
        fetch(`${API_URL}/admin/erp/accounts`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/erp/trial-balance`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/erp/income-statement?from=${from}&to=${to}`, { headers: adminHeaders() }).then((r) => r.json()),
        fetch(`${API_URL}/admin/bir/einvoice/status`, { headers: adminHeaders() }).then((r) => r.json()),
      ]);
      setAccounts(a?.accounts ?? []);
      setTb(t ?? null);
      setStmt(s?.statement ?? null);
      setEinv(e ?? null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Load failed");
    }
  };

  useEffect(() => { void load(); }, [from, to]);

  const backfill = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API_URL}/admin/erp/backfill`, { method: "POST", headers: adminHeaders() });
      const d = await r.json();
      if (!r.ok) { setErr(d?.message ?? "Backfill failed"); return; }
      toast(`Posted ${d.orders} order(s) + ${d.expenses} expense(s)`);
      void load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Backfill failed");
    } finally {
      setBusy(false);
    }
  };

  const download = async (path: string, filename: string) => {
    setErr(null);
    try {
      const r = await fetch(`${API_URL}${path}?from=${from}&to=${to}`, { headers: adminHeaders() });
      const d = await r.json();
      if (!r.ok) { setErr(d?.message ?? "Export failed"); return; }
      const blob = new Blob([d.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = d.filename ?? filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Export failed");
    }
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h1 className="h4 mb-0">ERP &amp; BIR</h1>
        <div className="d-flex gap-2 align-items-center">
          <input className="form-control form-control-sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-muted small">to</span>
          <input className="form-control form-control-sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="btn btn-sm btn-outline-secondary" onClick={() => void backfill()} disabled={busy}>{busy ? "…" : "Backfill"}</button>
        </div>
      </div>
      {err && <div className="alert alert-danger py-2 small">{err}</div>}

      <div className="row g-3 mb-3">
        <div className="col-md-6 col-xl-3">
          <div className="card h-100"><div className="card-body">
            <h6 className="card-title small fw-bold">Revenue</h6>
            <div className="h4 mb-0">{toPesos(stmt?.revenueMinor ?? 0)}</div>
          </div></div>
        </div>
        <div className="col-md-6 col-xl-3">
          <div className="card h-100"><div className="card-body">
            <h6 className="card-title small fw-bold">COGS</h6>
            <div className="h4 mb-0">{toPesos(stmt?.cogsMinor ?? 0)}</div>
          </div></div>
        </div>
        <div className="col-md-6 col-xl-3">
          <div className="card h-100"><div className="card-body">
            <h6 className="card-title small fw-bold">Expenses</h6>
            <div className="h4 mb-0">{toPesos(stmt?.expensesMinor ?? 0)}</div>
          </div></div>
        </div>
        <div className="col-md-6 col-xl-3">
          <div className={`card h-100 ${(stmt?.netProfitMinor ?? 0) < 0 ? "border-danger" : ""}`}><div className="card-body">
            <h6 className="card-title small fw-bold">Net profit</h6>
            <div className={`h4 mb-0 ${(stmt?.netProfitMinor ?? 0) < 0 ? "text-danger" : "text-success"}`}>{toPesos(stmt?.netProfitMinor ?? 0)}</div>
          </div></div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-6">
          <div className="card h-100">
            <div className="card-body">
              <h6 className="card-title small fw-bold">Trial balance {tb && <span className={`badge ms-1 ${tb.balanced ? "text-bg-success" : "text-bg-danger"}`}>{tb.balanced ? "balanced" : "UNBALANCED"}</span>}</h6>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <table className="table table-sm align-middle mb-0">
                  <thead><tr><th>Code</th><th>Account</th><th className="text-end">Debit</th><th className="text-end">Credit</th><th className="text-end">Balance</th></tr></thead>
                  <tbody>
                    {(tb?.rows ?? []).map((r) => (
                      <tr key={r.code}>
                        <td className="small text-muted">{r.code}</td>
                        <td className="small">{r.name} <span className="text-muted text-opacity-75">· {r.type}</span></td>
                        <td className="text-end small">{toPesos(r.debitMinor)}</td>
                        <td className="text-end small">{toPesos(r.creditMinor)}</td>
                        <td className={`text-end small fw-semibold ${r.balanceMinor < 0 ? "text-danger" : ""}`}>{toPesos(r.balanceMinor)}</td>
                      </tr>
                    ))}
                    {(tb?.rows ?? []).length === 0 && <tr><td colSpan={5} className="text-muted small">No postings yet — run Backfill.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <div className="col-lg-6">
          <div className="card h-100">
            <div className="card-body">
              <h6 className="card-title small fw-bold">Chart of accounts</h6>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <table className="table table-sm align-middle mb-0">
                  <thead><tr><th>Code</th><th>Name</th><th>Type</th></tr></thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}><td className="small text-muted">{a.code}</td><td className="small">{a.name}</td><td><span className="badge text-bg-light border">{a.type}</span></td></tr>
                    ))}
                    {accounts.length === 0 && <tr><td colSpan={3} className="text-muted small">Chart not seeded yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              <hr className="my-2" />
              <h6 className="card-title small fw-bold">BIR exports</h6>
              <div className="d-flex gap-2 flex-wrap">
                <button className="btn btn-sm btn-outline-primary" onClick={() => void download("/admin/bir/sales-journal", "sales-journal.csv")}><i className="bi bi-download me-1"></i>Sales Journal CSV</button>
                <button className="btn btn-sm btn-outline-primary" onClick={() => void download("/admin/bir/cash-receipts-journal", "cash-receipts.csv")}><i className="bi bi-download me-1"></i>Cash Receipts Journal CSV</button>
              </div>
              <div className="small mt-2">
                e-invoice: <span className={`badge ${einv?.ready ? "text-bg-success" : "text-bg-warning"}`}>{einv?.ready ? "ready" : "PENDING_CREDENTIALS"}</span>
                <span className="text-muted"> (BIR CSF adapter; configure BIR_CSF_CREDENTIALS to enable)</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
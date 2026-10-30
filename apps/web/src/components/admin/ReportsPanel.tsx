"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, getAdminRole, getAdminStoreId, roleCan } from "../../lib/admin";
import NoStoreScope from "./NoStoreScope";
import { peso } from "../../lib/number-format";

interface ProfitData {
  revenueMinor: number; refundsMinor: number; netRevenueMinor: number;
  cogsMinor: number; cogsEstimatedUnits: number; expensesMinor: number;
  profitMinor: number; ordersCount: number; cogsNote: string;
}
interface SalesData {
  paymentSplit: { method: string; totalMinor: number }[];
  topCustomers: { name: string; totalMinor: number; orders: number }[];
  utangAging: { currentMinor: number; over30Minor: number; rows: { name: string; balanceMinor: number; daysOld: number; bucket: string }[] };
}
interface StockLowRow { id: string; name: string; sku: string; barcode: string | null; unit: string | null; availableQuantity: number; reorderThreshold: number }
interface SoldStockRow { name: string; sku: string; sold: number }
interface IncomeLossData { income: { revenueMinor: number; refundsMinor: number; netRevenueMinor: number; ordersCount: number }; expenses: { totalMinor: number; byCategory: Record<string, number>; lineItems: { category: string; amountMinor: number; note: string | null }[] }; cogsMinor: number; profitMinor: number }
interface SalesByPaymentRow { method: string; totalMinor: number; orders: number; avgMinor: number }
interface CustomerStatementRow { name: string; totalPaidMinor: number; creditBalanceMinor: number; balanceMinor: number; orders: number; firstOrderAt: string | null; lastOrderAt: string | null }

type ReportTab = "profit" | "sales" | "stock-low" | "sold-stock" | "income-loss" | "sales-by-payment" | "customer-statement";

const toPesos = (m: number) => peso(m);

export default function ReportsPanel() {
  const storeId = getAdminStoreId();
  const [days, setDays] = useState(30);
  const [activeTab, setActiveTab] = useState<ReportTab>(roleCan(getAdminRole(), "profit") ? "profit" : "sales");
  const [profit, setProfit] = useState<ProfitData | null>(null);
  const [sales, setSales] = useState<SalesData | null>(null);
  const [stockLow, setStockLow] = useState<{ rows: StockLowRow[]; count: number } | null>(null);
  const [soldStock, setSoldStock] = useState<{ rows: SoldStockRow[]; totalUnitsSold: number } | null>(null);
  const [incomeLoss, setIncomeLoss] = useState<IncomeLossData | null>(null);
  const [salesByPayment, setSalesByPayment] = useState<{ rows: SalesByPaymentRow[]; grandTotal: number } | null>(null);
  const [customerStatement, setCustomerStatement] = useState<{ rows: CustomerStatementRow[]; totalPaidMinor: number; totalCreditMinor: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const role = getAdminRole();
  const canProfit = roleCan(role, "profit");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    try {
      if (canProfit && activeTab === "profit") {
        const pRes = await fetch(`${API_URL}/admin/reports/profit?${q.toString()}`, { headers: adminHeaders() });
        if (pRes.ok) setProfit(await pRes.json()); else setError((await pRes.json())?.message ?? "Profit report unavailable");
      }
      if (activeTab === "sales") {
        const sRes = await fetch(`${API_URL}/admin/reports/sales?${q.toString()}`, { headers: adminHeaders() });
        if (sRes.ok) setSales(await sRes.json());
      }
      if (activeTab === "stock-low") {
        const r = await fetch(`${API_URL}/admin/reports/stock-low?${q.toString()}`, { headers: adminHeaders() });
        if (r.ok) setStockLow(await r.json());
      }
      if (activeTab === "sold-stock") {
        const r = await fetch(`${API_URL}/admin/reports/sold-stock?${q.toString()}`, { headers: adminHeaders() });
        if (r.ok) setSoldStock(await r.json());
      }
      if (activeTab === "income-loss") {
        const r = await fetch(`${API_URL}/admin/reports/income-loss?${q.toString()}`, { headers: adminHeaders() });
        if (r.ok) setIncomeLoss(await r.json());
      }
      if (activeTab === "sales-by-payment") {
        const r = await fetch(`${API_URL}/admin/reports/sales-by-payment?${q.toString()}`, { headers: adminHeaders() });
        if (r.ok) setSalesByPayment(await r.json());
      }
      if (activeTab === "customer-statement") {
        const r = await fetch(`${API_URL}/admin/reports/customer-statement?${q.toString()}`, { headers: adminHeaders() });
        if (r.ok) setCustomerStatement(await r.json());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally { setLoading(false); }
  }, [days, activeTab, canProfit]);

  useEffect(() => { if (storeId) load(); }, [load, storeId]);

  if (!storeId) return <NoStoreScope />;

  // B7: the CSV route reads from/to (reports.controller.ts:83-85), not days — send the
  // same window the on-screen report uses, computed client-side as ISO dates.
  const exportProfit = () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    window.open(`${API_URL}/admin/reports/profit.csv?${q.toString()}`, "_blank");
  };
  const print = () => window.print();

  // Counter staff see sales and stock reports only — no profit, cost or income figures.
  const reportTabs: { id: ReportTab; label: string }[] = ([
    { id: "profit", label: "Profit" },
    { id: "sales", label: "Sales" },
    { id: "stock-low", label: "Stock low" },
    { id: "sold-stock", label: "Sold stock" },
    { id: "income-loss", label: "Income & Loss" },
    { id: "sales-by-payment", label: "Sales by payment" },
    { id: "customer-statement", label: "Customer statement" },
  ] as { id: ReportTab; label: string }[]).filter((t) => canProfit || ["sales", "stock-low", "sold-stock", "sales-by-payment"].includes(t.id));

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h1 className="h4 mb-0"><i className="bi bi-graph-up me-2"></i>Reports</h1>
        <div className="d-flex gap-2">
          <select className="form-select form-select-sm" style={{ width: 150 }} aria-label="Period" value={days} onChange={(e) => setDays(parseInt(e.target.value, 10))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          {canProfit && activeTab === "profit" && (
            <button className="btn btn-outline-secondary btn-sm" onClick={exportProfit}><i className="bi bi-filetype-csv me-1"></i>CSV</button>
          )}
          <button className="btn btn-outline-secondary btn-sm" onClick={print}><i className="bi bi-printer me-1"></i>Print</button>
        </div>
      </div>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      <ul className="nav nav-tabs mb-3">
        {reportTabs.map((t) => (
          <li className="nav-item" key={t.id}>
            <button className={`nav-link ${activeTab === t.id ? "active" : ""}`} onClick={() => setActiveTab(t.id)}>{t.label}</button>
          </li>
        ))}
      </ul>

      {loading ? <p className="text-muted">Loading…</p> : (
        <>
          {activeTab === "profit" && profit && (
            <div className="row g-3 mb-3">
              <div className="col-6 col-md-3"><div className="card h-100"><div className="card-body text-center"><div className="small text-muted">Revenue (fulfilled)</div><div className="h4 mb-0">{toPesos(profit.netRevenueMinor)}</div><div className="small text-muted">{profit.ordersCount} orders{profit.refundsMinor > 0 ? ` · refunds ${toPesos(profit.refundsMinor)}` : ""}</div></div></div></div>
              <div className="col-6 col-md-3"><div className="card h-100"><div className="card-body text-center"><div className="small text-muted">COGS (estimate)</div><div className="h4 mb-0">{toPesos(profit.cogsMinor)}</div></div></div></div>
              <div className="col-6 col-md-3"><div className="card h-100"><div className="card-body text-center"><div className="small text-muted">Expenses</div><div className="h4 mb-0">{toPesos(profit.expensesMinor)}</div></div></div></div>
              <div className="col-6 col-md-3"><div className={`card h-100 ${profit.profitMinor < 0 ? "border-danger" : ""}`}><div className="card-body text-center"><div className="small text-muted">Profit (estimate)</div><div className={`h4 mb-0 ${profit.profitMinor < 0 ? "text-danger" : "text-success"}`}>{toPesos(profit.profitMinor)}</div></div></div></div>
              <div className="col-12"><p className="small text-muted mb-0"><i className="bi bi-info-circle me-1"></i>{profit.cogsNote}</p></div>
            </div>
          )}

          {activeTab === "sales" && sales && (
            <div className="row g-3">
              <div className="col-md-4"><div className="card h-100"><div className="card-body"><h6 className="card-title small fw-bold">Payment split</h6>{sales.paymentSplit.length === 0 ? <p className="text-muted small">No fulfilled orders in this period.</p> : (<table className="table table-sm mb-0"><tbody>{sales.paymentSplit.map((s) => (<tr key={s.method}><td className="text-capitalize">{s.method}</td><td className="text-end">{toPesos(s.totalMinor)}</td></tr>))}</tbody></table>)}</div></div></div>
              <div className="col-md-4"><div className="card h-100"><div className="card-body"><h6 className="card-title small fw-bold">Credit aging</h6><div className="small"><div className="d-flex justify-content-between"><span>Current (&le;30d)</span><span>{toPesos(sales.utangAging.currentMinor)}</span></div><div className="d-flex justify-content-between text-danger"><span>Over 30 days</span><span>{toPesos(sales.utangAging.over30Minor)}</span></div></div><ul className="small text-muted mb-0 mt-2">{sales.utangAging.rows.slice(0, 5).map((r) => (<li key={r.name}>{r.name} — {toPesos(r.balanceMinor)} ({r.daysOld}d)</li>))}{sales.utangAging.rows.length === 0 && <li>No outstanding balances.</li>}</ul></div></div></div>
              <div className="col-md-4"><div className="card h-100"><div className="card-body"><h6 className="card-title small fw-bold">Top customers</h6>{sales.topCustomers.length === 0 ? <p className="text-muted small">No data.</p> : (<table className="table table-sm mb-0"><tbody>{sales.topCustomers.slice(0, 5).map((c) => (<tr key={c.name}><td>{c.name}</td><td className="text-end">{toPesos(c.totalMinor)}</td><td className="text-end text-muted small">{c.orders} orders</td></tr>))}</tbody></table>)}</div></div></div>
            </div>
          )}

          {activeTab === "stock-low" && (
            <div>
              {stockLow && stockLow.count === 0 && <p className="text-muted">No low-stock products in this period.</p>}
              {stockLow && stockLow.count > 0 && (
                <table className="table table-hover align-middle"><thead><tr><th>Product</th><th>SKU</th><th className="text-end">Available</th><th className="text-end">Threshold</th><th>Unit</th></tr></thead><tbody>{stockLow.rows.map((r) => (<tr key={r.id}><td>{r.name}</td><td className="small text-muted">{r.sku}</td><td className="text-end text-danger fw-semibold">{r.availableQuantity}</td><td className="text-end">{r.reorderThreshold}</td><td className="small">{r.unit ?? "—"}</td></tr>))}</tbody></table>
              )}
            </div>
          )}

          {activeTab === "sold-stock" && (
            <div>
              {soldStock && soldStock.rows.length === 0 && <p className="text-muted">No fulfilled orders in this period.</p>}
              {soldStock && soldStock.rows.length > 0 && (
                <>
                  <p className="small text-muted mb-2">Total units sold: <strong>{soldStock.totalUnitsSold}</strong></p>
                  <table className="table table-hover align-middle"><thead><tr><th>Product</th><th>SKU</th><th className="text-end">Units sold</th></tr></thead><tbody>{soldStock.rows.map((r) => (<tr key={`${r.sku}-${r.name}`}><td>{r.name}</td><td className="small text-muted">{r.sku}</td><td className="text-end fw-semibold">{r.sold}</td></tr>))}</tbody></table>
                </>
              )}
            </div>
          )}

          {activeTab === "income-loss" && incomeLoss && (
            <div className="row g-3">
              <div className="col-md-6"><div className="card"><div className="card-body"><h6 className="card-title small fw-bold">Income</h6><div className="small">Revenue: <strong>{toPesos(incomeLoss.income.revenueMinor)}</strong></div><div className="small">Refunds: {toPesos(incomeLoss.income.refundsMinor)}</div><div className="small">Net revenue: <strong>{toPesos(incomeLoss.income.netRevenueMinor)}</strong></div><div className="small text-muted">{incomeLoss.income.ordersCount} fulfilled orders</div></div></div></div>
              <div className="col-md-6"><div className="card"><div className="card-body"><h6 className="card-title small fw-bold">Expenses</h6>{Object.entries(incomeLoss.expenses.byCategory).map(([cat, amt]) => (<div key={cat} className="d-flex justify-content-between small"><span className="text-capitalize">{cat}</span><strong>{toPesos(amt)}</strong></div>))}<hr className="my-1" /><div className="d-flex justify-content-between small"><span>Total expenses</span><strong>{toPesos(incomeLoss.expenses.totalMinor)}</strong></div></div></div></div>
              <div className="col-12"><div className="card"><div className="card-body"><h6 className="card-title small fw-bold">Summary</h6><div className="d-flex justify-content-between"><span>COGS (estimate)</span><span>{toPesos(incomeLoss.cogsMinor)}</span></div><div className="d-flex justify-content-between"><span>Net profit</span><strong className={incomeLoss.profitMinor < 0 ? "text-danger" : "text-success"}>{toPesos(incomeLoss.profitMinor)}</strong></div></div></div></div>
            </div>
          )}

          {activeTab === "sales-by-payment" && salesByPayment && (
            <div>
              {salesByPayment.rows.length === 0 && <p className="text-muted">No fulfilled orders in this period.</p>}
              {salesByPayment.rows.length > 0 && (
                <>
                  <p className="small text-muted mb-2">Grand total: <strong>{toPesos(salesByPayment.grandTotal)}</strong></p>
                  <table className="table table-hover align-middle"><thead><tr><th>Method</th><th className="text-end">Total</th><th className="text-end">Orders</th><th className="text-end">Avg</th></tr></thead><tbody>{salesByPayment.rows.map((r) => (<tr key={r.method}><td className="text-capitalize">{r.method}</td><td className="text-end">{toPesos(r.totalMinor)}</td><td className="text-end">{r.orders}</td><td className="text-end">{toPesos(r.avgMinor)}</td></tr>))}</tbody></table>
                </>
              )}
            </div>
          )}

          {activeTab === "customer-statement" && customerStatement && (
            <div>
              {customerStatement.rows.length === 0 && <p className="text-muted">No fulfilled orders in this period.</p>}
              {customerStatement.rows.length > 0 && (
                <>
                  <p className="small text-muted mb-2">Total paid: {toPesos(customerStatement.totalPaidMinor)} · Total credit: {toPesos(customerStatement.totalCreditMinor)}</p>
                  <table className="table table-hover align-middle"><thead><tr><th>Customer</th><th className="text-end">Paid</th><th className="text-end">Credit</th><th className="text-end">Balance</th><th className="text-end">Orders</th></tr></thead><tbody>{customerStatement.rows.map((r) => (<tr key={r.name}><td>{r.name}</td><td className="text-end">{toPesos(r.totalPaidMinor)}</td><td className="text-end">{toPesos(r.creditBalanceMinor)}</td><td className={`text-end fw-semibold ${r.balanceMinor < 0 ? "text-danger" : "text-success"}`}>{toPesos(r.balanceMinor)}</td><td className="text-end">{r.orders}</td></tr>))}</tbody></table>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
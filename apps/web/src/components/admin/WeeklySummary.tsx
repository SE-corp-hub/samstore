"use client";

// Weekly owner summary (owner and manager): the 7 days ending on the chosen day against the 7 before.
// Sales by store, credit, what Store 2 owes, what is owed to suppliers, count shortages by reason, what is running out. Print.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { printSlip } from "../../lib/slip-print";

interface Store { id: string; name: string; thisMinor: number; lastMinor: number; changePct: number | null; count: number; profitMinor: number }
interface Consignment { id: string; name: string; owesMinor: number; paidThisWeekMinor: number; lastPaymentAt: string | null; daysSincePayment: number | null; late: boolean }
interface Supplier { id: string; name: string; owedMinor: number; overdueOrders: number }
interface Reason { code: string; label: string; items: number; shortValueMinor: number; overValueMinor: number }
interface Running { productId: string; name: string; loose: boolean; urgency: "OUT" | "NOW" | "SOON"; daysLeft: number | null; suggestedQty: number }
interface Data {
  from: string; to: string; lastFrom: string; lastTo: string;
  sales: { stores: Store[]; total: { thisMinor: number; lastMinor: number; changePct: number | null; count: number; profitMinor: number } };
  credit: { givenMinor: number; collectedMinor: number; owedNowMinor: number; customersOwing: number };
  consignment: Consignment[];
  suppliers: { owedMinor: number; pendingMinor: number; lateOrders: number; top: Supplier[] };
  counts: { counts: number; items: number; short: number; over: number; kulangValueMinor: number; sobraValueMinor: number; byReason: Reason[] };
  running: { total: number; items: Running[] };
}

const peso = (m: number) => `₱${(Math.abs(m) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayStr = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const nice = (d: string) => new Date(`${d}T12:00:00+08:00`).toLocaleDateString("en-PH", { day: "numeric", month: "short" });
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" }) : "never");
const pctText = (p: number | null) => (p === null ? "no sales last week" : p === 0 ? "same as last week" : `${p > 0 ? "up" : "down"} ${Math.abs(p)}% on last week`);
const qty = (loose: boolean, n: number) => (loose ? `${(n / 1000).toLocaleString("en-PH", { maximumFractionDigits: 1 })} kg` : n.toLocaleString("en-PH"));
const URGENCY = { OUT: "Out", NOW: "Order now", SOON: "Soon" } as const;

export default function WeeklySummary({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (day: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/rice/weekly?to=${encodeURIComponent(day)}`, { headers: adminHeaders() });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.errors?.join(", ") ?? body?.message ?? "Could not load the summary"); setData(null); return; }
      setData(body as Data);
    } catch { setError("Could not load the summary"); setData(null); } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(todayStr()); }, [load]);

  const printIt = () => {
    if (!data) return;
    const d = data;
    printSlip({
      storeName: "Weekly summary", title: `${nice(d.from)} to ${nice(d.to)}`, a4: true, when: new Date().toLocaleString("en-PH"),
      lines: [
        { label: "Sales this week", value: peso(d.sales.total.thisMinor) },
        { label: "Sales last week", value: peso(d.sales.total.lastMinor) },
        { label: "Profit this week", value: peso(d.sales.total.profitMinor) },
        { label: "Credit given", value: peso(d.credit.givenMinor) },
        { label: "Credit collected", value: peso(d.credit.collectedMinor) },
        { label: "Customers owe now", value: peso(d.credit.owedNowMinor) },
        { label: "You owe suppliers", value: peso(d.suppliers.owedMinor) },
        ...d.consignment.map((c) => ({ label: `${c.name} owes`, value: peso(c.owesMinor) })),
      ],
      rows: [
        ...d.sales.stores.map((s) => ({ name: `Sales: ${s.name}`, qty: `${peso(s.thisMinor)} (${pctText(s.changePct)})` })),
        ...d.counts.byReason.map((r) => ({ name: `Count: ${r.label}`, qty: `short ${peso(r.shortValueMinor)}, over ${peso(r.overValueMinor)}` })),
        ...d.running.items.map((r) => ({ name: `Running out: ${r.name}`, qty: `${URGENCY[r.urgency]}${r.daysLeft !== null ? `, ${r.daysLeft} days left` : ""}` })),
      ],
    });
  };

  const upDown = (p: number | null) => (p === null ? "text-muted" : p > 0 ? "text-success" : p < 0 ? "text-danger" : "text-muted");

  return (
    <div>
      <p className="text-muted small">The 7 days ending on the day you choose, against the 7 days before. Read-only.</p>
      <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
        <div>
          <label className="form-label small mb-1" htmlFor="wk-to">Week ending</label>
          <input id="wk-to" type="date" className="form-control" value={to} max={todayStr()} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary" disabled={busy || !to} onClick={() => void load(to)}>{busy ? "Please wait…" : "Show"}</button>
        <button type="button" className="btn btn-outline-dark" disabled={!data} onClick={printIt}>Print</button>
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {data && (
        <div className="d-flex flex-column gap-3">
          <div className="small text-muted">{nice(data.from)} to {nice(data.to)} (last week: {nice(data.lastFrom)} to {nice(data.lastTo)})</div>

          <section className="border rounded p-3">
            <h2 className="h6">Sales</h2>
            <div className="fs-3 fw-semibold">{peso(data.sales.total.thisMinor)}</div>
            <div className={`small ${upDown(data.sales.total.changePct)}`}>{pctText(data.sales.total.changePct)} ({peso(data.sales.total.lastMinor)}) · {data.sales.total.count} sale{data.sales.total.count === 1 ? "" : "s"} · profit {peso(data.sales.total.profitMinor)}</div>
            <div className="table-responsive mt-2">
              <table className="table table-sm mb-0">
                <thead><tr><th>Store</th><th className="text-end">This week</th><th className="text-end">Last week</th><th className="text-end">Change</th><th className="text-end">Sales</th></tr></thead>
                <tbody>{data.sales.stores.map((s) => (
                  <tr key={s.id}><td>{s.name}</td><td className="text-end">{peso(s.thisMinor)}</td><td className="text-end">{peso(s.lastMinor)}</td>
                    <td className={`text-end ${upDown(s.changePct)}`}>{s.changePct === null ? "" : `${s.changePct > 0 ? "+" : s.changePct < 0 ? "−" : ""}${Math.abs(s.changePct)}%`}</td><td className="text-end">{s.count}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <section className="border rounded p-3">
            <h2 className="h6">Credit</h2>
            <div className="row g-2">
              <div className="col-6 col-md-3"><div className="small text-muted">Given this week</div><div className="fw-semibold">{peso(data.credit.givenMinor)}</div></div>
              <div className="col-6 col-md-3"><div className="small text-muted">Collected this week</div><div className="fw-semibold">{peso(data.credit.collectedMinor)}</div></div>
              <div className="col-6 col-md-3"><div className="small text-muted">Customers owe now</div><div className="fw-semibold">{peso(data.credit.owedNowMinor)}</div></div>
              <div className="col-6 col-md-3"><div className="small text-muted">Customers who owe</div><div className="fw-semibold">{data.credit.customersOwing}</div></div>
            </div>
          </section>

          {data.consignment.length > 0 && (
            <section className="border rounded p-3">
              <h2 className="d-flex justify-content-between h6">
                <span>Consignment store</span>
                {onNavigate && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => onNavigate("payable")}>Open Store payable</button>}
              </h2>
              {data.consignment.map((c) => (
                <div key={c.id} className="d-flex flex-wrap justify-content-between gap-2 py-1">
                  <div>
                    <span className="fw-semibold">{c.name}</span> owes <span className="fw-semibold">{peso(c.owesMinor)}</span>
                    {c.late && <span className="badge text-bg-danger ms-2">Payment late</span>}
                  </div>
                  <div className="small text-muted">
                    Paid this week {peso(c.paidThisWeekMinor)} · last payment {when(c.lastPaymentAt)}{c.daysSincePayment !== null ? ` (${c.daysSincePayment} day${c.daysSincePayment === 1 ? "" : "s"} ago)` : ""}
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="border rounded p-3">
            <h2 className="d-flex justify-content-between h6">
              <span>Suppliers</span>
              {onNavigate && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => onNavigate("purchaseorders")}>Open Supplier orders</button>}
            </h2>
            <div>You owe suppliers <span className="fw-semibold">{peso(data.suppliers.owedMinor)}</span> · still on order {peso(data.suppliers.pendingMinor)}{data.suppliers.lateOrders > 0 ? <span className="badge text-bg-danger ms-2">{data.suppliers.lateOrders} late order{data.suppliers.lateOrders === 1 ? "" : "s"}</span> : null}</div>
            {data.suppliers.top.length > 0 && (
              <ul className="small mb-0 mt-1">{data.suppliers.top.map((s) => <li key={s.id}>{s.name}: {peso(s.owedMinor)}{s.overdueOrders > 0 ? ` · ${s.overdueOrders} late` : ""}</li>)}</ul>
            )}
          </section>

          <section className="border rounded p-3">
            <h2 className="h6">Counts this week</h2>
            {data.counts.counts === 0 ? <div className="text-muted">No counts were submitted this week.</div> : (
              <>
                <div>{data.counts.counts} count{data.counts.counts === 1 ? "" : "s"}, {data.counts.items} items · short {peso(data.counts.kulangValueMinor)} · over {peso(data.counts.sobraValueMinor)}</div>
                {data.counts.byReason.length > 0 && (
                  <div className="table-responsive mt-2"><table className="table table-sm mb-0">
                    <thead><tr><th>Reason</th><th className="text-end">Items</th><th className="text-end">Short</th><th className="text-end">Over</th></tr></thead>
                    <tbody>{data.counts.byReason.map((r) => <tr key={r.code}><td>{r.label}</td><td className="text-end">{r.items}</td><td className="text-end">{r.shortValueMinor ? peso(r.shortValueMinor) : ""}</td><td className="text-end">{r.overValueMinor ? peso(r.overValueMinor) : ""}</td></tr>)}</tbody>
                  </table></div>
                )}
              </>
            )}
          </section>

          <section className="border rounded p-3">
            <h2 className="d-flex justify-content-between h6">
              <span>Running out</span>
              {onNavigate && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => onNavigate("purchaseorders")}>Open Supplier orders, To reorder</button>}
            </h2>
            {data.running.total === 0 ? <div className="text-muted">Nothing is about to run out.</div> : (
              <>
                <div className="small text-muted mb-1">{data.running.total} item{data.running.total === 1 ? "" : "s"} would run out within a week at the recent pace.</div>
                <ul className="mb-0">{data.running.items.map((r) => (
                  <li key={r.productId}>{r.name} <span className={`badge ${r.urgency === "OUT" ? "text-bg-danger" : r.urgency === "NOW" ? "text-bg-warning" : "text-bg-secondary"}`}>{URGENCY[r.urgency]}</span>
                    <span className="small text-muted"> {r.daysLeft !== null ? `${r.daysLeft} days left · ` : ""}order about {qty(r.loose, r.suggestedQty)}</span></li>
                ))}</ul>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

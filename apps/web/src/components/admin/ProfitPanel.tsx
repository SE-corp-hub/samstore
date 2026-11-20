"use client";

// Profit (Reports → Profit, owner and manager): one screen that answers "how much did we earn?"
//   1. the whole business first, in big numbers;
//   2. then each store on its own card (Bogs and Lucy, Bahay Tindahan, Lipa, …);
//   3. "How is this counted?" says in plain words why the whole is not double counted.
// The numbers come from GET /admin/rice/store-compare (the same reading as Store report → Compare stores),
// so this screen and that table always agree.
//
// Why the whole business is not counted twice: a store's profit is its sales less the cost of the rice it
// sold, plus or minus the profit shares between stores (when the main store takes rice from Bahay Tindahan,
// the share it pays is taken off the main store and added to Bahay Tindahan; see payable/charges.ts). Shares
// cancel when the stores are added up, and the cost a consignment store pays the main store for its rice is
// never counted as profit anywhere. So the whole = all sales − cost of all rice sold − all expenses.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { kg, peso } from "../../lib/number-format";

interface Totals { count: number; totalMinor: number; costMinor?: number; grossProfitMinor?: number; profitShareMinor?: number }
interface StoreRow { location: { id: string; name: string; type: string }; sales: Totals; expensesMinor?: number; netProfitMinor?: number; /** Kilo rice inside the sales (sell per kilo). */ perKilo?: { grams: number; salesMinor: number; profitMinor?: number } }
interface CompareData {
  from: string; to: string; stores: StoreRow[];
  business?: { expensesMinor: number };
  total: { salesMinor: number; count: number; grossProfitMinor: number; expensesMinor?: number; netProfitMinor?: number };
}

type Period = "today" | "yesterday" | "week" | "month" | "lastmonth" | "pick";

/** Manila date (UTC+8) as YYYY-MM-DD, `back` days ago. */
const manila = (back = 0) => new Date(Date.now() + 8 * 3_600_000 - back * 86_400_000).toISOString().slice(0, 10);

function datesFor(p: Period): { from: string; to: string } {
  const t = manila();
  if (p === "yesterday") return { from: manila(1), to: manila(1) };
  if (p === "week") { const d = new Date(`${t}T00:00:00Z`); return { from: manila((d.getUTCDay() + 6) % 7), to: t }; }
  if (p === "month") return { from: `${t.slice(0, 7)}-01`, to: t };
  if (p === "lastmonth") {
    const first = new Date(`${t.slice(0, 7)}-01T00:00:00Z`);
    const lastDay = new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10);
    return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
  }
  return { from: t, to: t };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nice = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const periodText = (from: string, to: string) => (from === to ? nice(from) : `${nice(from)} to ${nice(to)}`);

/** "₱1,234.00" or "−₱1,234.00". */
const signed = (m: number) => `${m < 0 ? "−" : ""}${peso(Math.abs(m))}`;

const PERIODS: [Period, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"], ["lastmonth", "Last month"], ["pick", "Pick dates"]];

function Line({ label, value, minus, hint }: { label: string; value: number; minus?: boolean; hint?: string }) {
  return (
    <div className="profit-line">
      <span>{label}{hint && <span className="profit-hint">{hint}</span>}</span>
      <span className="profit-num">{minus ? `−${peso(Math.abs(value))}` : signed(value)}</span>
    </div>
  );
}

function NetLine({ value, big }: { value: number; big?: boolean }) {
  const loss = value < 0;
  return (
    <div className={`profit-net ${loss ? "is-loss" : "is-gain"}`}>
      <span>{loss ? "Loss" : "Net profit"}</span>
      <span className={`profit-num ${big ? "profit-big" : "profit-mid"}`}>{signed(value)}</span>
    </div>
  );
}

export default function ProfitPanel({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [period, setPeriod] = useState<Period>("today");
  const [range, setRange] = useState(() => datesFor("today"));
  const [data, setData] = useState<CompareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/rice/store-compare?from=${range.from}&to=${range.to}`, { headers: adminHeaders() });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.errors?.join(", ") ?? body?.message ?? "Could not load the profit");
      setData(body as CompareData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the profit");
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  const choose = (p: Period) => { setPeriod(p); if (p !== "pick") setRange(datesFor(p)); };

  // A place that sold nothing and spent nothing (the Bodega, usually) is left out so the cards stay few.
  const stores = (data?.stores ?? []).filter((s) => s.location.type === "STORE" || s.sales.count > 0 || (s.expensesMinor ?? 0) !== 0 || (s.sales.profitShareMinor ?? 0) !== 0);
  const left = (data?.stores ?? []).length - stores.length;
  const t = data?.total;
  const storeExpenses = (t?.expensesMinor ?? 0) - (data?.business?.expensesMinor ?? 0);

  return (
    <div className="profit-screen container-fluid py-3" style={{ maxWidth: 1120 }}>
      <h2 className="h4 mb-1">Profit</h2>
      <p className="mb-3">How much each store earned, and the whole business together.</p>

      <div className="profit-periods d-flex flex-wrap gap-2 mb-2" role="group" aria-label="Which days">
        {PERIODS.map(([k, label]) => (
          <button key={k} type="button" className={`btn ${period === k ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={period === k} onClick={() => choose(k)}>{label}</button>
        ))}
      </div>
      {period === "pick" && (
        <div className="d-flex flex-wrap gap-3 align-items-end mb-2">
          <div><label className="form-label mb-1" htmlFor="pf-from">From</label><input id="pf-from" type="date" className="form-control form-control-lg" value={range.from} max={manila()} onChange={(e) => e.target.value && setRange((r) => ({ from: e.target.value, to: e.target.value > r.to ? e.target.value : r.to }))} /></div>
          <div><label className="form-label mb-1" htmlFor="pf-to">To</label><input id="pf-to" type="date" className="form-control form-control-lg" value={range.to} min={range.from} max={manila()} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} /></div>
          <p className="mb-2 text-body-secondary">Up to 3 months at a time.</p>
        </div>
      )}
      <p className="profit-when mb-3" aria-live="polite">{loading ? "Loading…" : periodText(range.from, range.to)}</p>

      {error && (
        <div className="alert alert-danger d-flex flex-wrap align-items-center gap-2" role="alert">
          <span className="me-auto">{error}</span>
          <button type="button" className="btn btn-outline-dark" onClick={() => void load()}>Try again</button>
        </div>
      )}

      {data && t && t.netProfitMinor !== undefined && (
        <div style={{ opacity: loading ? 0.55 : 1 }}>
          <section className="profit-card profit-whole mb-3" aria-labelledby="pf-whole">
            <h3 className="h5 fw-bold mb-2" id="pf-whole"><i className="bi bi-buildings me-2" aria-hidden="true"></i>Whole business</h3>
            <div className="profit-whole-body">
            <NetLine value={t.netProfitMinor} big />
            <div className="profit-lines">
              <Line label="Sales, all stores" value={t.salesMinor} hint={`${t.count.toLocaleString("en-PH")} sale${t.count === 1 ? "" : "s"}`} />
              <Line label="Profit from rice sold" value={t.grossProfitMinor} hint="sales less what the rice cost" />
              <Line label="Less: store expenses" value={storeExpenses} minus />
              {(data.business?.expensesMinor ?? 0) !== 0 && <Line label="Less: business expenses" value={data.business?.expensesMinor ?? 0} minus hint="not for one store" />}
            </div>
            </div>
          </section>

          <h3 className="h5 fw-bold mb-2">Each store</h3>
          <div className="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-3 mb-3">
            {stores.map((s) => {
              const share = s.sales.profitShareMinor ?? 0;
              const fromSales = (s.sales.grossProfitMinor ?? 0) - share;
              return (
                <div className="col" key={s.location.id}>
                  <section className="profit-card h-100" aria-labelledby={`pf-${s.location.id}`}>
                    <h4 className="h5 fw-bold mb-2" id={`pf-${s.location.id}`}><i className="bi bi-shop me-2" aria-hidden="true"></i>{s.location.name}</h4>
                    <NetLine value={s.netProfitMinor ?? 0} />
                    <div className="profit-lines">
                      <Line label="Sales" value={s.sales.totalMinor} hint={`${s.sales.count.toLocaleString("en-PH")} sale${s.sales.count === 1 ? "" : "s"}`} />
                      <Line label="Profit from rice sold" value={fromSales} />
                      {share > 0 && <Line label="Plus: profit share received" value={share} hint="for rice the main store took from here" />}
                      {share < 0 && <Line label="Less: profit share paid" value={share} minus hint="for rice taken from another store" />}
                      <Line label="Less: expenses" value={s.expensesMinor ?? 0} minus />
                    </div>
                    {s.perKilo && s.perKilo.grams > 0 && (
                      <p className="small text-body-secondary mt-2 mb-0">
                        Of these, per kilo: {kg(s.perKilo.grams)} sold for {peso(s.perKilo.salesMinor)}{s.perKilo.profitMinor !== undefined && <>, profit {peso(s.perKilo.profitMinor)}</>}.
                      </p>
                    )}
                  </section>
                </div>
              );
            })}
          </div>
          {left > 0 && <p className="text-body-secondary">{left === 1 ? "1 place" : `${left} places`} with no sales and no expenses in these days {left === 1 ? "is" : "are"} not shown.</p>}

          <details className="profit-how mb-3">
            <summary>How is the whole business counted?</summary>
            <ul className="mt-2 mb-0">
              <li>Each store&apos;s profit = its sales, less what the rice it sold cost, less its own expenses.</li>
              <li>When Bahay Tindahan or Lipa sell rice from the main store, they pay the main store the <b>cost</b> only. That payment is not counted as profit anywhere, so it is not counted twice.</li>
              <li>When the main store takes rice from Bahay Tindahan, it pays Bahay Tindahan the profit Bahay Tindahan would have made. That share is taken off the main store and added to Bahay Tindahan. Added together, the shares cancel out.</li>
              <li>So the whole business = all sales − cost of all rice sold − all expenses (store expenses and expenses for the whole business).</li>
              <li>Walk-in sales that were not rung up in POS are not in these numbers.</li>
            </ul>
          </details>

          {onNavigate && (
            <div className="d-flex flex-wrap gap-2">
              <button type="button" className="btn btn-outline-primary" onClick={() => onNavigate("storereport")}>See sales of one store</button>
              <button type="button" className="btn btn-outline-primary" onClick={() => onNavigate("expenses")}>See expenses</button>
              <button type="button" className="btn btn-outline-primary" onClick={() => onNavigate("payable")}>Store payable</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

// Store report: every store on its own.
//   Stock left     what is on the shelf now, with the selling price and what it is worth
//   Sales          one store's sales for a day or a period: by payment, by item, by day
//   Compare        all stores side by side (owner / manager)
//   End of day     the day's summary for one store, ready to print; closing is in Reports & closing
// Staff see their own store and no cost or profit.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { printSlip, type Slip } from "../../lib/slip-print";
import StoreBar from "./StoreBar";
import { peso, kg } from "../../lib/number-format";

const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

interface Place { id: string; name: string; code: string | null; isActive: boolean; type?: string }
type Tab = "stock" | "sales" | "records" | "compare" | "day" | "buffer";

interface StockRow { productId: string; name: string; loose: boolean; unit: string; onHand: number; reserved: number; available: number; daysLeft?: number | null; flag: "ZERO" | "LOW" | "OK"; unitPriceMinor: number; valueMinor: number; costValueMinor?: number }
interface StockData { location: { id: string; name: string }; rows: StockRow[]; totals: { items: number; low: number; empty: number; valueMinor: number; costValueMinor?: number } }
interface SalesTotals { count: number; totalMinor: number; cashMinor: number; gcashMinor: number; creditMinor: number; otherMinor: number; costMinor?: number; grossProfitMinor?: number }
interface SalesData { location: { id: string; name: string }; from: string; to: string; sales: SalesTotals; cashInMinor: number; creditGivenMinor: number; creditCollectedMinor: number; items: { name: string; unit: string; quantity: number; salesMinor: number; profitMinor?: number }[]; days: { date: string; count: number; totalMinor: number }[] }
interface CompareData { from: string; to: string; stores: { location: { id: string; name: string; type: string }; sales: SalesTotals; cashInMinor: number; creditGivenMinor: number; creditCollectedMinor: number; stock: { items: number; low: number; empty: number; valueMinor: number }; owesMinor: number }[]; total: { salesMinor: number; count: number; grossProfitMinor: number; creditGivenMinor: number; stockValueMinor: number; owesMinor: number } }
interface BufferData { buffer: { id: string; name: string } | null; owed: { productId: string; name: string; unit: string; quantity: number; valueMinor: number; oldestAt: string | null }[]; surplus: { productId: string; name: string; unit: string; quantity: number }[]; totals: { owedMinor: number; owedItems: number }; entries: { at: string; productName: string; unit: string; quantity: number; orderNumber: string | null; store: string | null; by: string | null; what: string }[] }
interface RecordRow { at: string; kind: "SALE" | "STOCK" | "MONEY"; title: string; detail: string; store: string | null; docNumber: string | null; amountMinor: number | null; qtyText: string | null; balanceText: string | null; by: string | null }
interface DaySection { location: { id: string; name: string }; locked: boolean; closedAt: string | null; cashCountedMinor: number | null; cashVarianceMinor: number | null; sales: { count: number; totalMinor: number; cashMinor: number; gcashMinor: number; utangMinor: number }; cash: { expectedMinor: number }; utang: { givenMinor: number; collectedMinor: number }; stockIn: { documents: number; units: number }; kilosByVariety: { variety: string; grams: number; salesMinor: number }[] }

/** Best-first by amount, quantity or profit; or the slowest sellers first. */
function rankedItems<T extends { quantity: number; salesMinor: number; profitMinor?: number }>(items: T[], by: "sales" | "qty" | "profit" | "slow"): T[] {
  const list = [...items];
  if (by === "qty") return list.sort((a, b) => b.quantity - a.quantity);
  if (by === "profit") return list.sort((a, b) => (b.profitMinor ?? 0) - (a.profitMinor ?? 0));
  if (by === "slow") return list.sort((a, b) => a.salesMinor - b.salesMinor);
  return list.sort((a, b) => b.salesMinor - a.salesMinor);
}

/** Add the days up into weeks (starting Monday) or months. */
function groupDays(days: { date: string; count: number; totalMinor: number }[], by: "day" | "week" | "month") {
  if (by === "day") return days.map((d) => ({ label: d.date, count: d.count, totalMinor: d.totalMinor }));
  const out = new Map<string, { label: string; count: number; totalMinor: number }>();
  for (const d of days) {
    const dt = new Date(`${d.date}T00:00:00Z`);
    const key = by === "month" ? d.date.slice(0, 7) : new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const cur = out.get(key) ?? { label: by === "month" ? key : `Week of ${key}`, count: 0, totalMinor: 0 };
    cur.count += d.count; cur.totalMinor += d.totalMinor;
    out.set(key, cur);
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([, v]) => v);
}

const qtyText = (r: StockRow) => (r.loose ? kg(r.onHand) : `${r.onHand.toLocaleString("en-PH")} pcs`);
const flagBadge = (f: StockRow["flag"]) => (f === "ZERO" ? <span className="badge text-bg-danger">Out</span> : f === "LOW" ? <span className="badge text-bg-warning">Low</span> : null);

async function getJson<T>(path: string): Promise<{ ok: boolean; data: (T & { message?: string; errors?: string[] }) | null }> {
  const res = await fetch(`${API_URL}${path}`, { headers: adminHeaders() });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as never };
}

export default function StoreReportPanel({ role, onNavigate }: { role?: string; onNavigate?: (tab: string) => void }) {
  const owner = role === "OWNER" || role === "STORE_OWNER" || role === "MANAGER";
  const [tab, setTab] = useState<Tab>("stock");
  const [places, setPlaces] = useState<Place[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [sortBy, setSortBy] = useState<"sales" | "qty" | "profit" | "slow">("sales");
  const [group, setGroup] = useState<"day" | "week" | "month">("day");
  const [stock, setStock] = useState<StockData | null>(null);
  const [sales, setSales] = useState<SalesData | null>(null);
  const [compare, setCompare] = useState<CompareData | null>(null);
  const [day, setDay] = useState<DaySection | null>(null);
  const [buffer, setBuffer] = useState<BufferData | null>(null);
  const [owesMap, setOwesMap] = useState<Record<string, number>>({});
  const [records, setRecords] = useState<{ records: RecordRow[]; truncated: boolean } | null>(null);
  const [kind, setKind] = useState<"all" | "sales" | "stock" | "money">("all");
  const [productId, setProductId] = useState("");
  const [allStores, setAllStores] = useState(false);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const [me, locs] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      const active = ((locs?.warehouses ?? []) as Place[]).filter((l) => l.isActive);
      setPlaces(active);
      setHome(me?.homeLocationId ?? null);
      setLocationId(me?.homeLocationId ?? active[0]?.id ?? "");
      const ps = await fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null));
      setProducts(((ps?.products ?? ps?.items ?? []) as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name })));
    })().catch(() => setError("Could not load the stores"));
  }, []);

  const load = useCallback(async () => {
    if (!locationId && tab !== "compare" && tab !== "buffer") return;
    setLoading(true);
    setError(null);
    try {
      if (tab === "stock") {
        const r = await getJson<StockData>(`/admin/rice/store-stock?locationId=${locationId}`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the stock");
        setStock(r.data);
      } else if (tab === "sales") {
        const r = await getJson<SalesData>(`/admin/rice/store-sales?locationId=${locationId}&from=${from}&to=${to}`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the sales");
        setSales(r.data);
      } else if (tab === "records") {
        const q = new URLSearchParams({ from, to, kind, ...(productId ? { productId } : {}), ...(!allStores && locationId ? { locationId } : {}) });
        const r = await getJson<{ records: RecordRow[]; truncated: boolean }>(`/admin/rice/store-records?${q}`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the records");
        setRecords(r.data);
      } else if (tab === "buffer") {
        const r = await getJson<BufferData>(`/admin/rice/store-buffer`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the Buffer store");
        setBuffer(r.data);
      } else if (tab === "compare") {
        const r = await getJson<CompareData>(`/admin/rice/store-compare?from=${from}&to=${to}`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the comparison");
        setCompare(r.data);
      } else {
        const r = await getJson<{ sections: DaySection[] }>(`/admin/rice/daily?date=${from}&locationId=${locationId}`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the day");
        setDay(r.data?.sections?.[0] ?? null);
        if (owner) {
          const b = await getJson<BufferData>(`/admin/rice/store-buffer`); setBuffer(b.ok ? b.data : null);
          const pay = await getJson<{ stores: { id: string; owesMinor: number }[] }>(`/admin/payable/summary`);
          setOwesMap(pay.ok && pay.data ? Object.fromEntries(pay.data.stores.map((x) => [x.id, x.owesMinor])) : {});
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [tab, locationId, from, to, kind, productId, allStores, owner]);
  useEffect(() => { void load(); }, [load]);

  const placeName = useMemo(() => places.find((p) => p.id === locationId)?.name ?? "", [places, locationId]);
  const printStock = () => {
    if (!stock) return;
    const s: Slip = {
      storeName: stock.location.name, title: "STOCK LEFT", when: new Date().toLocaleString(),
      rows: stock.rows.map((r) => ({ name: r.name, qty: r.loose ? kg(r.onHand) : String(r.onHand), note: `${peso(r.unitPriceMinor)}${r.loose ? "/kg" : ""} = ${peso(r.valueMinor)}` })),
      totals: [{ label: "Worth", value: peso(stock.totals.valueMinor) }],
    };
    printSlip(s);
  };
  const printSales = (a4 = false) => {
    if (!sales) return;
    printSlip({
      storeName: sales.location.name, title: "SALES", when: sales.from === sales.to ? sales.from : `${sales.from} to ${sales.to}`, a4,
      lines: [{ label: "Sales", value: String(sales.sales.count) }],
      rows: rankedItems(sales.items, sortBy).map((i) => ({ name: i.name, qty: i.unit === "kg" ? `${i.quantity} kg` : String(i.quantity), note: peso(i.salesMinor) })),
      totals: [{ label: "Cash", value: peso(sales.sales.cashMinor) }, { label: "GCash", value: peso(sales.sales.gcashMinor) }, { label: "Credit", value: peso(sales.sales.creditMinor) }, { label: "Maya/bank/other", value: peso(sales.sales.otherMinor) }, { label: "Total", value: peso(sales.sales.totalMinor) }],
    });
  };
  const printDay = () => {
    if (!day) return;
    printSlip({
      storeName: day.location.name, title: "END OF DAY", when: from,
      lines: [{ label: "Sales", value: String(day.sales.count) }, { label: "Stock in", value: String(day.stockIn.documents) }],
      rows: day.kilosByVariety.map((v) => ({ name: v.variety, qty: kg(v.grams), note: peso(v.salesMinor) })),
      totals: [
        { label: "Cash sales", value: peso(day.sales.cashMinor) }, { label: "GCash", value: peso(day.sales.gcashMinor) }, { label: "Credit given", value: peso(day.utang.givenMinor) },
        { label: "Credit collected", value: peso(day.utang.collectedMinor) }, { label: "Cash expected", value: peso(day.cash.expectedMinor) }, { label: "Total sales", value: peso(day.sales.totalMinor) },
      ],
    });
  };

  const tabs: [Tab, string][] = [["stock", "Stock left"], ["sales", "Sales"], ["records", "All records"], ...(owner ? ([["compare", "Compare stores"]] as [Tab, string][]) : []), ["day", "End of day"]];
  const single = tab !== "compare" && tab !== "buffer";
  const range = tab === "sales" || tab === "compare" || tab === "records";

  return (
    <div className="container-fluid py-3" style={{ maxWidth: 900 }}>
      <h5 className="mb-2">Store report</h5>
      <ul className="nav nav-tabs mb-3 flex-nowrap overflow-auto">
        {tabs.map(([k, label]) => <li key={k} className="nav-item"><button className={`nav-link text-nowrap ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button></li>)}
      </ul>
      {single && <StoreBar label="Store" locations={places} value={locationId} homeLocationId={home} onPick={setLocationId} />}
      {tab === "records" && (
        <div className="mb-3">
          <div className="d-flex flex-wrap gap-2 mb-2">
            {([["all", "Everything"], ["sales", "Sales"], ["stock", "Stock"], ["money", "Money in"]] as const).map(([k, label]) => (
              <button key={k} type="button" className={`btn ${kind === k ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setKind(k)}>{label}</button>
            ))}
            {owner && <button type="button" className={`btn ${allStores ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setAllStores(!allStores)}>{allStores ? "All stores" : "One store"}</button>}
          </div>
          <select className="form-select" aria-label="Item" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All items</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {(range || tab === "day") && (
        <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
          <div><label className="form-label small mb-1" htmlFor="sr-from">{range ? "From" : "Day"}</label><input id="sr-from" type="date" className="form-control" value={from} max={today()} onChange={(e) => { setFrom(e.target.value); if (tab === "day" || e.target.value > to) setTo(e.target.value); }} /></div>
          {range && <div><label className="form-label small mb-1" htmlFor="sr-to">To</label><input id="sr-to" type="date" className="form-control" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} /></div>}
          {range && <div className="btn-group">
            <button type="button" className="btn btn-outline-secondary" onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
            {tab === "sales" && <button type="button" className="btn btn-outline-secondary" onClick={() => { const d = new Date(Date.now() + 8 * 3_600_000); const back = (d.getUTCDay() + 6) % 7; setFrom(new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10)); setTo(today()); }}>This week</button>}
            <button type="button" className="btn btn-outline-secondary" onClick={() => { const d = new Date(Date.now() + 8 * 3_600_000); const m = d.toISOString().slice(0, 7); setFrom(`${m}-01`); setTo(today()); }}>This month</button>
            {tab === "sales" && <button type="button" className="btn btn-outline-secondary" onClick={() => { const d = new Date(Date.now() + 8 * 3_600_000); setFrom(`${d.toISOString().slice(0, 4)}-01-01`); setTo(today()); }}>This year</button>}
          </div>}
        </div>
      )}
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {loading && <p className="text-muted small">Loading…</p>}

      {tab === "stock" && stock && (
        <>
          <div className="row g-2 mb-3">
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Items</div><div className="fs-5">{stock.totals.items}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Low / out</div><div className="fs-5">{stock.totals.low} / {stock.totals.empty}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Worth (selling price)</div><div className="fs-5">{peso(stock.totals.valueMinor)}</div></div></div>
            {owner && stock.totals.costValueMinor !== undefined && <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Worth (cost)</div><div className="fs-5">{peso(stock.totals.costValueMinor)}</div></div></div>}
          </div>
          {stock.rows.length === 0 ? <p className="text-muted">No stock recorded at {stock.location.name}.</p> : (
            <div className="table-responsive">
              <table className="table table-sm align-middle">
                <thead><tr><th>Item</th><th className="text-end">Left</th><th className="text-end">Days left</th><th className="text-end">Price</th><th className="text-end">Worth</th></tr></thead>
                <tbody>
                  {stock.rows.map((r) => (
                    <tr key={r.productId}>
                      <td>{r.name} {flagBadge(r.flag)}{r.reserved > 0 && <div className="small text-muted">{r.loose ? kg(r.reserved) : r.reserved} held</div>}</td>
                      <td className={`text-end fw-semibold ${r.onHand < 0 ? "text-danger" : ""}`}>{qtyText(r)}</td>
                      <td className={`text-end ${r.daysLeft != null && r.daysLeft <= 3 ? "text-danger fw-semibold" : ""}`}>{r.daysLeft == null ? <span className="text-muted">—</span> : r.daysLeft > 99 ? "99+" : `~${r.daysLeft}`}</td>
                      <td className="text-end">{peso(r.unitPriceMinor)}{r.loose ? <span className="small text-muted"> /kg</span> : ""}</td>
                      <td className="text-end">{peso(r.valueMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="btn btn-outline-dark" onClick={printStock} disabled={!stock.rows.length}>Print</button>
        </>
      )}

      {tab === "sales" && sales && (
        <>
          <div className="row g-2 mb-3">
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Sales ({sales.sales.count})</div><div className="fs-5">{peso(sales.sales.totalMinor)}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Cash</div><div className="fs-5">{peso(sales.sales.cashMinor)}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">GCash</div><div className="fs-5">{peso(sales.sales.gcashMinor)}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Credit</div><div className="fs-5">{peso(sales.sales.creditMinor)}</div></div></div>
            <div className="col-6 col-md-3"><div className="border rounded p-2"><div className="small text-muted">Maya / bank / other</div><div className="fs-5">{peso(sales.sales.otherMinor)}</div></div></div>
          </div>
          <div className="small mb-3">Cash received {peso(sales.cashInMinor)} · Credit collected {peso(sales.creditCollectedMinor)}{owner && sales.sales.grossProfitMinor !== undefined ? <> · <span className={sales.sales.grossProfitMinor < 0 ? "text-danger fw-bold" : "text-success fw-bold"}>Profit {peso(sales.sales.grossProfitMinor)}</span></> : null}</div>
          <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
            <h6 className="mb-0 me-auto">Items sold — {sortBy === "slow" ? "slowest first" : "best first"}</h6>
            <select className="form-select form-select-sm w-auto" aria-label="Rank by" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
              <option value="sales">Best by amount</option><option value="qty">Best by quantity</option>
              {owner && <option value="profit">Best by profit</option>}<option value="slow">Slowest sellers</option>
            </select>
          </div>
          {sales.items.length === 0 ? <p className="text-muted small">No sales in this period.</p> : (
            <table className="table table-sm"><thead><tr><th>#</th><th>Item</th><th className="text-end">Sold</th><th className="text-end">Amount</th>{owner && <th className="text-end">Profit</th>}</tr></thead>
              <tbody>{rankedItems(sales.items, sortBy).map((i, n) => <tr key={i.name}><td className="text-muted">{n + 1}</td><td>{i.name}</td><td className="text-end">{i.unit === "kg" ? `${i.quantity.toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : i.quantity}</td><td className="text-end">{peso(i.salesMinor)}</td>{owner && <td className="text-end">{i.profitMinor !== undefined ? peso(i.profitMinor) : ""}</td>}</tr>)}</tbody></table>
          )}
          {sales.days.length > 1 && (<>
            <div className="d-flex align-items-center gap-2 mb-1"><h6 className="mb-0 me-auto">Sales by</h6>
              <div className="btn-group btn-group-sm" role="group" aria-label="Group by">
                {(["day", "week", "month"] as const).map((g) => <button key={g} type="button" className={`btn ${group === g ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setGroup(g)}>{g[0]!.toUpperCase() + g.slice(1)}</button>)}
              </div>
            </div>
            <table className="table table-sm"><tbody>{groupDays(sales.days, group).map((d) => <tr key={d.label}><td>{d.label}</td><td className="text-end">{d.count} sales</td><td className="text-end">{peso(d.totalMinor)}</td></tr>)}</tbody></table></>)}
          <div className="d-flex gap-2">
            <button type="button" className="btn btn-outline-dark" onClick={() => printSales(false)} disabled={!sales.sales.count}>Print slip</button>
            <button type="button" className="btn btn-outline-dark" onClick={() => printSales(true)} disabled={!sales.sales.count}><i className="bi bi-file-earmark-pdf me-1"></i>Print / PDF (A4)</button>
          </div>
        </>
      )}

      {tab === "records" && records && (
        records.records.length === 0 ? <p className="text-muted">No records in this period.</p> : (
          <>
            {records.truncated && <div className="alert alert-info py-2 small">Showing the latest {records.records.length}. Narrow the dates or pick an item to see the rest.</div>}
            {(() => {
              const byDay = new Map<string, RecordRow[]>();
              for (const r of records.records) { const d = new Date(new Date(r.at).getTime() + 8 * 3_600_000).toISOString().slice(0, 10); byDay.set(d, [...(byDay.get(d) ?? []), r]); }
              return [...byDay.entries()].map(([d, rows]) => (
                <div key={d} className="mb-3">
                  <div className="fw-semibold border-bottom mb-1">{d}</div>
                  <ul className="list-unstyled mb-0">
                    {rows.map((r, i) => (
                      <li key={i} className="py-1 border-bottom small">
                        <div className="d-flex justify-content-between gap-2">
                          <span><span className={`badge me-1 ${r.kind === "SALE" ? "text-bg-success" : r.kind === "MONEY" ? "text-bg-primary" : "text-bg-secondary"}`}>{r.title}</span>{r.detail}</span>
                          <span className="text-end text-nowrap fw-semibold">{r.amountMinor !== null ? peso(r.amountMinor) : r.qtyText}</span>
                        </div>
                        <div className="text-muted">{new Date(r.at).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}{r.store ? ` · ${r.store}` : ""}{r.docNumber ? ` · ${r.docNumber}` : ""}{r.by ? ` · ${r.by}` : ""}{r.balanceText ? ` · ${r.balanceText}` : ""}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              ));
            })()}
          </>
        )
      )}

      {tab === "compare" && compare && (
        <>
          <div className="table-responsive">
            <table className="table table-sm align-middle">
              <thead><tr><th>Store</th><th className="text-end">Sales</th><th className="text-end">Cash</th><th className="text-end">Credit</th><th className="text-end">Profit</th><th className="text-end">Stock worth</th><th className="text-end">Low/out</th><th className="text-end">Owes main store</th></tr></thead>
              <tbody>
                {compare.stores.map((s) => (
                  <tr key={s.location.id}>
                    <td className="fw-semibold">{s.location.name}<div className="small text-muted">{s.sales.count} sales</div></td>
                    <td className="text-end">{peso(s.sales.totalMinor)}</td>
                    <td className="text-end">{peso(s.sales.cashMinor)}</td>
                    <td className="text-end">{peso(s.sales.creditMinor)}</td>
                    <td className="text-end">{peso(s.sales.grossProfitMinor ?? 0)}</td>
                    <td className="text-end">{peso(s.stock.valueMinor)}</td>
                    <td className="text-end">{s.stock.low}/{s.stock.empty}</td>
                    <td className={`text-end ${s.owesMinor > 0 ? "text-danger fw-semibold" : ""}`}>{s.owesMinor !== 0 ? peso(s.owesMinor) : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="fw-bold"><td>All stores</td><td className="text-end">{peso(compare.total.salesMinor)}</td><td /><td className="text-end">{peso(compare.total.creditGivenMinor)}</td><td className="text-end">{peso(compare.total.grossProfitMinor)}</td><td className="text-end">{peso(compare.total.stockValueMinor)}</td><td /><td className="text-end">{compare.total.owesMinor !== 0 ? peso(compare.total.owesMinor) : ""}</td></tr></tfoot>
            </table>
          </div>
          <p className="small text-muted">Credit here is what was given in the period. &quot;Owes main store&quot; is the Store payable balance. Pick a store in Sales for the detail.</p>
          {onNavigate && <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => onNavigate("payable")}>Open Store payable</button>}
        </>
      )}

      {tab === "buffer" && buffer && (
        !buffer.buffer ? (
          <p className="text-muted">No Buffer store yet. Add one in Warehouses (type: Buffer store). Short sales are then covered from it instead of making a store negative.</p>
        ) : (
          <>
            <div className={`alert ${buffer.totals.owedItems > 0 ? "alert-warning" : "alert-success"}`}>
              {buffer.totals.owedItems > 0
                ? <>The Buffer covered <b>{buffer.totals.owedItems}</b> item(s) worth about <b>{peso(buffer.totals.owedMinor)}</b>. Record the missing stock (Stock in or Move stock at the Buffer) or count it, to bring these back to zero.</>
                : "Nothing to fix. The Buffer has not covered any shortage."}
            </div>
            {buffer.owed.length > 0 && (
              <table className="table table-sm align-middle">
                <thead><tr><th>To fix</th><th className="text-end">Missing</th><th className="text-end">Worth</th><th className="text-end">Since</th></tr></thead>
                <tbody>{buffer.owed.map((o) => {
                  const days = o.oldestAt ? Math.floor((Date.now() - new Date(o.oldestAt).getTime()) / 86_400_000) : null;
                  return <tr key={o.productId}><td>{o.name}</td><td className="text-end fw-semibold">{o.quantity.toLocaleString("en-PH", { maximumFractionDigits: 3 })} {o.unit}</td><td className="text-end">{peso(o.valueMinor)}</td><td className={`text-end ${days !== null && days >= 7 ? "text-danger fw-semibold" : ""}`}>{days === null ? "" : days === 0 ? "today" : `${days} d ago`}</td></tr>;
                })}</tbody>
              </table>
            )}
            {buffer.surplus.length > 0 && <p className="small text-muted">Extra stock sitting in the Buffer: {buffer.surplus.map((x) => `${x.quantity} ${x.unit} ${x.name}`).join(" · ")}</p>}
            <h6>What it covered (latest)</h6>
            {buffer.entries.length === 0 ? <p className="text-muted small">None.</p> : (
              <ul className="list-group">
                {buffer.entries.map((e, i) => (
                  <li key={i} className="list-group-item small">
                    <b>{e.quantity.toLocaleString("en-PH", { maximumFractionDigits: 3 })} {e.unit} {e.productName}</b>{e.store ? ` · sold at ${e.store}` : ` · ${e.what}`}
                    <div className="text-muted">{e.orderNumber ?? ""}{e.by ? ` · ${e.by}` : ""} · {new Date(e.at).toLocaleString()}</div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}

      {tab === "day" && day && (
        <>
          <div className="border rounded p-3 mb-3">
            <div className="d-flex justify-content-between"><strong>{day.location.name} — {from}</strong>{day.locked ? <span className="badge text-bg-success">Closed</span> : <span className="badge text-bg-warning">Open</span>}</div>
            <ul className="list-unstyled mb-0 mt-2">
              <li>Sales: <b>{peso(day.sales.totalMinor)}</b> ({day.sales.count})</li>
              <li>Cash {peso(day.sales.cashMinor)} · GCash {peso(day.sales.gcashMinor)} · Credit {peso(day.sales.utangMinor)}</li>
              <li>Credit collected: {peso(day.utang.collectedMinor)}</li>
              <li>Cash expected in the drawer: <b>{peso(day.cash.expectedMinor)}</b>{day.cashCountedMinor !== null && <> · counted {peso(day.cashCountedMinor)} ({(day.cashVarianceMinor ?? 0) === 0 ? "matches" : `off by ${peso(day.cashVarianceMinor ?? 0)}`})</>}</li>
              <li>Stock in today: {day.stockIn.documents} document(s)</li>
              {(owesMap[locationId] ?? 0) > 0 && <li className="text-danger fw-semibold">Owes the main store: {peso(owesMap[locationId] ?? 0)} (Store payable)</li>}
              {buffer?.buffer && buffer.totals.owedItems > 0 && <li className="text-warning-emphasis">Buffer still to fix: {buffer.totals.owedItems} item(s), about {peso(buffer.totals.owedMinor)}</li>}
              {day.kilosByVariety.map((v) => <li key={v.variety} className="small text-muted">{v.variety}: {kg(v.grams)} · {peso(v.salesMinor)}</li>)}
            </ul>
          </div>
          <div className="d-flex gap-2">
            <button type="button" className="btn btn-outline-dark" onClick={printDay}>Print</button>
            {!day.locked && onNavigate && <button type="button" className="btn btn-success" onClick={() => onNavigate("ulat")}>Close the day…</button>}
          </div>
        </>
      )}
      {!loading && !error && !placeName && tab !== "compare" && <p className="text-muted small">Choose a store.</p>}
    </div>
  );
}

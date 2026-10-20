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

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const kgText = (g: number) => `${(g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`;

interface Place { id: string; name: string; code: string | null; isActive: boolean }
type Tab = "stock" | "sales" | "compare" | "day";

interface StockRow { productId: string; name: string; loose: boolean; unit: string; onHand: number; reserved: number; available: number; flag: "ZERO" | "LOW" | "OK"; unitPriceMinor: number; valueMinor: number; costValueMinor?: number }
interface StockData { location: { id: string; name: string }; rows: StockRow[]; totals: { items: number; low: number; empty: number; valueMinor: number; costValueMinor?: number } }
interface SalesTotals { count: number; totalMinor: number; cashMinor: number; gcashMinor: number; creditMinor: number; otherMinor: number; costMinor?: number; grossProfitMinor?: number }
interface SalesData { location: { id: string; name: string }; from: string; to: string; sales: SalesTotals; cashInMinor: number; creditGivenMinor: number; creditCollectedMinor: number; items: { name: string; unit: string; quantity: number; salesMinor: number }[]; days: { date: string; count: number; totalMinor: number }[] }
interface CompareData { from: string; to: string; stores: { location: { id: string; name: string; type: string }; sales: SalesTotals; cashInMinor: number; creditGivenMinor: number; creditCollectedMinor: number; stock: { items: number; low: number; empty: number; valueMinor: number } }[]; total: { salesMinor: number; count: number; grossProfitMinor: number; creditGivenMinor: number; stockValueMinor: number } }
interface DaySection { location: { id: string; name: string }; locked: boolean; closedAt: string | null; cashCountedMinor: number | null; cashVarianceMinor: number | null; sales: { count: number; totalMinor: number; cashMinor: number; gcashMinor: number; utangMinor: number }; cash: { expectedMinor: number }; utang: { givenMinor: number; collectedMinor: number }; stockIn: { documents: number; units: number }; kilosByVariety: { variety: string; grams: number; salesMinor: number }[] }

const qtyText = (r: StockRow) => (r.loose ? kgText(r.onHand) : `${r.onHand.toLocaleString("en-PH")} pcs`);
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
  const [stock, setStock] = useState<StockData | null>(null);
  const [sales, setSales] = useState<SalesData | null>(null);
  const [compare, setCompare] = useState<CompareData | null>(null);
  const [day, setDay] = useState<DaySection | null>(null);
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
    })().catch(() => setError("Could not load the stores"));
  }, []);

  const load = useCallback(async () => {
    if (!locationId && tab !== "compare") return;
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
      } else if (tab === "compare") {
        const r = await getJson<CompareData>(`/admin/rice/store-compare?from=${from}&to=${to}`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the comparison");
        setCompare(r.data);
      } else {
        const r = await getJson<{ sections: DaySection[] }>(`/admin/rice/daily?date=${from}&locationId=${locationId}`);
        if (!r.ok) throw new Error(r.data?.errors?.join(", ") ?? r.data?.message ?? "Could not load the day");
        setDay(r.data?.sections?.[0] ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [tab, locationId, from, to]);
  useEffect(() => { void load(); }, [load]);

  const placeName = useMemo(() => places.find((p) => p.id === locationId)?.name ?? "", [places, locationId]);
  const printStock = () => {
    if (!stock) return;
    const s: Slip = {
      storeName: stock.location.name, title: "STOCK LEFT", when: new Date().toLocaleString(),
      rows: stock.rows.map((r) => ({ name: r.name, qty: r.loose ? kgText(r.onHand) : String(r.onHand), note: `${peso(r.unitPriceMinor)}${r.loose ? "/kg" : ""} = ${peso(r.valueMinor)}` })),
      totals: [{ label: "Worth", value: peso(stock.totals.valueMinor) }],
    };
    printSlip(s);
  };
  const printSales = () => {
    if (!sales) return;
    printSlip({
      storeName: sales.location.name, title: "SALES", when: sales.from === sales.to ? sales.from : `${sales.from} to ${sales.to}`,
      lines: [{ label: "Sales", value: String(sales.sales.count) }],
      rows: sales.items.map((i) => ({ name: i.name, qty: i.unit === "kg" ? `${i.quantity} kg` : String(i.quantity), note: peso(i.salesMinor) })),
      totals: [{ label: "Cash", value: peso(sales.sales.cashMinor) }, { label: "GCash", value: peso(sales.sales.gcashMinor) }, { label: "Credit", value: peso(sales.sales.creditMinor) }, { label: "Total", value: peso(sales.sales.totalMinor) }],
    });
  };
  const printDay = () => {
    if (!day) return;
    printSlip({
      storeName: day.location.name, title: "END OF DAY", when: from,
      lines: [{ label: "Sales", value: String(day.sales.count) }, { label: "Stock in", value: String(day.stockIn.documents) }],
      rows: day.kilosByVariety.map((v) => ({ name: v.variety, qty: kgText(v.grams), note: peso(v.salesMinor) })),
      totals: [
        { label: "Cash sales", value: peso(day.sales.cashMinor) }, { label: "GCash", value: peso(day.sales.gcashMinor) }, { label: "Credit given", value: peso(day.utang.givenMinor) },
        { label: "Credit collected", value: peso(day.utang.collectedMinor) }, { label: "Cash expected", value: peso(day.cash.expectedMinor) }, { label: "Total sales", value: peso(day.sales.totalMinor) },
      ],
    });
  };

  const tabs: [Tab, string][] = [["stock", "Stock left"], ["sales", "Sales"], ...(owner ? ([["compare", "Compare stores"]] as [Tab, string][]) : []), ["day", "End of day"]];
  const single = tab !== "compare";
  const range = tab === "sales" || tab === "compare";

  return (
    <div className="container-fluid py-3" style={{ maxWidth: 900 }}>
      <h5 className="mb-2">Store report</h5>
      <ul className="nav nav-tabs mb-3 flex-nowrap overflow-auto">
        {tabs.map(([k, label]) => <li key={k} className="nav-item"><button className={`nav-link text-nowrap ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button></li>)}
      </ul>
      {single && <StoreBar label="Store" locations={places} value={locationId} homeLocationId={home} onPick={setLocationId} />}
      {(range || tab === "day") && (
        <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
          <div><label className="form-label small mb-1" htmlFor="sr-from">{range ? "From" : "Day"}</label><input id="sr-from" type="date" className="form-control" value={from} max={today()} onChange={(e) => { setFrom(e.target.value); if (tab === "day" || e.target.value > to) setTo(e.target.value); }} /></div>
          {range && <div><label className="form-label small mb-1" htmlFor="sr-to">To</label><input id="sr-to" type="date" className="form-control" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} /></div>}
          {range && <div className="btn-group">
            <button type="button" className="btn btn-outline-secondary" onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
            <button type="button" className="btn btn-outline-secondary" onClick={() => { const d = new Date(Date.now() + 8 * 3_600_000); const m = d.toISOString().slice(0, 7); setFrom(`${m}-01`); setTo(today()); }}>This month</button>
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
                <thead><tr><th>Item</th><th className="text-end">Left</th><th className="text-end">Price</th><th className="text-end">Worth</th></tr></thead>
                <tbody>
                  {stock.rows.map((r) => (
                    <tr key={r.productId}>
                      <td>{r.name} {flagBadge(r.flag)}{r.reserved > 0 && <div className="small text-muted">{r.loose ? kgText(r.reserved) : r.reserved} held</div>}</td>
                      <td className={`text-end fw-semibold ${r.onHand < 0 ? "text-danger" : ""}`}>{qtyText(r)}</td>
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
          </div>
          <div className="small mb-3">Cash received {peso(sales.cashInMinor)} · Credit collected {peso(sales.creditCollectedMinor)}{owner && sales.sales.grossProfitMinor !== undefined ? <> · <span className={sales.sales.grossProfitMinor < 0 ? "text-danger fw-bold" : "text-success fw-bold"}>Profit {peso(sales.sales.grossProfitMinor)}</span></> : null}</div>
          <h6>Items sold</h6>
          {sales.items.length === 0 ? <p className="text-muted small">No sales in this period.</p> : (
            <table className="table table-sm"><thead><tr><th>Item</th><th className="text-end">Sold</th><th className="text-end">Amount</th></tr></thead>
              <tbody>{sales.items.map((i) => <tr key={i.name}><td>{i.name}</td><td className="text-end">{i.unit === "kg" ? `${i.quantity.toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : i.quantity}</td><td className="text-end">{peso(i.salesMinor)}</td></tr>)}</tbody></table>
          )}
          {sales.days.length > 1 && (<><h6>By day</h6>
            <table className="table table-sm"><tbody>{sales.days.map((d) => <tr key={d.date}><td>{d.date}</td><td className="text-end">{d.count} sales</td><td className="text-end">{peso(d.totalMinor)}</td></tr>)}</tbody></table></>)}
          <button type="button" className="btn btn-outline-dark" onClick={printSales} disabled={!sales.sales.count}>Print</button>
        </>
      )}

      {tab === "compare" && compare && (
        <>
          <div className="table-responsive">
            <table className="table table-sm align-middle">
              <thead><tr><th>Store</th><th className="text-end">Sales</th><th className="text-end">Cash</th><th className="text-end">Credit</th><th className="text-end">Profit</th><th className="text-end">Stock worth</th><th className="text-end">Low/out</th></tr></thead>
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
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="fw-bold"><td>All stores</td><td className="text-end">{peso(compare.total.salesMinor)}</td><td /><td className="text-end">{peso(compare.total.creditGivenMinor)}</td><td className="text-end">{peso(compare.total.grossProfitMinor)}</td><td className="text-end">{peso(compare.total.stockValueMinor)}</td><td /></tr></tfoot>
            </table>
          </div>
          <p className="small text-muted">Credit here is what was given in the period. Pick a store in Sales for the detail.</p>
        </>
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
              {day.kilosByVariety.map((v) => <li key={v.variety} className="small text-muted">{v.variety}: {kgText(v.grams)} · {peso(v.salesMinor)}</li>)}
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

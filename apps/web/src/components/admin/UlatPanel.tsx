"use client";

// Rice Ops M9 — Reports on the owner's phone, and Closing for the closing staff.
//   Stock Live · Today (+ Closing) · This month · Short · Trace · Alerts
// Stock Live listens to the server's change stream and refreshes within seconds of any
// signed step (every 30 s as a backup). Every table exports to Excel (CSV).

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, isOwnerRole } from "../../lib/admin";
import { toast } from "../../lib/toast";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import { CountSheet, type CountDetail, type CountRow } from "./BilanginPanel";
import MovementSummary from "./MovementSummary";
import WeeklySummary from "./WeeklySummary";
import { peso } from "../../lib/number-format";

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
interface Loc { id: string; name: string; code: string | null; type: string }
interface Cell { onHand: number; reserved: number; available: number; flag: "ZERO" | "LOW" | "OK" }
interface LiveRow { productId: string; name: string; loose: boolean; gramsPerUnit: number | null; cells: Record<string, Cell>; inTransit: number; inResack: number; total: number; totalGrams: number | null }

const kg = (g: number) => `${(g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 1 })} kg`;
const qty = (loose: boolean, n: number) => (loose ? kg(n) : `${n}`);
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

async function getJson(path: string): Promise<{ ok: boolean; data: ApiBody | null }> {
  const res = await fetch(`${API_URL}${path}`, { headers: adminHeaders() });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

async function putJson(path: string, body: unknown): Promise<{ ok: boolean; data: ApiBody | null }> {
  const res = await fetch(`${API_URL}${path}`, { method: "PUT", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as ApiBody | null };
}

/** Owner's switch: one cost per product for every location, or each location's own cost. */
function CostModeSwitch({ onChanged }: { onChanged: () => void }) {
  const [mode, setMode] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { void getJson("/admin/rice/cost-mode").then((r) => { if (r.ok) setMode(String(r.data?.costMode ?? "SHARED")); }); }, []);
  if (!mode) return null;
  async function change(next: string) {
    setMsg("");
    const r = await putJson("/admin/rice/cost-mode", { costMode: next });
    if (!r.ok) { setMsg(errText(r.data, "Could not change it")); return; }
    setMode(next);
    setMsg("Saved. It applies to stock that arrives and to sales from now on.");
    onChanged();
  }
  return (
    <div className="card mb-2"><div className="card-body py-2">
      <label className="form-label fw-bold mb-1" htmlFor="costMode">How cost is counted</label>
      <select id="costMode" className="form-select" style={{ maxWidth: 360 }} value={mode} onChange={(e) => void change(e.target.value)}>
        <option value="SHARED">One cost for all locations</option>
        <option value="PER_LOCATION">Each location has its own cost</option>
      </select>
      <div className="small text-muted mt-1">
        {mode === "PER_LOCATION"
          ? "Stock-in at a location sets that shelf's cost. A trip carries the cost of the shelf it left. Only the main location changes the product cost."
          : "The latest stock-in cost is used everywhere."}
      </div>
      {msg && <div className="small text-success">{msg}</div>}
    </div></div>
  );
}

/** Excel opens a CSV with a BOM; cells quoted when needed. */
function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
}

type Tab = "live" | "daily" | "monthly" | "kulang" | "trace" | "alerts" | "check" | "book" | "moves" | "week";

export default function UlatPanel({ role, onNavigate }: { role?: string; onNavigate?: (tab: string) => void }) {
  const owner = !!role && (isOwnerRole(role) || role === "MANAGER");
  const [tab, setTab] = useState<Tab>(owner ? "live" : "daily");
  const tabs: [Tab, string][] = owner
    ? [["live", "Stock Live"], ["daily", "Today"], ["monthly", "This month"], ["kulang", "Short"], ["trace", "Trace"], ["alerts", "Alerts"], ["check", "Stock check"], ["book", "Stock book"], ["moves", "Movement"], ["week", "Week"]]
    : [["live", "Stock Live"], ["daily", "Closing"]];
  return (
    <div style={{ fontSize: 17 }}>
      <h1 className="h4">Reports</h1>
      <ul className="nav nav-tabs mb-3 flex-nowrap overflow-auto">
        {tabs.map(([k, label]) => <li key={k} className="nav-item"><button className={`nav-link text-nowrap ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{label}</button></li>)}
      </ul>
      {tab === "live" && <StockLive />}
      {tab === "daily" && <Daily owner={owner} />}
      {tab === "monthly" && owner && <Monthly />}
      {tab === "kulang" && owner && <Kulang />}
      {tab === "trace" && owner && <Trace />}
      {tab === "alerts" && owner && <Alerts />}
      {tab === "check" && owner && <StockCheck />}
      {tab === "book" && owner && <StockBook />}
      {tab === "moves" && owner && <MovementSummary />}
      {tab === "week" && owner && <WeeklySummary onNavigate={onNavigate} />}
    </div>
  );
}

interface CheckBreak { type: string; docNumber: string | null; at: string; expected: number; actual: number; gap: number }
interface CheckItem { productId: string; name: string; loose: boolean; locationId: string; location: string; status: "off" | "no_ledger"; onHand: number; ledgerBalance: number | null; difference: number; breaks: CheckBreak[] }

/** Stock check — where the shelf and the ledger disagree. Read-only. */
function StockCheck() {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [locationId, setLocationId] = useState("");
  const [items, setItems] = useState<CheckItem[]>([]);
  const [summary, setSummary] = useState<{ checked: number; problems: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    const r = await getJson(`/admin/rice/stock-book/check${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ""}`);
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Could not check the stock")); return; }
    setItems((r.data?.items as CheckItem[]) ?? []);
    setSummary({ checked: Number(r.data?.checked ?? 0), problems: Number(r.data?.problems ?? 0) });
  }, [locationId]);

  useEffect(() => { void getJson("/admin/rice/stock-live").then((r) => { if (r.ok) setLocations((r.data?.locations as Loc[]) ?? []); }); }, []);
  useEffect(() => { void load(); }, [load]);

  const say = (i: CheckItem) => i.status === "no_ledger"
    ? `${qty(i.loose, i.onHand)} on the shelf, but the ledger has no record of how it got there`
    : i.difference < 0
      ? `The shelf shows ${qty(i.loose, -i.difference)} LESS than the ledger (shelf ${qty(i.loose, i.onHand)}, ledger ${qty(i.loose, i.ledgerBalance ?? 0)})`
      : `The shelf shows ${qty(i.loose, i.difference)} MORE than the ledger (shelf ${qty(i.loose, i.onHand)}, ledger ${qty(i.loose, i.ledgerBalance ?? 0)})`;

  return (
    <div>
      <div className="d-flex gap-2 align-items-center mb-2 flex-wrap">
        <select className="form-select" style={{ maxWidth: 240 }} value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Location">
          <option value="">All locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="btn btn-outline-secondary" onClick={() => void load()} disabled={busy}><i className="bi bi-arrow-clockwise me-1"></i>Check again</button>
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      {summary && !error && (
        <p className={summary.problems === 0 ? "text-success fw-bold" : "fw-bold"}>
          {summary.problems === 0 ? `All ${summary.checked} product-and-location stocks agree with the ledger.` : `${summary.problems} of ${summary.checked} do not agree.`}
        </p>
      )}
      {items.map((i) => (
        <div key={`${i.productId}|${i.locationId}`} className="card mb-2"><div className="card-body py-2">
          <div className="fw-bold">{i.name} <span className="text-muted fw-normal">· {i.location}</span></div>
          <div>{say(i)}</div>
          {i.breaks.map((b, n) => (
            <div key={n} className="small text-muted">
              {new Date(b.at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })} · {b.type}{b.docNumber ? ` · ${b.docNumber}` : ""}: expected {qty(i.loose, b.expected)}, ledger says {qty(i.loose, b.actual)} ({b.gap > 0 ? "+" : ""}{qty(i.loose, b.gap)} with no record)
            </div>
          ))}
        </div></div>
      ))}
    </div>
  );
}

interface BookRow { id: string; at: string; location: string; type: string; docNumber: string | null; note: string | null; delta: number; balanceAfter: number | null; by: string | null; unitPriceMinor: number | null; unitCostMinor: number | null }
interface BookTotal { locationId: string; location: string; opening: number | null; closing: number | null; inQty: number; outQty: number; stockValueMinor: number | null; unitCostMinor: number; salesMinor: number; costOfSoldMinor: number; profitMinor: number; profitPct: number | null; soldQty: number; soldFromOtherQty: number }

const BOOK_LABEL: Record<string, string> = {
  RECEIPT: "Stock in", STOCK_IN: "Stock in", TRANSFER_IN: "Trip received", TRANSFER_OUT: "Trip sent out", CONSUME: "Sold", ADJUST: "Adjusted",
  VOID_RESTORE: "Sale voided, stock back", CONVERSION_IN: "Resack in", CONVERSION_OUT: "Resack out", MERGE_OUT: "Merged out",
  RELEASE_OUT: "Sent out", RESACK_OUT: "Resack out", RECEIVE_IN: "Received", COUNT_ADJUST: "Count fix", WRITE_OFF: "Written off", RETURN_IN: "Returned",
};

function StockBook() {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [productId, setProductId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<BookRow[]>([]);
  const [totals, setTotals] = useState<BookTotal[]>([]);
  const [loose, setLoose] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void getJson("/admin/rice/stock-live").then((r) => {
      if (!r.ok) return;
      setLocations((r.data?.locations as Loc[]) ?? []);
      setProducts(((r.data?.rows as LiveRow[]) ?? []).map((x) => ({ id: x.productId, name: x.name })));
    });
  }, []);

  const load = useCallback(async () => {
    if (!productId) { setRows([]); setTotals([]); return; }
    setBusy(true);
    setError("");
    const q = new URLSearchParams({ productId });
    if (locationId) q.set("locationId", locationId);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const r = await getJson(`/admin/rice/stock-book?${q.toString()}`);
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "Could not load the stock book")); return; }
    setRows((r.data?.rows as BookRow[]) ?? []);
    setTotals((r.data?.totals as BookTotal[]) ?? []);
    setLoose(!!(r.data?.product as { loose?: boolean } | undefined)?.loose);
    setTruncated(!!r.data?.truncated);
  }, [productId, locationId, from, to]);
  useEffect(() => { void load(); }, [load]);

  const n = (v: number | null) => (v === null ? "?" : qty(loose, v));
  return (
    <div>
      <CostModeSwitch onChanged={() => void load()} />
      <div className="d-flex gap-2 align-items-center mb-2 flex-wrap">
        <select className="form-select" style={{ maxWidth: 260 }} value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="Product">
          <option value="">Pick a product</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="form-select" style={{ maxWidth: 200 }} value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Location">
          <option value="">All locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label className="small text-muted">From <input type="date" className="form-control" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small text-muted">To <input type="date" className="form-control" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      {!productId && <p className="text-muted">Pick a product to see every stock-in, trip, sale, resack and count, with the balance after each one.</p>}
      {busy && <p className="text-muted">Loading…</p>}
      {totals.map((t) => (
        <div key={t.locationId} className="card mb-2"><div className="card-body py-2">
          <div className="fw-bold">{t.location}</div>
          <div>Start {n(t.opening)} · In +{qty(loose, t.inQty)} · Out −{qty(loose, t.outQty)} · End {n(t.closing)}{t.stockValueMinor !== null ? ` (worth ${peso(t.stockValueMinor)} at ${peso(t.unitCostMinor)}${loose ? " per kg" : " each"})` : ""}</div>
          {t.soldFromOtherQty > 0 && <div className="small text-muted">{qty(loose, t.soldFromOtherQty)} of what this location sold came off another location's shelf, so it is not a sale row here. Look for "Sent out … for sale" at the other location.</div>}
          <div>Sold {peso(t.salesMinor)} · Cost {peso(t.costOfSoldMinor)} · <span className={t.profitMinor < 0 ? "text-danger fw-bold" : "text-success fw-bold"}>Profit {peso(t.profitMinor)}{t.profitPct !== null ? ` (${t.profitPct}%)` : ""}</span></div>
        </div></div>
      ))}
      {rows.length > 0 && (
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead><tr><th>When</th><th>Where</th><th>What</th><th className="text-end">Qty</th><th className="text-end">Balance</th><th className="text-end">Price</th><th className="text-end">Cost</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-nowrap">{new Date(r.at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}</td>
                  <td>{r.location}</td>
                  <td>{BOOK_LABEL[r.type] ?? r.type}{r.docNumber ? ` · ${r.docNumber}` : ""}{r.note ? ` · ${r.note}` : ""}{r.by ? <span className="text-muted"> · {r.by}</span> : null}</td>
                  <td className={`text-end ${r.delta < 0 ? "text-danger" : "text-success"}`}>{r.delta > 0 ? "+" : "−"}{qty(loose, Math.abs(r.delta))}</td>
                  <td className="text-end">{n(r.balanceAfter)}</td>
                  <td className="text-end">{r.unitPriceMinor === null ? "" : peso(r.unitPriceMinor)}</td>
                  <td className="text-end">{r.unitCostMinor === null ? "" : peso(r.unitCostMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {productId && !busy && !error && rows.length === 0 && <p className="text-muted">No stock changes in these dates.</p>}
      {truncated && <p className="small text-muted">Showing the latest 500 rows. Narrow the dates to see older ones.</p>}
      {rows.length > 0 && <p className="small text-muted">Price and cost are shown for sales and stock-ins (per sack, or per kilo for loose rice). Profit uses the cost frozen with each sale. Stock worth uses the cost of the shelf at that location (or the product cost when the store counts one cost for all).</p>}
    </div>
  );
}

function StockLive() {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [at, setAt] = useState<string>("");
  const [live, setLive] = useState(false);
  const [detail, setDetail] = useState<{ row: LiveRow; loc: Loc | null; moves: { id: string; type: string; delta: number; createdAt: string; by: string | null; documentType: string | null; reservedOnly: boolean }[] } | null>(null);
  const load = useCallback(async () => {
    const r = await getJson("/admin/rice/stock-live");
    if (!r.ok || !r.data) return;
    setLocations(r.data.locations as Loc[]);
    setRows(r.data.rows as LiveRow[]);
    setAt(String(r.data.at));
  }, []);
  useEffect(() => {
    void load();
    const backup = setInterval(() => void load(), 30_000);
    // The change stream: refetch within seconds of any signed step.
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/admin/rice/stream`, { headers: adminHeaders(), signal: ctrl.signal });
        if (!res.ok || !res.body) return;
        setLive(true);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          if (parts.some((p) => p.startsWith("event: stock"))) void load();
        }
      } catch { /* stream closed — the 30 s refresh keeps going */ } finally { setLive(false); }
    })();
    return () => { clearInterval(backup); ctrl.abort(); };
  }, [load]);

  const open = async (row: LiveRow, loc: Loc | null) => {
    const r = await getJson(`/admin/rice/movements?productId=${row.productId}${loc ? `&locationId=${loc.id}` : ""}`);
    setDetail({ row, loc, moves: (r.data?.movements ?? []) as never });
  };
  const exportCsv = () => downloadCsv(`stock-live-${today()}.csv`, [
    ["Product", ...locations.map((l) => l.code ?? l.name), "In transit", "In resack", "Total", "Total kilos"],
    ...rows.map((r) => [r.name, ...locations.map((l) => r.cells[l.id]?.onHand ?? 0), r.inTransit, r.inResack, r.total, r.totalGrams === null ? "" : r.totalGrams / 1000]),
  ]);

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-2">
        <span className="small text-muted">{live ? <span className="badge text-bg-success me-1">Live</span> : null}{at && `Last update ${new Date(at).toLocaleTimeString("en-PH")}`}</span>
        <button type="button" className="btn btn-outline-dark btn-sm" onClick={exportCsv}>Excel</button>
      </div>
      <div className="table-responsive">
        <table className="table table-sm table-bordered align-middle" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead><tr><th>Rice</th>{locations.map((l) => <th key={l.id} className="text-end">{l.code ?? l.name}</th>)}<th className="text-end">In transit</th><th className="text-end">Resack</th><th className="text-end">Total</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.productId}>
                <td>{r.name}</td>
                {locations.map((l) => {
                  const c = r.cells[l.id];
                  const cls = !c ? "text-muted" : c.flag === "ZERO" ? "table-danger" : c.flag === "LOW" ? "table-warning" : "";
                  return (
                    <td key={l.id} className={`text-end ${cls}`} role="button" onClick={() => void open(r, l)}>
                      {c ? qty(r.loose, c.onHand) : "—"}{c && c.reserved > 0 && <span className="d-block small text-muted">reserved {qty(r.loose, c.reserved)}</span>}
                      {c?.flag === "ZERO" && <span className="d-block small fw-semibold">Out</span>}
                    </td>
                  );
                })}
                <td className="text-end">{r.inTransit ? qty(r.loose, r.inTransit) : ""}</td>
                <td className="text-end">{r.inResack ? qty(r.loose, r.inResack) : ""}</td>
                <td className="text-end fw-semibold" role="button" onClick={() => void open(r, null)}>{qty(r.loose, r.total)}{!r.loose && r.totalGrams ? <span className="d-block small text-muted">{kg(r.totalGrams)}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && (
        <div className="card mt-2">
          <div className="card-body">
            <div className="d-flex justify-content-between"><strong>{detail.row.name}{detail.loc ? ` · ${detail.loc.name}` : ""}</strong><button type="button" className="btn-close" aria-label="Close" onClick={() => setDetail(null)} /></div>
            <ul className="list-unstyled small mb-0 mt-2" style={{ fontVariantNumeric: "tabular-nums" }}>
              {detail.moves.filter((m) => !m.reservedOnly).map((m) => (
                <li key={m.id} className="border-bottom py-1">{new Date(m.createdAt).toLocaleString("en-PH")} · {m.type} {m.delta > 0 ? "+" : ""}{qty(detail.row.loose, m.delta)} · {m.documentType ?? ""} · {m.by ?? ""}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

interface DaySection {
  location: Loc; locked: boolean; closedAt: string | null; cashCountedMinor: number | null; cashVarianceMinor: number | null;
  sales: { count: number; totalMinor: number; cashMinor: number; gcashMinor: number; utangMinor: number; encodedLater: number; grossProfitMinor: number; profitShareMinor?: number };
  kilosByVariety: { variety: string; grams: number; salesMinor: number }[];
  utang: { givenMinor: number; collectedMinor: number }; cash: { expectedMinor: number };
  stockIn: { documents: number }; trips: { releasedOut: number; receivedIn: number; returnedIn: number };
  resack: { jobs: number; lossGrams: number; lossValueMinor: number }; writeOffs: { count: number; valueMinor: number }; counts: { kulangMinor: number; sobraMinor: number };
  kargadors: { name: string; transactions: number }[];
  openHandOffs: { trips: { docNumber: string | null; status: string; product: string }[]; resacks: { docNumber: string; product: string }[] };
  afterClose?: { count: number; totalMinor: number; cashMinor: number } | null;
}

function Daily({ owner }: { owner: boolean }) {
  const [date, setDate] = useState(today());
  const [data, setData] = useState<{ sections: DaySection[]; total: Record<string, number> } | null>(null);
  const [closing, setClosing] = useState<DaySection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await getJson(`/admin/rice/daily?date=${date}`);
    if (!r.ok) { setError(errText(r.data, "Could not load")); return; }
    setError(null);
    setData(r.data as never);
  }, [date]);
  useEffect(() => { void load(); }, [load]);
  if (closing) return <CloseDay section={closing} date={date} onCancel={() => setClosing(null)} onDone={async () => { setClosing(null); await load(); }} />;
  return (
    <div>
      <div className="d-flex gap-2 mb-3 align-items-center">
        <input type="date" className="form-control" style={{ maxWidth: 200 }} aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} />
        {data && <button type="button" className="btn btn-outline-dark btn-sm" onClick={() => downloadCsv(`report-${date}.csv`, [["Location", "Sales", "Cash", "GCash", "Credit", ...(owner ? ["Profit"] : []), "Credit paid", "Expected cash", "Counted cash", "Write-offs", "Resack short", "Count short"], ...data.sections.map((s) => [s.location.name, s.sales.totalMinor / 100, s.sales.cashMinor / 100, s.sales.gcashMinor / 100, s.sales.utangMinor / 100, ...(owner ? [(s.sales.grossProfitMinor ?? 0) / 100] : []), s.utang.collectedMinor / 100, s.cash.expectedMinor / 100, s.cashCountedMinor === null ? "" : s.cashCountedMinor / 100, s.writeOffs.valueMinor / 100, s.resack.lossValueMinor / 100, s.counts.kulangMinor / 100])])}>Excel</button>}
      </div>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {data && owner && (
        <div className="alert alert-light border" style={{ fontVariantNumeric: "tabular-nums" }}>
          All: sales <strong>{peso(data.total.salesMinor ?? 0)}</strong> · profit <strong>{peso(data.total.grossProfitMinor ?? 0)}</strong> · credit paid {peso(data.total.utangCollectedMinor ?? 0)} · write-offs {peso(data.total.writeOffMinor ?? 0)}
          {data.total.netProfitMinor !== undefined && <> · expenses {peso(data.total.expensesMinor ?? 0)} · <strong className={data.total.netProfitMinor < 0 ? "text-danger" : "text-success"}>net profit {peso(data.total.netProfitMinor)}</strong></>}
        </div>
      )}
      <div className="d-grid gap-3" style={{ maxWidth: 760 }}>
        {data?.sections.map((s) => (
          <div key={s.location.id} className="card">
            <div className="card-body" style={{ fontVariantNumeric: "tabular-nums" }}>
              <div className="d-flex justify-content-between align-items-center">
                <h2 className="h5 mb-0">{s.location.name}</h2>
                {s.locked ? <span className="badge text-bg-secondary">Closed {s.closedAt ? new Date(s.closedAt).toLocaleTimeString("en-PH") : ""}</span>
                  : date === today() ? <button type="button" className="btn btn-success" onClick={() => setClosing(s)}>Closing</button> : null}
              </div>
              <div className="fs-4 mt-1">Sales {peso(s.sales.totalMinor)} <span className="fs-6 text-muted">({s.sales.count})</span></div>
              <div className="small">Cash {peso(s.sales.cashMinor)} · GCash {peso(s.sales.gcashMinor)} · Credit {peso(s.sales.utangMinor)}{s.sales.encodedLater ? ` · ${s.sales.encodedLater} from paper slips` : ""}</div>
              {owner && <div className="small">Profit (gross) {peso(s.sales.grossProfitMinor)}{s.sales.profitShareMinor ? <span className="text-muted"> (incl. profit share {s.sales.profitShareMinor > 0 ? "+" : "−"}{peso(Math.abs(s.sales.profitShareMinor))})</span> : null}</div>}
              <div className="small">Kilos: {s.kilosByVariety.map((v) => `${v.variety} ${kg(v.grams)}`).join(" · ") || "—"}</div>
              <div className="small">Credit given {peso(s.utang.givenMinor)} · paid {peso(s.utang.collectedMinor)}</div>
              <div className="small">Cash that should be in the drawer {peso(s.cash.expectedMinor)}{s.cashCountedMinor !== null && <> · counted {peso(s.cashCountedMinor)} <strong className={s.cashVarianceMinor && s.cashVarianceMinor < 0 ? "text-danger" : ""}>({s.cashVarianceMinor! >= 0 ? "+" : ""}{peso(s.cashVarianceMinor!)})</strong></>}</div>
              <div className="small">Transfers: out {s.trips.releasedOut} · in {s.trips.receivedIn} · returned {s.trips.returnedIn} · Stock in (supplier) {s.stockIn.documents}</div>
              <div className="small">Resack {s.resack.jobs} (short {kg(s.resack.lossGrams)}, {peso(s.resack.lossValueMinor)}) · Write-offs {s.writeOffs.count} ({peso(s.writeOffs.valueMinor)}) · Counts: short <span className="text-danger">{peso(s.counts.kulangMinor)}</span>, over {peso(s.counts.sobraMinor)}</div>
              {s.kargadors.length > 0 && <div className="small">Porters: {s.kargadors.map((k) => `${k.name} ${k.transactions}`).join(" · ")}</div>}
              {s.afterClose && s.afterClose.count + s.afterClose.cashMinor > 0 && (
                <div className="alert alert-danger py-1 px-2 mt-2 mb-0 small">
                  <strong>After closing:</strong> sales {peso(s.afterClose.totalMinor)} ({s.afterClose.count}) · cash taken in {peso(s.afterClose.cashMinor)} — not included in the closed report above.
                </div>
              )}
              {(s.openHandOffs.trips.length + s.openHandOffs.resacks.length) > 0 && (
                <div className="alert alert-warning py-1 px-2 mt-2 mb-0 small">Still open: {[...s.openHandOffs.trips.map((t) => `${t.docNumber} ${t.product}`), ...s.openHandOffs.resacks.map((r) => `${r.docNumber} ${r.product}`)].join(" · ")}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CloseDay({ section, date, onCancel, onDone }: { section: DaySection; date: string; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [cash, setCash] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counted = Math.round(Number(cash || "0") * 100);
  // Step 2 (optional) is done right here: the closing count of this location, today (the 5 items that sold most).
  const [closingCount, setClosingCount] = useState<CountRow | null>(null);
  const [sheet, setSheet] = useState<CountDetail | null>(null);
  const manilaDay = (iso: string) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);
  const loadClosing = useCallback(async () => {
    const r = await getJson(`/admin/counts?locationId=${encodeURIComponent(section.location.id)}`);
    const rows = (r.ok ? (r.data?.counts as CountRow[] | undefined) : undefined) ?? [];
    setClosingCount(rows.find((c) => c.kind === "CLOSING" && c.status !== "CANCELLED" && manilaDay(c.startedAt) === date) ?? null);
  }, [section.location.id, date]);
  useEffect(() => { void loadClosing(); }, [loadClosing]);
  const openSheet = async (id: string) => {
    const r = await getJson(`/admin/counts/${id}`);
    if (!r.ok) { setError(errText(r.data, "Could not open the count")); return; }
    setSheet(r.data as unknown as CountDetail);
  };
  const startClosingCount = async () => {
    setError(null);
    const res = await fetch(`${API_URL}/admin/counts/closing`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ locationId: section.location.id }) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok || !d) { setError(errText(d, "Could not start the count")); return; }
    await openSheet(String(d.id));
  };
  const save = async () => {
    setBusy(true); setError(null);
    const res = await fetch(`${API_URL}/admin/rice/close`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ locationId: section.location.id, date, cashCountedMinor: counted, signatures: [{ signerKind: "STAFF", imagePng: sig }] }) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    setBusy(false);
    if (!res.ok) { setError(errText(d, "Could not close")); return; }
    toast("The day is closed — sent to the owner");
    await onDone();
  };
  return (
    <div className="card border-success" style={{ maxWidth: 520, fontSize: 18 }}>
      <div className="card-body">
        <div className="small text-muted">Closing · {section.location.name} · {date}</div>
        <h2 className="h5">1. Count the cash in the drawer</h2>
        <p className="mb-2">Should be: <strong>{peso(section.cash.expectedMinor)}</strong> (cash sales and cash credit payments today, not counting the change fund)</p>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <NumPad value={cash} onChange={setCash} decimals={2} label="Cash counted" unit="₱" />
        {cash && <div className={`fs-5 mt-2 ${counted - section.cash.expectedMinor < 0 ? "text-danger" : ""}`}>{counted - section.cash.expectedMinor === 0 ? "Correct" : counted - section.cash.expectedMinor < 0 ? `Short ${peso(section.cash.expectedMinor - counted)}` : `Over ${peso(counted - section.cash.expectedMinor)}`}</div>}
        <h2 className="h5 mt-3">2. Count 5 items <span className="fw-normal text-muted">(optional)</span></h2>
        <p className="small text-muted mb-2">A quick check that the shelf matches the book, on the 5 items that sold most in the last day (or the biggest stock if nothing was sold). You can skip it: the day closes without it.</p>
        {sheet ? (
          <CountSheet count={sheet} owner={false} onClose={async () => { setSheet(null); await loadClosing(); }} onReload={() => void openSheet(sheet.id)} />
        ) : closingCount && closingCount.status !== "OPEN" ? (
          <p className="text-success mb-2"><i className="bi bi-check-circle me-1" aria-hidden="true"></i>Done — {closingCount.docNumber}{closingCount.kulangValueMinor > 0 ? <span className="text-danger"> · short {peso(closingCount.kulangValueMinor)}</span> : null}</p>
        ) : (
          <button type="button" className="btn btn-outline-dark btn-lg mb-2" onClick={() => void (closingCount ? openSheet(closingCount.id) : startClosingCount())}>
            {closingCount ? `Continue the count (${closingCount.docNumber})` : "Count the 5 items now"}
          </button>
        )}
        <h2 className="h5">3. Still open <span className="fw-normal text-muted small">(for your information)</span></h2>
        <p className="small">{(section.openHandOffs.trips.length + section.openHandOffs.resacks.length) === 0 ? "None." : [...section.openHandOffs.trips.map((t) => `${t.docNumber} ${t.product}`), ...section.openHandOffs.resacks.map((r) => `${r.docNumber} ${r.product}`)].join(" · ")}</p>
        <div className="fw-semibold">4. Your signature</div>
        <SignaturePad onSignature={setSig} />
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>Back</button>
          <button type="button" className="btn btn-success btn-lg" disabled={busy || !sig || cash === ""} onClick={() => void save()}>{busy ? "Please wait…" : "Close the day"}</button>
        </div>
      </div>
    </div>
  );
}

function Monthly() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void getJson(`/admin/rice/monthly?month=${month}`).then((r) => { if (!r.ok) setError(errText(r.data, "Could not load")); else { setError(null); setData(r.data); } }); }, [month]);
  const d = data as null | {
    profit?: { grossProfitMinor: number; expensesMinor: number; netProfitMinor: number };
    locations: { location: Loc; salesMinor: number; grossProfitMinor: number; profitShareMinor?: number; grams: number; resackLossPct: number; transitShortGrams: number; writeOffMinor: number }[];
    varieties: { variety: string; grams: number; salesMinor: number; grossProfitMinor: number }[];
    kargadorLoss: { name: string; resackLossPct: number; transitShortGrams: number }[];
    utangAging: { d0_30: number; d31_60: number; d60plus: number }; manualItemsForReview: number;
    turnover: { ratio: number | null }; kargadorPay: { name: string; count: number; transactions: { date: string; kind: string; docNumber: string }[] }[];
  };
  return (
    <div style={{ fontVariantNumeric: "tabular-nums", maxWidth: 820 }}>
      <input type="month" className="form-control mb-3" style={{ maxWidth: 200 }} aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} />
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {d && (
        <>
          {d.profit && (
            <div className="alert alert-light border">
              Gross profit <strong>{peso(d.profit.grossProfitMinor)}</strong> − expenses <strong>{peso(d.profit.expensesMinor)}</strong> = <strong className={d.profit.netProfitMinor < 0 ? "text-danger" : "text-success"}>net profit {peso(d.profit.netProfitMinor)}</strong>
            </div>
          )}
          <h2 className="h6">Sales and profit by location <button type="button" className="btn btn-link btn-sm" onClick={() => downloadCsv(`month-${month}.csv`, [["Location", "Sales", "Profit", "Kilos", "Resack short %", "Transfer short (kg)", "Write-offs"], ...d.locations.map((l) => [l.location.name, l.salesMinor / 100, l.grossProfitMinor / 100, l.grams / 1000, l.resackLossPct, l.transitShortGrams / 1000, l.writeOffMinor / 100])])}>Excel</button></h2>
          <table className="table table-sm"><thead><tr><th>Location</th><th className="text-end">Sales</th><th className="text-end">Profit</th><th className="text-end">Kilos</th><th className="text-end">Resack short</th><th className="text-end">Write-offs</th></tr></thead>
            <tbody>{d.locations.map((l) => <tr key={l.location.id}><td>{l.location.name}</td><td className="text-end">{peso(l.salesMinor)}</td><td className="text-end">{peso(l.grossProfitMinor)}{l.profitShareMinor ? <div className="small text-muted">incl. profit share {l.profitShareMinor > 0 ? "+" : "−"}{peso(Math.abs(l.profitShareMinor))}</div> : null}</td><td className="text-end">{kg(l.grams)}</td><td className="text-end">{l.resackLossPct}%</td><td className="text-end">{peso(l.writeOffMinor)}</td></tr>)}</tbody></table>
          <h2 className="h6">By rice variety</h2>
          <table className="table table-sm"><tbody>{d.varieties.map((v) => <tr key={v.variety}><td className="text-capitalize">{v.variety}</td><td className="text-end">{kg(v.grams)}</td><td className="text-end">{peso(v.salesMinor)}</td><td className="text-end">profit {peso(v.grossProfitMinor)}</td></tr>)}</tbody></table>
          <h2 className="h6">Credit (age)</h2>
          <p>0–30 days {peso(d.utangAging.d0_30)} · 31–60 {peso(d.utangAging.d31_60)} · <span className="text-danger">60+ {peso(d.utangAging.d60plus)}</span></p>
          <p className="small">Turnover {d.turnover.ratio ?? "—"} · New items to review: {d.manualItemsForReview}</p>
          <h2 className="h6">Porters — short</h2>
          <table className="table table-sm"><tbody>{d.kargadorLoss.map((k) => <tr key={k.name}><td>{k.name}</td><td className="text-end">resack {k.resackLossPct}%</td><td className="text-end">transfer {kg(k.transitShortGrams)}</td></tr>)}</tbody></table>
          <h2 className="h6">Porter pay (per transaction) <button type="button" className="btn btn-link btn-sm" onClick={() => downloadCsv(`porter-${month}.csv`, [["Porter", "Date", "Type", "Document"], ...d.kargadorPay.flatMap((k) => k.transactions.map((t) => [k.name, t.date, t.kind, t.docNumber]))])}>Excel</button></h2>
          <table className="table table-sm"><tbody>{d.kargadorPay.map((k) => <tr key={k.name}><td>{k.name}</td><td className="text-end fw-semibold">{k.count}</td></tr>)}</tbody></table>
        </>
      )}
    </div>
  );
}

function Kulang() {
  const [data, setData] = useState<{ items: { product: string; loose: boolean; location: string; countDoc: string; kulangQty: number; kulangValueMinor: number; people: string[]; kargadors: string[]; since: { docNumber: string } | null }[] } | null>(null);
  useEffect(() => { void getJson("/admin/rice/balance").then((r) => r.ok && setData(r.data as never)); }, []);
  if (!data) return null;
  return (
    <div style={{ maxWidth: 760 }}>
      {data.items.length === 0 ? <p className="text-muted">No shortages in counts this past month.</p> : (
        <div className="list-group">
          {data.items.map((i, n) => (
            <div key={n} className="list-group-item">
              <div className="d-flex justify-content-between"><strong>{i.product}</strong><span className="text-danger fw-semibold">Short {qty(i.loose, i.kulangQty)} · {peso(i.kulangValueMinor)}</span></div>
              <div className="small text-muted">{i.location} · {i.countDoc}{i.since ? ` (since ${i.since.docNumber})` : ""}</div>
              <div className="small">Handled by: {[...i.people, ...i.kargadors.map((k) => `${k} (porter)`)].join(", ") || "—"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Trace() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ type: string; docNumber: string; signatures: { step: string; signer: string; at: string; location: string | null }[]; movements: { type: string; delta: number; product: string | null; location: string | null; by: string | null; at: string }[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    const r = await getJson(`/admin/rice/trace?q=${encodeURIComponent(q.trim())}`);
    if (!r.ok) { setError(errText(r.data, "Nothing found")); return; }
    setError(null);
    setResults((r.data?.results ?? []) as never);
  };
  return (
    <div style={{ maxWidth: 760 }}>
      <div className="d-flex gap-2 mb-3">
        <input className="form-control form-control-lg" placeholder="REL-000123, customer name, porter, staff or rice" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} />
        <button type="button" className="btn btn-success btn-lg" onClick={() => void search()}>Search</button>
      </div>
      {error && <div className="alert alert-danger py-2">{error}</div>}
      {results?.length === 0 && <p className="text-muted">Nothing found.</p>}
      {results?.map((r) => (
        <div key={r.docNumber} className="card mb-2">
          <div className="card-body small">
            <div className="fw-semibold fs-6">{r.docNumber} <span className="badge text-bg-light border">{r.type}</span></div>
            {r.signatures.map((s, i) => <div key={i}>✍ {s.step} — {s.signer}{s.location ? ` @ ${s.location}` : ""} · {new Date(s.at).toLocaleString("en-PH")}</div>)}
            {r.movements.filter((m) => !["RESERVE", "RELEASE_RESERVATION"].includes(m.type)).map((m, i) => <div key={i} className="text-muted">↔ {m.type} {m.delta > 0 ? "+" : ""}{m.delta} {m.product ?? ""} @ {m.location ?? ""} · {m.by ?? ""} · {new Date(m.at).toLocaleString("en-PH")}</div>)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Alerts() {
  const [a, setA] = useState<null | { approvals: { id: string; kind: string; summary: string }[]; bigKulang: { docNumber: string; kulangValueMinor: number; location: string }[]; lateReleases: { docNumber: string | null; product: string; kargador: string | null; releasedAt: string }[]; unfinishedResacks: { docNumber: string; location: string }[]; utang: { name: string | null; balanceMinor: number; overLimit: boolean; oldestDays: number }[]; staleDrafts: number; ledgerMismatch: number }>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const load = () => void getJson("/admin/rice/alerts").then((r) => r.ok && setA(r.data as never));
    load();
    timer.current = setInterval(load, 60_000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);
  if (!a) return null;
  const none = !a.approvals.length && !a.bigKulang.length && !a.lateReleases.length && !a.unfinishedResacks.length && !a.utang.length && !a.staleDrafts && !a.ledgerMismatch;
  return (
    <div style={{ maxWidth: 720 }}>
      {none && <div className="alert alert-success">Nothing to check right now.</div>}
      {a.approvals.length > 0 && <div className="alert alert-warning"><strong>{a.approvals.length} waiting in For your approval.</strong><ul className="mb-0 small">{a.approvals.slice(0, 5).map((x) => <li key={x.id}>{x.summary}</li>)}</ul></div>}
      {a.bigKulang.map((c) => <div key={c.docNumber} className="alert alert-danger py-2">Count {c.docNumber} at {c.location}: short {peso(c.kulangValueMinor)}</div>)}
      {a.lateReleases.map((t, i) => <div key={i} className="alert alert-danger py-2">{t.docNumber} {t.product} — released {new Date(t.releasedAt).toLocaleTimeString("en-PH")}, not delivered yet{t.kargador ? ` (${t.kargador})` : ""}</div>)}
      {a.unfinishedResacks.map((r) => <div key={r.docNumber} className="alert alert-warning py-2">Resack {r.docNumber} at {r.location} — not finished yesterday</div>)}
      {a.utang.map((u, i) => <div key={i} className="alert alert-warning py-2">{u.name} owes {peso(u.balanceMinor)}{u.overLimit ? " — over the limit" : ""}{u.oldestDays > 60 ? ` — ${u.oldestDays} days old` : ""}</div>)}
      {a.staleDrafts > 0 && <div className="alert alert-info py-2">{a.staleDrafts} unfinished tasks (To finish) older than 2 hours.</div>}
      {a.ledgerMismatch > 0 && <div className="alert alert-danger py-2">{a.ledgerMismatch} stock records do not match the ledger — report this right away.</div>}
    </div>
  );
}

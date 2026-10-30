"use client";

// Store payable: what each store owes the main store for rice that left without a record, less the profit
// share the main store owes it for rice it took from that store (below zero: the main store owes the store).
//   Balance cards   one per store: owes, profit share, paid, balance — Record payment / Pay the store / Statement
//   To charge       shortages found by counts that nobody has been charged for yet (at the main store's cost price)
//   Add by hand     charge a quantity directly
//   All entries     every charge, payment and undo, newest first
// Owner and manager only (it shows cost).

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { askText } from "../../lib/ask";
import { toast } from "../../lib/toast";
import { printSlip } from "../../lib/slip-print";
import { PesoInput, KiloInput, WholeInput } from "../NumberBoxes";
import { peso, kg } from "../../lib/number-format";

const qtyText = (loose: boolean, q: number) => (loose ? kg(q) : `${q.toLocaleString("en-PH")} pcs`);
const KIND: Record<string, { label: string; badge: string }> = {
  CHARGE: { label: "Charge", badge: "text-bg-warning" }, PAYMENT: { label: "Payment", badge: "text-bg-success" }, REVERSAL: { label: "Undo", badge: "text-bg-secondary" },
  PROFIT_SHARE: { label: "Profit share", badge: "text-bg-info" }, SHARE_BACK: { label: "Share taken back", badge: "text-bg-light border" },
};
/** A payment is the store paying (−), or the main store paying the store its profit share (+). */
const kindLabel = (kind: string, amountMinor: number) => (kind === "PAYMENT" && amountMinor > 0 ? "Paid to the store" : KIND[kind]?.label ?? kind);

interface Bal { id: string; name: string; code: string | null; isMain: boolean; chargesMinor: number; paymentsMinor: number; reversedMinor: number; sharesMinor?: number; owesMinor: number; consignment?: boolean; lastPaymentAt?: string | null; lastCountAt?: string | null; weeklyDue?: boolean; countDue?: boolean }
interface ToCharge { lineId: string; countDoc: string; countedAt: string | null; atId: string; at: string; productId: string; name: string; loose: boolean; quantity: number; unitCostMinor: number; amountMinor: number }
interface Entry { id: string; docNumber: string; kind: string; locationId: string; store: string; amountMinor: number; productName: string | null; loose: boolean; quantity: number | null; unitCostMinor: number | null; note: string | null; by: string | null; at: string; reversed: boolean; canReverse: boolean }
interface Summary { stores: Bal[]; toAssign: ToCharge[]; entries: Entry[]; totalOwesMinor: number }
interface ProductOption { id: string; name: string; loose: boolean }
type Body = { message?: string; errors?: string[] };

async function call(path: string, method: "GET" | "POST", body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { "Content-Type": "application/json", ...adminHeaders() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as (Body & Record<string, unknown>) | null };
}
const errText = (d: Body | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;

export default function PayablePanel() {
  const [data, setData] = useState<Summary | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [debtor, setDebtor] = useState("");
  const [paying, setPaying] = useState<Bal | null>(null);
  /** The payment goes the other way: the main store pays the store its profit share. */
  const payingToStore = !!paying && paying.owesMinor < 0;
  const [payAmount, setPayAmount] = useState("");
  const [payNote, setPayNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [recon, setRecon] = useState<{ store: { name: string }; rows: { productId: string; name: string; loose: boolean; supplied: number; sold: number; returned: number; movedBack: number; countFix: number; resack: number; onHand: number; costOwedMinor: number; profitShareMinor?: number }[]; varieties?: { variety: string; suppliedG: number; soldG: number; returnedG: number; movedBackG: number; countFixG: number; onHandG: number }[] } | null>(null);
  const [sales, setSales] = useState<{ store: { id: string; name: string }; fromAt: string; expectedMinor: number; recent: { id: string; toAt: string; reportedMinor: number; expectedMinor: number; differenceMinor: number }[] } | null>(null);
  const [salesAmt, setSalesAmt] = useState("");
  const openSales = async (s: Bal) => {
    const r = await call(`/admin/payable/sales-check?locationId=${encodeURIComponent(s.id)}`, "GET");
    if (!r.ok) { setError(errText(r.data, "Could not load the sales check")); return; }
    setSalesAmt("");
    setSales(r.data as unknown as NonNullable<typeof sales>);
  };
  const checkShelf = async (s: Bal) => {
    const r = await call(`/admin/payable/reconcile?locationId=${encodeURIComponent(s.id)}`, "GET");
    if (!r.ok) { setError(errText(r.data, "Could not check the shelf")); return; }
    setRecon(r.data as unknown as NonNullable<typeof recon>);
  };
  const [add, setAdd] = useState({ productId: "", qty: "", note: "" });

  const load = useCallback(async () => {
    const r = await call("/admin/payable/summary", "GET");
    if (!r.ok) { setError(errText(r.data, "Could not load Store payable")); return; }
    const d = r.data as unknown as Summary;
    setData(d);
    setDebtor((cur) => cur || d.stores.find((s) => !s.isMain)?.id || "");
  }, []);

  useEffect(() => {
    void load().catch(() => setError("Could not load Store payable"));
    fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((ps) => {
      setProducts(((ps?.products ?? ps?.items ?? []) as { id: string; name: string; stockBaseUnit?: string | null; stockBaseQuantity?: number | null }[]).map((p) => ({ id: p.id, name: p.name, loose: (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1 })));
    }).catch(() => undefined);
  }, [load]);

  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true); setError(null);
    const r = await call(path, "POST", body);
    setBusy(false);
    if (!r.ok) { setError(errText(r.data, "That did not go through")); return false; }
    toast(done);
    await load();
    return true;
  };

  const chargeLine = (l: ToCharge) => act("/admin/payable/charge-count", { lineId: l.lineId, locationId: debtor }, `Charged ${peso(l.amountMinor)}`);
  const chargeAll = async () => {
    if (!data) return;
    const lines = data.toAssign.filter((l) => l.atId !== debtor);
    for (const l of lines) { if (!(await chargeLine(l))) return; }
  };
  const undo = async (e: Entry) => {
    const reason = await askText(`Why undo ${e.docNumber}?`, { ok: "Undo", danger: true });
    if (!reason) return;
    await act(`/admin/payable/entries/${e.id}/reverse`, { reason }, "Undone");
  };
  const mainName = data?.stores.find((x) => x.isMain)?.name ?? "Store 1";
  const statement = async (b: Bal) => {
    const r = await call(`/admin/payable/statement?locationId=${b.id}`, "GET");
    if (!r.ok) { setError(errText(r.data, "Could not load the statement")); return; }
    const s = r.data as unknown as { store: { name: string }; owesMinor: number; entries: { docNumber: string; kind: string; at: string; productName: string | null; loose: boolean; quantity: number | null; amountMinor: number; balanceMinor: number; note: string | null }[] };
    printSlip({
      storeName: "Store payable", title: `STATEMENT — ${s.store.name}`, when: new Date().toLocaleString(),
      rows: s.entries.map((e) => ({ name: `${e.docNumber} ${e.kind === "CHARGE" ? (e.productName ?? "Charge") : `${kindLabel(e.kind, e.amountMinor)}${e.kind !== "PAYMENT" && e.productName ? ` ${e.productName}` : ""}`}`, qty: e.quantity !== null && e.productName ? qtyText(e.loose, e.quantity) : "", note: `${e.amountMinor < 0 ? "−" : ""}${peso(Math.abs(e.amountMinor))} → ${peso(e.balanceMinor)}` })),
      totals: [{ label: s.owesMinor < 0 ? `${mainName} owes ${s.store.name}` : `${s.store.name} owes`, value: peso(Math.abs(s.owesMinor)) }],
    });
  };

  if (!data) return <div className="container py-3">{error ? <div className="alert alert-danger">{error}</div> : <p className="text-muted">Loading…</p>}</div>;
  const others = data.stores.filter((s) => !s.isMain);
  const pickable = data.toAssign.filter((l) => l.atId !== debtor);
  const toChargeTotal = pickable.reduce((a, l) => a + l.amountMinor, 0);
  const prod = products.find((p) => p.id === add.productId);

  return (
    <div className="container-fluid py-3" style={{ maxWidth: 900 }}>
      <h5 className="mb-1">Store payable</h5>
      <p className="text-muted small">What each store owes the main store for rice it sold or lost, at the main store&apos;s cost price, less the profit share the main store owes it for rice taken from that store.</p>
      {error && <div className="alert alert-danger py-2">{error}</div>}

      <div className="row g-2 mb-3">
        {others.map((s) => (
          <div key={s.id} className="col-12 col-md-6">
            <div className={`border rounded p-3 ${s.owesMinor > 0 ? "border-warning" : s.owesMinor < 0 ? "border-info" : ""}`}>
              <div className="small text-muted">{s.owesMinor < 0 ? `${mainName} owes ${s.name}` : `${s.name} owes`}</div>
              <div className="fs-3 fw-semibold">{peso(Math.abs(s.owesMinor))}</div>
              <div className="small text-muted mb-2">Charged {peso(s.chargesMinor)}{s.sharesMinor ? <> · Profit share −{peso(s.sharesMinor)}</> : null} · Paid {peso(s.paymentsMinor)}</div>
              {(s.weeklyDue || s.countDue) && (
                <div className="mb-2">
                  {s.weeklyDue && <span className="badge text-bg-danger me-1">Weekly payment due</span>}
                  {s.countDue && <span className="badge text-bg-warning">Count the shelf this week</span>}
                </div>
              )}
              <div className="d-flex flex-wrap gap-2">
                {s.owesMinor < 0
                  ? <button type="button" className="btn btn-success text-nowrap" onClick={() => { setPaying(s); setPayAmount(""); setPayNote(""); }}>Pay {s.name}</button>
                  : <button type="button" className="btn btn-success text-nowrap" disabled={s.owesMinor <= 0} onClick={() => { setPaying(s); setPayAmount(""); setPayNote(""); }}>Record payment</button>}
                <button type="button" className="btn btn-outline-dark text-nowrap" onClick={() => void statement(s)}>Print statement</button>
                <button type="button" className="btn btn-outline-dark text-nowrap" onClick={() => void checkShelf(s)}>Check shelf</button>
                {s.consignment && <button type="button" className="btn btn-outline-dark text-nowrap" onClick={() => void openSales(s)}>Weekly sales total</button>}
              </div>
            </div>
          </div>
        ))}
        {others.length === 0 && <p className="text-muted">Add another store in Warehouses first.</p>}
      </div>

      {recon && (
        <div className="border rounded p-3 mb-3">
          <div className="d-flex justify-content-between mb-2"><div className="fw-semibold">{recon.store.name}: supplied − sold − returned − moved back ± count = on shelf</div><button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setRecon(null)}>Close</button></div>
          <div className="table-responsive"><table className="table table-sm mb-0">
            <thead><tr><th>Item</th><th className="text-end">Supplied</th><th className="text-end">Sold</th><th className="text-end">Returned</th><th className="text-end">Moved back</th><th className="text-end">Resack from count</th><th className="text-end">Count fix</th><th className="text-end">On shelf</th><th className="text-end">Cost owed</th><th className="text-end">Profit share</th></tr></thead>
            <tbody>{recon.rows.map((r) => {
              const f = (n: number) => (r.loose ? `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} kg` : n.toLocaleString());
              return <tr key={r.productId}><td>{r.name}</td><td className="text-end">{f(r.supplied)}</td><td className="text-end">{f(r.sold)}</td><td className="text-end">{f(r.returned)}</td><td className="text-end">{f(r.movedBack)}</td><td className="text-end">{f(r.resack)}</td><td className={`text-end ${r.countFix < 0 ? "text-danger" : ""}`}>{f(r.countFix)}</td><td className="text-end fw-semibold">{f(r.onHand)}</td><td className="text-end">{peso(r.costOwedMinor)}</td><td className="text-end">{r.profitShareMinor ? `−${peso(r.profitShareMinor)}` : ""}</td></tr>;
            })}</tbody>
          </table></div>
          {(recon.varieties?.length ?? 0) > 0 && (
            <>
              <div className="fw-semibold mt-3 mb-1">In kilos, per rice variety (sacks, bags and loose together)</div>
              <div className="table-responsive"><table className="table table-sm mb-0">
                <thead><tr><th>Variety</th><th className="text-end">Supplied</th><th className="text-end">Sold</th><th className="text-end">Returned</th><th className="text-end">Moved back</th><th className="text-end">Gone by count</th><th className="text-end">On shelf</th></tr></thead>
                <tbody>{recon.varieties!.map((v) => {
                  const kg = (g: number) => `${(g / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} kg`;
                  return <tr key={v.variety}><td className="text-capitalize">{v.variety}</td><td className="text-end">{kg(v.suppliedG)}</td><td className="text-end">{kg(v.soldG)}</td><td className="text-end">{kg(v.returnedG)}</td><td className="text-end">{kg(v.movedBackG)}</td><td className={`text-end ${v.countFixG < 0 ? "text-danger" : ""}`}>{kg(v.countFixG)}</td><td className="text-end fw-semibold">{kg(v.onHandG)}</td></tr>;
                })}</tbody>
              </table></div>
              <div className="small text-muted mt-1">&quot;Gone by count&quot; is rice the count found missing. With no POS, that is rice sold (or lost); the store pays Store 1&apos;s cost for it.</div>
            </>
          )}
        </div>
      )}

      {sales && (
        <div className="border rounded p-3 mb-3">
          <div className="d-flex justify-content-between mb-2"><div className="fw-semibold">{sales.store.name}: weekly sales total</div><button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setSales(null)}>Close</button></div>
          <div className="small text-muted mb-2">Rice that left since {new Date(sales.fromAt).toLocaleDateString()} is worth <strong>{peso(sales.expectedMinor)}</strong> at the selling price. Enter the cash and payments the store collected for the same time.</div>
          <div className="row g-2 align-items-end">
            <div className="col-8 col-md-4"><label className="form-label small mb-1" htmlFor="ss-amt">Collected</label><PesoInput id="ss-amt" className="form-control form-control-lg" value={salesAmt} onChange={setSalesAmt} placeholder="0.00" /></div>
            <div className="col-4 col-md-3"><button type="button" className="btn btn-success btn-lg w-100" disabled={busy || salesAmt === ""} onClick={async () => { if (await act("/admin/payable/sales-report", { locationId: sales.store.id, reportedMinor: Math.round(Number(salesAmt) * 100) }, "Sales total saved")) await openSales({ id: sales.store.id } as Bal); }}>Save</button></div>
          </div>
          {sales.recent.length > 0 && (
            <div className="table-responsive mt-3"><table className="table table-sm mb-0">
              <thead><tr><th>Date</th><th className="text-end">Collected</th><th className="text-end">Rice worth</th><th className="text-end">Difference</th></tr></thead>
              <tbody>{sales.recent.map((r) => <tr key={r.id}><td>{new Date(r.toAt).toLocaleDateString()}</td><td className="text-end">{peso(r.reportedMinor)}</td><td className="text-end">{peso(r.expectedMinor)}</td><td className={`text-end ${r.differenceMinor < 0 ? "text-danger fw-semibold" : ""}`}>{peso(r.differenceMinor)}</td></tr>)}</tbody>
            </table></div>
          )}
          <div className="small text-muted mt-2">A negative difference means the store collected less than the rice is worth: ask why.</div>
        </div>
      )}

      {paying && (
        <div className="border rounded p-3 mb-3 bg-body-tertiary">
          <div className="fw-semibold mb-2">{payingToStore ? `${mainName} pays ${paying.name} its profit share (${peso(-paying.owesMinor)} owed)` : `${paying.name} pays (${peso(paying.owesMinor)} owed)`}</div>
          <div className="row g-2 align-items-end">
            <div className="col-6 col-md-4"><label className="form-label small mb-1" htmlFor="pp-amt">Amount paid</label><PesoInput id="pp-amt" className="form-control form-control-lg" value={payAmount} onChange={setPayAmount} placeholder="0.00" /></div>
            <div className="col-12 col-md-4"><label className="form-label small mb-1" htmlFor="pp-note">Note (optional)</label><input id="pp-note" className="form-control form-control-lg" value={payNote} maxLength={200} onChange={(e) => setPayNote(e.target.value)} /></div>
            <div className="col-12 col-md-4 d-flex gap-2">
              <button type="button" className="btn btn-outline-secondary btn-lg text-nowrap" onClick={() => setPaying(null)}>Cancel</button>
              <button type="button" className="btn btn-success btn-lg flex-fill text-nowrap" disabled={busy || !(Number(payAmount) > 0)} onClick={async () => { if (await act("/admin/payable/payment", { locationId: paying.id, amountMinor: Math.round(Number(payAmount) * 100), note: payNote, toStore: payingToStore }, "Payment recorded")) setPaying(null); }}>Save payment</button>
            </div>
          </div>
        </div>
      )}

      <h6>To charge — shortages found by counts</h6>
      {data.toAssign.length === 0 ? <p className="text-muted small">Nothing waiting. When a count finds rice missing at the main store, it shows here.</p> : (
        <>
          <div className="d-flex flex-wrap gap-2 align-items-end mb-2">
            <div>
              <label className="form-label small mb-1" htmlFor="pp-debtor">Charge to</label>
              <select id="pp-debtor" className="form-select" value={debtor} onChange={(e) => setDebtor(e.target.value)}>
                {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <button type="button" className="btn btn-primary" disabled={busy || !debtor || pickable.length === 0} onClick={() => void chargeAll()}>Charge all ({peso(toChargeTotal)})</button>
          </div>
          <div className="table-responsive">
            <table className="table table-sm align-middle">
              <thead><tr><th>Item</th><th className="text-end">Missing</th><th className="text-end">Cost</th><th className="text-end">Amount</th><th /></tr></thead>
              <tbody>
                {data.toAssign.map((l) => (
                  <tr key={l.lineId}>
                    <td>{l.name}<div className="small text-muted">{l.countDoc} · {l.at}{l.countedAt ? ` · ${new Date(l.countedAt).toLocaleDateString()}` : ""}</div></td>
                    <td className="text-end">{qtyText(l.loose, l.quantity)}</td>
                    <td className="text-end">{peso(l.unitCostMinor)}{l.loose ? <span className="small text-muted"> /kg</span> : ""}</td>
                    <td className="text-end fw-semibold">{peso(l.amountMinor)}</td>
                    <td className="text-end"><button type="button" className="btn btn-sm btn-outline-primary" disabled={busy || !debtor || l.atId === debtor} onClick={() => void chargeLine(l)}>Charge</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small text-muted">The rice is counted as taken by the store you choose; no stock is added to it. Not every shortage is a store&apos;s fault — leave out what is a loss.</p>
        </>
      )}

      <div className="mb-3">
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add a charge by hand"}</button>
        {adding && (
          <div className="border rounded p-3 mt-2">
            <div className="row g-2 align-items-end">
              <div className="col-12 col-md-4"><label className="form-label small mb-1" htmlFor="pa-store">Store that owes</label>
                <select id="pa-store" className="form-select" value={debtor} onChange={(e) => setDebtor(e.target.value)}>{others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="col-12 col-md-4"><label className="form-label small mb-1" htmlFor="pa-prod">Item</label>
                <select id="pa-prod" className="form-select" value={add.productId} onChange={(e) => setAdd({ ...add, productId: e.target.value, qty: "" })}><option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
              <div className="col-6 col-md-2"><label className="form-label small mb-1" htmlFor="pa-qty">{prod?.loose ? "Kilos" : "How many"}</label>
                {prod?.loose ? <KiloInput id="pa-qty" className="form-control" value={add.qty} onChange={(v) => setAdd({ ...add, qty: v })} /> : <WholeInput id="pa-qty" className="form-control" value={add.qty} onChange={(v) => setAdd({ ...add, qty: v })} />}</div>
              <div className="col-6 col-md-2"><button type="button" className="btn btn-primary w-100" disabled={busy || !debtor || !prod || !(Number(add.qty) > 0)}
                onClick={async () => { if (await act("/admin/payable/charge", { locationId: debtor, productId: add.productId, quantity: prod?.loose ? Math.round(Number(add.qty) * 1000) : Math.round(Number(add.qty)), note: add.note }, "Charged")) setAdd({ productId: "", qty: "", note: "" }); }}>Charge</button></div>
            </div>
          </div>
        )}
      </div>

      <h6>All entries</h6>
      {data.entries.length === 0 ? <p className="text-muted small">None yet.</p> : (
        <ul className="list-unstyled">
          {data.entries.map((e) => (
            <li key={e.id} className={`py-2 border-bottom small ${e.reversed ? "text-decoration-line-through text-muted" : ""}`}>
              <div className="d-flex justify-content-between gap-2">
                <span>
                  <span className={`badge me-1 ${KIND[e.kind]?.badge ?? "text-bg-secondary"}`}>{kindLabel(e.kind, e.amountMinor)}</span>
                  <b>{e.store}</b>{e.productName && e.quantity !== null ? ` · ${qtyText(e.loose, e.quantity)} ${e.productName}${e.unitCostMinor !== null ? ` @ ${peso(e.unitCostMinor)}${e.kind === "PROFIT_SHARE" || e.kind === "SHARE_BACK" ? " profit" : ""}` : ""}` : ""}
                </span>
                <span className="text-nowrap fw-semibold">{e.amountMinor < 0 ? "−" : ""}{peso(Math.abs(e.amountMinor))}</span>
              </div>
              <div className="text-muted">{e.docNumber} · {new Date(e.at).toLocaleString()}{e.by ? ` · ${e.by}` : ""}{e.note ? ` · ${e.note}` : ""}
                {e.canReverse && <button type="button" className="btn btn-link btn-sm py-0" onClick={() => void undo(e)}>Undo</button>}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

// Store payable: what each store owes the main store for rice that left without a record.
//   Balance cards   one per store: owes, paid, balance — Record payment / Statement
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

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (loose: boolean, q: number) => (loose ? `${(q / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : `${q.toLocaleString("en-PH")} pcs`);

interface Bal { id: string; name: string; code: string | null; isMain: boolean; chargesMinor: number; paymentsMinor: number; reversedMinor: number; owesMinor: number }
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
  const [payAmount, setPayAmount] = useState("");
  const [payNote, setPayNote] = useState("");
  const [adding, setAdding] = useState(false);
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
  const statement = async (b: Bal) => {
    const r = await call(`/admin/payable/statement?locationId=${b.id}`, "GET");
    if (!r.ok) { setError(errText(r.data, "Could not load the statement")); return; }
    const s = r.data as unknown as { store: { name: string }; owesMinor: number; entries: { docNumber: string; kind: string; at: string; productName: string | null; loose: boolean; quantity: number | null; amountMinor: number; balanceMinor: number; note: string | null }[] };
    printSlip({
      storeName: "Store payable", title: `STATEMENT — ${s.store.name}`, when: new Date().toLocaleString(),
      rows: s.entries.map((e) => ({ name: `${e.docNumber} ${e.kind === "CHARGE" ? (e.productName ?? "Charge") : e.kind === "PAYMENT" ? "Payment" : "Undo"}`, qty: e.quantity !== null && e.productName ? qtyText(e.loose, e.quantity) : "", note: `${e.amountMinor < 0 ? "−" : ""}${peso(Math.abs(e.amountMinor))} → ${peso(e.balanceMinor)}` })),
      totals: [{ label: `${s.store.name} owes`, value: peso(s.owesMinor) }],
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
      <p className="text-muted small">What each store owes the main store for rice that left without a record, at the main store&apos;s cost price.</p>
      {error && <div className="alert alert-danger py-2">{error}</div>}

      <div className="row g-2 mb-3">
        {others.map((s) => (
          <div key={s.id} className="col-12 col-md-6">
            <div className={`border rounded p-3 ${s.owesMinor > 0 ? "border-warning" : ""}`}>
              <div className="small text-muted">{s.name} owes</div>
              <div className="fs-3 fw-semibold">{peso(s.owesMinor)}</div>
              <div className="small text-muted mb-2">Charged {peso(s.chargesMinor)} · Paid {peso(s.paymentsMinor)}</div>
              <div className="d-flex gap-2">
                <button type="button" className="btn btn-success" disabled={s.owesMinor <= 0} onClick={() => { setPaying(s); setPayAmount(""); setPayNote(""); }}>Record payment</button>
                <button type="button" className="btn btn-outline-dark" onClick={() => void statement(s)}>Print statement</button>
              </div>
            </div>
          </div>
        ))}
        {others.length === 0 && <p className="text-muted">Add another store in Warehouses first.</p>}
      </div>

      {paying && (
        <div className="border rounded p-3 mb-3 bg-body-tertiary">
          <div className="fw-semibold mb-2">{paying.name} pays ({peso(paying.owesMinor)} owed)</div>
          <div className="row g-2 align-items-end">
            <div className="col-6 col-md-4"><label className="form-label small mb-1" htmlFor="pp-amt">Amount paid</label><PesoInput id="pp-amt" className="form-control form-control-lg" value={payAmount} onChange={setPayAmount} placeholder="0.00" /></div>
            <div className="col-12 col-md-4"><label className="form-label small mb-1" htmlFor="pp-note">Note (optional)</label><input id="pp-note" className="form-control form-control-lg" value={payNote} maxLength={200} onChange={(e) => setPayNote(e.target.value)} /></div>
            <div className="col-12 col-md-4 d-flex gap-2">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setPaying(null)}>Cancel</button>
              <button type="button" className="btn btn-success btn-lg flex-fill" disabled={busy || !(Number(payAmount) > 0)} onClick={async () => { if (await act("/admin/payable/payment", { locationId: paying.id, amountMinor: Math.round(Number(payAmount) * 100), note: payNote }, "Payment recorded")) setPaying(null); }}>Save payment</button>
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
                  <span className={`badge me-1 ${e.kind === "CHARGE" ? "text-bg-warning" : e.kind === "PAYMENT" ? "text-bg-success" : "text-bg-secondary"}`}>{e.kind === "CHARGE" ? "Charge" : e.kind === "PAYMENT" ? "Payment" : "Undo"}</span>
                  <b>{e.store}</b>{e.productName && e.quantity !== null ? ` · ${qtyText(e.loose, e.quantity)} ${e.productName}${e.unitCostMinor !== null ? ` @ ${peso(e.unitCostMinor)}` : ""}` : ""}
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

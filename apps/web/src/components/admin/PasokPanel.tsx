"use client";

// Rice Ops M5 — Manual stock in (stock that arrived without a purchase order, signed by the
// receiver). A new item is added from here with its cost and price, lands on the stock-in list,
// and the quantity that arrived is entered there. Every stock-in has a receipt to print.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import SignaturePad from "./SignaturePad";
import StoreBar from "./StoreBar";
import { printSlip, type Slip } from "../../lib/slip-print";
import { getPrinterSettings } from "../../lib/printer-settings";
import { NewItemForm } from "./BentaPanel";

interface Loc { id: string; name: string; code: string | null; isActive: boolean }
interface Product { id: string; name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null; isActive?: boolean; reviewStatus?: string }
interface StockInDoc { id: string; docNumber: string; supplierName: string | null; createdAt: string; lines: { name: string; loose: boolean; quantity: number; unitCostMinor: number | null }[] }
interface Row { productId: string; amount: string; cost: string }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isLoose = (p?: { stockBaseUnit: string | null; stockBaseQuantity: number | null }) => !!p && p.stockBaseUnit === "g" && p.stockBaseQuantity === 1;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const num = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 10);

export default function PasokPanel(_props: { role?: string; onNavigate?: (tab: string) => void }) {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [supplier, setSupplier] = useState("");
  const [rows, setRows] = useState<Row[]>([{ productId: "", amount: "", cost: "" }]);
  const [sig, setSig] = useState<string | null>(null);
  const [sigKey, setSigKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState(false); // store picked first
  const [adding, setAdding] = useState(false);   // the "New item" form
  const [error, setError] = useState<string | null>(null);
  const [storeName, setStoreName] = useState("");
  const [docs, setDocs] = useState<StockInDoc[]>([]);
  const [justDone, setJustDone] = useState<string | null>(null); // docNumber just received

  const load = useCallback(async () => {
    const [me, locs, ps, st] = await Promise.all([
      fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
    ]);
    const active = ((locs?.warehouses ?? []) as Loc[]).filter((l) => l.isActive);
    setLocations(active);
    setHomeLocationId(me?.homeLocationId ?? null);
    setLocationId((cur) => cur || me?.homeLocationId || ((locs?.warehouses ?? []) as (Loc & { isDefault?: boolean })[]).filter((l) => l.isActive).find((l) => l.isDefault)?.id || active[0]?.id || "");
    setChosen(true);
    setProducts(((ps?.products ?? []) as Product[]).filter((p) => p.isActive !== false));
    setStoreName(st?.store?.name ?? "");
  }, []);
  useEffect(() => { load().catch(() => setError("Could not load")); }, [load]);

  const loadDocs = useCallback(async (loc: string): Promise<StockInDoc[]> => {
    if (!loc) return [];
    const r = await fetch(`${API_URL}/admin/stock-in?locationId=${encodeURIComponent(loc)}`, { headers: adminHeaders() }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const list = ((r?.stockIns ?? []) as StockInDoc[]);
    setDocs(list);
    return list;
  }, []);
  useEffect(() => { if (chosen && locationId) void loadDocs(locationId); }, [chosen, locationId, loadDocs]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const units = (r: Row) => { const p = byId.get(r.productId); const n = Number(r.amount); return !p || !(n > 0) ? 0 : isLoose(p) ? Math.round(n * 1000) : Number.isInteger(n) ? n : 0; };
  const ready = rows.length > 0 && rows.every((r) => r.productId && units(r) > 0) && !!sig && !busy;
  const here = locations.find((l) => l.id === locationId);

  const slipOf = (d: StockInDoc): Slip => ({
    storeName: storeName || "SAM STORE", title: "STOCK IN RECEIPT", reference: d.docNumber, when: new Date(d.createdAt).toLocaleString("en-PH"),
    lines: [{ label: "Store", value: here?.name ?? "" }, ...(d.supplierName ? [{ label: "From", value: d.supplierName }] : [])],
    rows: d.lines.map((l) => ({ name: l.name, qty: `${l.loose ? `${(l.quantity / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : `${l.quantity}`}${l.unitCostMinor ? `  @ ${peso(l.unitCostMinor)}` : ""}` })),
    signatures: [{ role: "Received by", name: "" }],
  });

  const saveIn = async () => {
    setBusy(true); setError(null);
    const body = {
      locationId, supplierName: supplier.trim() || undefined,
      lines: rows.map((r) => ({ productId: r.productId, quantity: units(r), unitCostMinor: r.cost ? Math.round(Number(r.cost) * 100) : undefined })),
      signatures: [{ signerKind: "STAFF", imagePng: sig }],
    };
    const sent = await sendStep("/admin/stock-in", body, `Stock in${supplier.trim() ? ` (${supplier.trim()})` : ""}`);
    setBusy(false);
    const clear = () => { setRows([{ productId: "", amount: "", cost: "" }]); setSupplier(""); setSig(null); setSigKey((k) => k + 1); };
    if (sent.status === "queued") { toast("No signal — saved on this phone, it will be sent when the signal returns"); clear(); return; }
    const d = sent.data as ApiBody | null;
    if (!sent.ok) { setError(errText(d, "Did not go through")); return; }
    toast(`Received: ${String(d?.docNumber ?? "")}`);
    clear();
    setJustDone(String(d?.docNumber ?? ""));
    const list = await loadDocs(locationId);
    const doc = list.find((x) => x.docNumber === String(d?.docNumber ?? ""));
    if (doc && getPrinterSettings().autoPrint) printSlip(slipOf(doc));
  };

  const addCreated = async (c?: { productId: string; name: string; costMinor: number }) => {
    setAdding(false);
    await load();
    if (!c?.productId) return;
    // The new item lands on the stock-in list; staff enter how many arrived there.
    const row: Row = { productId: c.productId, amount: "", cost: c.costMinor > 0 ? String(c.costMinor / 100) : "" };
    setRows((cur) => (cur.length === 1 && !cur[0]!.productId ? [row] : [...cur, row]));
  };

  const doneDoc = justDone ? docs.find((x) => x.docNumber === justDone) : undefined;

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Stock in</h1>
      </div>
      <StoreBar locations={locations} value={locationId} homeLocationId={homeLocationId} locked={adding || rows.some((r) => r.productId || r.amount)}
        lockedNote="Receive or clear what you started to switch store." onPick={(id) => { setLocationId(id); setJustDone(null); }} />
      {chosen && adding && <NewItemForm preorder onCancel={() => setAdding(false)} onDone={addCreated} locationId={locationId} />}
      {chosen && !adding && (<>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {justDone && (
        <div className="alert alert-success d-flex flex-wrap align-items-center justify-content-between gap-2" style={{ maxWidth: 620 }}>
          <strong>Received — {justDone}.</strong>
          <span className="d-flex gap-2">
            {doneDoc && <button type="button" className="btn btn-dark btn-lg" onClick={() => printSlip(slipOf(doneDoc))}><i className="bi bi-printer me-1"></i>Print receipt</button>}
            <button type="button" className="btn btn-outline-secondary" onClick={() => setJustDone(null)}>Close</button>
          </span>
        </div>
      )}

      <div className="card mb-4" style={{ maxWidth: 620 }}>
        <div className="card-body">
          <label className="form-label" htmlFor="pk-sup">Supplier (if any)</label>
          <input id="pk-sup" className="form-control form-control-lg mb-3" value={supplier} onChange={(e) => setSupplier(e.target.value.slice(0, 80))} />
          {rows.map((r, i) => {
            const p = byId.get(r.productId);
            return (
              <div key={i} className="row g-2 mb-2 align-items-end">
                <div className="col-12 col-sm-6">
                  <select className="form-select form-select-lg" aria-label={`Product ${i + 1}`} value={r.productId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                    <option value="">Choose…</option>
                    {products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </div>
                <div className="col-5 col-sm-3">
                  <input className="form-control form-control-lg text-center" aria-label={isLoose(p) ? "How many kilos" : "How many"} placeholder={isLoose(p) ? "kilos" : "how many"} inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: num(e.target.value) } : x)))} />
                </div>
                <div className="col-5 col-sm-2">
                  <input className="form-control form-control-lg text-center" aria-label="Cost each" placeholder="₱ cost" inputMode="decimal" value={r.cost} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cost: num(e.target.value) } : x)))} />
                </div>
                <div className="col-2 col-sm-1">{rows.length > 1 && <button type="button" className="btn btn-link text-danger" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>}</div>
              </div>
            );
          })}
          <div className="d-flex flex-wrap gap-2 mb-3">
            <button type="button" className="btn btn-outline-secondary" onClick={() => setRows([...rows, { productId: "", amount: "", cost: "" }])}>+ One more</button>
            <button type="button" className="btn btn-outline-success" onClick={() => setAdding(true)}>+ New item (not in the list)</button>
          </div>
          <div className="fw-semibold">Signature of the receiver</div>
          <SignaturePad key={sigKey} onSignature={setSig} />
          <button type="button" className="btn btn-success btn-lg w-100 mt-3" disabled={!ready} onClick={() => void saveIn()}>{busy ? "Please wait…" : "Receive"}</button>
        </div>
      </div>

      <h2 className="h5">Recent stock in</h2>
      {docs.length === 0 ? <p className="text-muted">None yet.</p> : (
        <div className="list-group" style={{ maxWidth: 620 }}>
          {docs.map((d) => (
            <div key={d.id} className="list-group-item d-flex justify-content-between align-items-center gap-2">
              <div>
                <div className="fw-semibold">{d.docNumber}{d.supplierName ? ` · ${d.supplierName}` : ""}</div>
                <div className="small text-muted">{d.lines.map((l) => `${l.loose ? `${(l.quantity / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : l.quantity} ${l.name}`).join(", ")} · {new Date(d.createdAt).toLocaleString("en-PH")}</div>
              </div>
              <button type="button" className="btn btn-outline-dark btn-sm text-nowrap" onClick={() => printSlip(slipOf(d))}><i className="bi bi-receipt me-1"></i>Receipt</button>
            </div>
          ))}
        </div>
      )}
    </>)}
    </div>
  );
}

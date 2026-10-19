"use client";

// Rice Ops M5 — Manual stock in (stock that arrived without a purchase order, signed by the
// receiver) and To review (new items waiting for the owner: confirm in For your approval, or
// fold into an existing product here — the stock is converted by weight).

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, isOwnerRole } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import SignaturePad from "./SignaturePad";
import { askConfirm } from "../../lib/ask";
import { NewItemForm } from "./BentaPanel";

interface Loc { id: string; name: string; code: string | null; isActive: boolean }
interface Product { id: string; name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null; isActive?: boolean; reviewStatus?: string }
interface Review { id: string; name: string; priceMinor: number; costMinor: number; loose: boolean; gramsPerUnit: number | null; createdAt: string; timesSold: number; stock: { locationId: string | null; quantity: number }[] }
interface Row { productId: string; amount: string; cost: string }
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isLoose = (p?: { stockBaseUnit: string | null; stockBaseQuantity: number | null }) => !!p && p.stockBaseUnit === "g" && p.stockBaseQuantity === 1;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const num = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 10);

export default function PasokPanel({ role }: { role?: string; onNavigate?: (tab: string) => void }) {
  const owner = !!role && (isOwnerRole(role) || role === "MANAGER");
  const [tab, setTab] = useState<"pasok" | "review">("pasok");
  const [locations, setLocations] = useState<Loc[]>([]);
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [supplier, setSupplier] = useState("");
  const [rows, setRows] = useState<Row[]>([{ productId: "", amount: "", cost: "" }]);
  const [sig, setSig] = useState<string | null>(null);
  const [sigKey, setSigKey] = useState(0);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState(false); // store picked first
  const [adding, setAdding] = useState(false);   // the "New item" form
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [me, locs, ps, rv] = await Promise.all([
      fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${API_URL}/admin/products/review`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
    ]);
    const active = ((locs?.warehouses ?? []) as Loc[]).filter((l) => l.isActive);
    setLocations(active);
    setHomeLocationId(me?.homeLocationId ?? null);
    setLocationId((cur) => cur || me?.homeLocationId || "");
    if (me?.homeLocationId) setChosen(true);
    setProducts(((ps?.products ?? []) as Product[]).filter((p) => p.isActive !== false));
    setReviews((rv?.products ?? []) as Review[]);
  }, []);
  useEffect(() => { load().catch(() => setError("Could not load")); }, [load]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const units = (r: Row) => { const p = byId.get(r.productId); const n = Number(r.amount); return !p || !(n > 0) ? 0 : isLoose(p) ? Math.round(n * 1000) : Number.isInteger(n) ? n : 0; };
  const ready = rows.length > 0 && rows.every((r) => r.productId && units(r) > 0) && !!sig && !busy;
  const here = locations.find((l) => l.id === locationId);

  const saveIn = async () => {
    setBusy(true); setError(null);
    const body = {
      locationId, supplierName: supplier.trim() || undefined,
      lines: rows.map((r) => ({ productId: r.productId, quantity: units(r), unitCostMinor: r.cost ? Math.round(Number(r.cost) * 100) : undefined })),
      signatures: [{ signerKind: "STAFF", imagePng: sig }],
    };
    const sent = await sendStep("/admin/stock-in", body, `Stock in${supplier.trim() ? ` (${supplier.trim()})` : ""}`);
    setBusy(false);
    if (sent.status === "queued") { toast("No signal — saved on this phone, it will be sent when the signal returns"); setRows([{ productId: "", amount: "", cost: "" }]); setSupplier(""); setSig(null); setSigKey((k) => k + 1); return; }
    const d = sent.data as ApiBody | null;
    if (!sent.ok) { setError(errText(d, "Did not go through")); return; }
    toast(`Received: ${String(d?.docNumber ?? "")}`);
    setRows([{ productId: "", amount: "", cost: "" }]); setSupplier(""); setSig(null); setSigKey((k) => k + 1);
  };

  const merge = async (r: Review) => {
    const into = mergeInto[r.id];
    if (!into) return;
    const target = byId.get(into)?.name ?? "";
    if (!(await askConfirm(`Merge "${r.name}" into "${target}"? Its stock will be moved.`, { ok: "Merge" }))) return;
    const res = await fetch(`${API_URL}/admin/products/${r.id}/merge`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ intoProductId: into }) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok) { setError(errText(d, "Not merged")); return; }
    toast(`Merged into ${target}`);
    await load();
  };

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Stock in & review</h1>
        {chosen && here && (homeLocationId ? <span className="badge text-bg-light border fs-6">{here.name}</span> : (
          <button type="button" className="btn btn-outline-secondary" onClick={() => { setChosen(false); setLocationId(""); setAdding(false); }}>Store: {here.name} · change</button>
        ))}
      </div>
      {!chosen && (
        <>
          <h2 className="h5">Which store?</h2>
          <div className="d-grid gap-2 mb-4" style={{ maxWidth: 420 }}>
            {locations.map((l) => <button key={l.id} type="button" className="btn btn-outline-success btn-lg" onClick={() => { setLocationId(l.id); setChosen(true); }}>{l.code ? `${l.code} · ` : ""}{l.name}</button>)}
          </div>
        </>
      )}
      {chosen && adding && <NewItemForm locationId={locationId} onCancel={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />}
      {chosen && !adding && (<>
      <ul className="nav nav-tabs mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === "pasok" ? "active" : ""}`} onClick={() => setTab("pasok")}>Manual stock in</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === "review" ? "active" : ""}`} onClick={() => setTab("review")}>To review {reviews.length > 0 && <span className="badge text-bg-warning">{reviews.length}</span>}</button></li>
      </ul>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {tab === "pasok" && (
        <div className="card" style={{ maxWidth: 620 }}>
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
      )}

      {tab === "review" && (
        reviews.length === 0 ? <p className="text-muted">No new items to review.</p> : (
          <div className="list-group" style={{ maxWidth: 720 }}>
            {reviews.map((r) => (
              <div key={r.id} className="list-group-item py-3">
                <div className="fw-semibold">{r.name} <span className="badge text-bg-warning">To review</span></div>
                <div className="small text-muted">
                  {peso(r.priceMinor)}{r.loose ? "/kg" : ""} · cost {peso(r.costMinor)} · sold {r.timesSold}× · added {new Date(r.createdAt).toLocaleString("en-PH")}
                </div>
                {owner ? (
                  <div className="d-flex flex-wrap gap-2 mt-2">
                    <span className="align-self-center small">Approve in <strong>For your approval</strong>, or:</span>
                    <select className="form-select" style={{ maxWidth: 260 }} aria-label="Merge into" value={mergeInto[r.id] ?? ""} onChange={(e) => setMergeInto({ ...mergeInto, [r.id]: e.target.value })}>
                      <option value="">Merge into…</option>
                      {products.filter((p) => p.id !== r.id && p.reviewStatus !== "FOR_REVIEW").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button type="button" className="btn btn-outline-dark" disabled={!mergeInto[r.id]} onClick={() => void merge(r)}>Merge</button>
                  </div>
                ) : <div className="small mt-1">Waiting for the owner.</div>}
              </div>
            ))}
          </div>
        )
      )}
    </>)}
    </div>
  );
}

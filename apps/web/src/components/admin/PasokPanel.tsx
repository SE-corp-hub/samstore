"use client";

// Rice Ops M5 — Manual na pasok (stock that arrived without a purchase order, signed by the
// receiver) and Susuriin (Bagong items waiting for the owner: confirm in Para sa iyo, or
// fold into an existing product here — the stock is converted by weight).

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders, isOwnerRole } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import SignaturePad from "./SignaturePad";

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
    setLocationId((cur) => cur || me?.homeLocationId || active[0]?.id || "");
    setProducts(((ps?.products ?? []) as Product[]).filter((p) => p.isActive !== false));
    setReviews((rv?.products ?? []) as Review[]);
  }, []);
  useEffect(() => { load().catch(() => setError("Hindi ma-load")); }, [load]);

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
    const sent = await sendStep("/admin/stock-in", body, `Pasok${supplier.trim() ? ` (${supplier.trim()})` : ""}`);
    setBusy(false);
    if (sent.status === "queued") { toast("Walang signal — naka-save sa phone, ipapadala pagbalik ng signal"); setRows([{ productId: "", amount: "", cost: "" }]); setSupplier(""); setSig(null); setSigKey((k) => k + 1); return; }
    const d = sent.data as ApiBody | null;
    if (!sent.ok) { setError(errText(d, "Hindi natuloy")); return; }
    toast(`Natanggap: ${String(d?.docNumber ?? "")}`);
    setRows([{ productId: "", amount: "", cost: "" }]); setSupplier(""); setSig(null); setSigKey((k) => k + 1);
  };

  const merge = async (r: Review) => {
    const into = mergeInto[r.id];
    if (!into) return;
    const target = byId.get(into)?.name ?? "";
    if (!confirm(`Pagsamahin ang "${r.name}" sa "${target}"? Ililipat ang stock nito.`)) return;
    const res = await fetch(`${API_URL}/admin/products/${r.id}/merge`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ intoProductId: into }) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok) { setError(errText(d, "Hindi napagsama")); return; }
    toast(`Pinagsama sa ${target}`);
    await load();
  };

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Pasok at Susuriin</h1>
        {homeLocationId ? <span className="badge text-bg-light border fs-6">{here?.name}</span> : (
          <select className="form-select" style={{ maxWidth: 240 }} aria-label="Lokasyon" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} · ` : ""}{l.name}</option>)}
          </select>
        )}
      </div>
      <ul className="nav nav-tabs mb-3">
        <li className="nav-item"><button className={`nav-link ${tab === "pasok" ? "active" : ""}`} onClick={() => setTab("pasok")}>Manual na pasok</button></li>
        <li className="nav-item"><button className={`nav-link ${tab === "review" ? "active" : ""}`} onClick={() => setTab("review")}>Susuriin {reviews.length > 0 && <span className="badge text-bg-warning">{reviews.length}</span>}</button></li>
      </ul>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {tab === "pasok" && (
        <div className="card" style={{ maxWidth: 620 }}>
          <div className="card-body">
            <label className="form-label" htmlFor="pk-sup">Supplier (kung meron)</label>
            <input id="pk-sup" className="form-control form-control-lg mb-3" value={supplier} onChange={(e) => setSupplier(e.target.value.slice(0, 80))} />
            {rows.map((r, i) => {
              const p = byId.get(r.productId);
              return (
                <div key={i} className="row g-2 mb-2 align-items-end">
                  <div className="col-12 col-sm-6">
                    <select className="form-select form-select-lg" aria-label={`Produkto ${i + 1}`} value={r.productId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                      <option value="">Pumili…</option>
                      {products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </div>
                  <div className="col-5 col-sm-3">
                    <input className="form-control form-control-lg text-center" aria-label={isLoose(p) ? "Ilang kilo" : "Ilan"} placeholder={isLoose(p) ? "kilo" : "ilan"} inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: num(e.target.value) } : x)))} />
                  </div>
                  <div className="col-5 col-sm-2">
                    <input className="form-control form-control-lg text-center" aria-label="Puhunan bawat isa" placeholder="₱ puhunan" inputMode="decimal" value={r.cost} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cost: num(e.target.value) } : x)))} />
                  </div>
                  <div className="col-2 col-sm-1">{rows.length > 1 && <button type="button" className="btn btn-link text-danger" aria-label="Alisin" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>}</div>
                </div>
              );
            })}
            <button type="button" className="btn btn-outline-secondary mb-3" onClick={() => setRows([...rows, { productId: "", amount: "", cost: "" }])}>+ Isa pa</button>
            <div className="fw-semibold">Pirma ng tumanggap</div>
            <SignaturePad key={sigKey} onSignature={setSig} />
            <button type="button" className="btn btn-success btn-lg w-100 mt-3" disabled={!ready} onClick={() => void saveIn()}>{busy ? "Sandali…" : "Tanggapin"}</button>
          </div>
        </div>
      )}

      {tab === "review" && (
        reviews.length === 0 ? <p className="text-muted">Walang bagong item na susuriin.</p> : (
          <div className="list-group" style={{ maxWidth: 720 }}>
            {reviews.map((r) => (
              <div key={r.id} className="list-group-item py-3">
                <div className="fw-semibold">{r.name} <span className="badge text-bg-warning">Susuriin</span></div>
                <div className="small text-muted">
                  {peso(r.priceMinor)}{r.loose ? "/kg" : ""} · puhunan {peso(r.costMinor)} · naibenta {r.timesSold}× · idinagdag {new Date(r.createdAt).toLocaleString("en-PH")}
                </div>
                {owner ? (
                  <div className="d-flex flex-wrap gap-2 mt-2">
                    <span className="align-self-center small">Aprubahan sa <strong>Para sa iyo</strong>, o:</span>
                    <select className="form-select" style={{ maxWidth: 260 }} aria-label="Pagsamahin sa" value={mergeInto[r.id] ?? ""} onChange={(e) => setMergeInto({ ...mergeInto, [r.id]: e.target.value })}>
                      <option value="">Pagsamahin sa…</option>
                      {products.filter((p) => p.id !== r.id && p.reviewStatus !== "FOR_REVIEW").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button type="button" className="btn btn-outline-dark" disabled={!mergeInto[r.id]} onClick={() => void merge(r)}>Pagsamahin</button>
                  </div>
                ) : <div className="small mt-1">Hinihintay ang may-ari.</div>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

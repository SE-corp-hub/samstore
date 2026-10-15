"use client";

// Rice Ops M4 — Resack: any rice into any rice, at this location.
//   Resack ngayon   — weigh in, weigh out, sign (one step)
//   Simulan / Tapusin — the kargador needs time: the input leaves the shelf now and
//                     shows as "nasa resack" until someone finishes it
//   Buksan ang sako — one sack becomes loose kilos for tingi
// The screen does the arithmetic: kilos in, kilos out, the loss and whether it is
// within 1% — before anyone signs. Over 1% goes to the owner; the stock still moves.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import SignCapture, { type KargadorOption, type SignatureOut } from "./SignCapture";

interface Product { id: string; name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null; stockConversionFamily: string | null; isActive?: boolean }
interface Location { id: string; name: string; code: string | null; isActive: boolean }
interface Job {
  id: string; docNumber: string; status: "STARTED" | "FINISHED" | "CANCELLED"; input: { id: string; name: string }; inputQty: number;
  inputGrams: number; outputGrams: number | null; lossGrams: number | null; lossBp: number | null; varietyChange: boolean; openSack: boolean;
  kargador: { id: string; name: string } | null; approvalId: string | null; startedAt: string;
  outputs: { product: { name: string }; quantity: number }[];
}
type Mode = "now" | "start" | "open" | "finish";
interface OutRow { productId: string; amount: string } // sacks, or kilos for loose rice
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const isLoose = (p?: Product) => !!p && (p.stockBaseUnit ?? "") === "g" && p.stockBaseQuantity === 1;
const weighed = (p?: Product) => !!p && (p.stockBaseUnit ?? "") === "g" && !!p.stockBaseQuantity;
const kg = (g: number) => (g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 });
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;

/** Stock units for an output row: sacks as typed, loose rice in grams from kilos. */
function unitsOf(p: Product | undefined, amount: string): number {
  const n = Number(amount.replace(",", "."));
  if (!p || !Number.isFinite(n) || n <= 0) return 0;
  return isLoose(p) ? Math.round(n * 1000) : Math.floor(n) === n ? n : 0;
}

export default function ResackPanel() {
  const [products, setProducts] = useState<Product[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [kargadors, setKargadors] = useState<KargadorOption[]>([]);
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [finishing, setFinishing] = useState<Job | null>(null);
  const [inputId, setInputId] = useState("");
  const [inputQty, setInputQty] = useState("1");
  const [outs, setOuts] = useState<OutRow[]>([{ productId: "", amount: "" }]);
  const [kargadorId, setKargadorId] = useState("");
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [me, locs, ks, ps] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/warehouses`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/kargadors`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/products`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      const active = ((locs?.warehouses ?? []) as Location[]).filter((l) => l.isActive);
      setLocations(active);
      setHomeLocationId(me?.homeLocationId ?? null);
      setLocationId(me?.homeLocationId ?? active[0]?.id ?? "");
      setKargadors((ks?.kargadors ?? []) as KargadorOption[]);
      setProducts(((ps?.products ?? []) as Product[]).filter((p) => p.isActive !== false && weighed(p)));
    })().catch(() => setError("Hindi ma-load"));
  }, []);

  const loadJobs = useCallback(async () => {
    if (!locationId) return;
    const res = await fetch(`${API_URL}/admin/resacks?status=ALL&locationId=${encodeURIComponent(locationId)}`, { headers: adminHeaders() });
    if (res.ok) setJobs((await res.json()).resacks);
  }, [locationId]);
  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const sacks = products.filter((p) => !isLoose(p));
  const loose = products.filter(isLoose);
  const here = locations.find((l) => l.id === locationId);
  const inProduct = finishing ? byId.get(finishing.input.id) : byId.get(inputId);
  const inQty = finishing ? finishing.inputQty : Number(inputQty);
  const gramsIn = finishing ? finishing.inputGrams : inProduct?.stockBaseQuantity && Number.isInteger(inQty) && inQty > 0 ? inProduct.stockBaseQuantity * inQty : 0;
  const outUnits = outs.map((o) => unitsOf(byId.get(o.productId), o.amount));
  const gramsOut = outs.reduce((s, o, i) => s + (byId.get(o.productId)?.stockBaseQuantity ?? 0) * (outUnits[i] ?? 0), 0);
  const loss = gramsIn - gramsOut;
  const lossPct = gramsIn > 0 ? (loss * 100) / gramsIn : 0;
  const overTolerance = loss * 10_000 > 100 * gramsIn;
  const outsValid = outs.length > 0 && outs.every((o, i) => o.productId && (outUnits[i] ?? 0) > 0);
  const readyToSign = mode === "start" ? gramsIn > 0 : gramsIn > 0 && outsValid && gramsOut <= gramsIn;

  const reset = () => {
    setMode(null); setFinishing(null); setSigning(false); setInputId(""); setInputQty("1");
    setOuts([{ productId: "", amount: "" }]); setKargadorId("");
  };

  const sentence = () => {
    const outText = outs.map((o, i) => { const p = byId.get(o.productId); return p ? (isLoose(p) ? `${kg(outUnits[i] ?? 0)} kg ${p.name}` : `${outUnits[i]} × ${p.name}`) : ""; }).filter(Boolean).join(", ");
    const k = kargadors.find((x) => x.id === (finishing?.kargador?.id ?? kargadorId))?.name;
    const dala = k ? `, ginawa ni ${k}` : "";
    if (mode === "start") return `Sisimulan ang resack sa ${here?.name}: ${inQty} × ${inProduct?.name} (${kg(gramsIn)} kg) aalis sa estante${dala}.`;
    return `Resack sa ${here?.name}: ${inQty} × ${inProduct?.name} (${kg(gramsIn)} kg) → ${outText} (${kg(gramsOut)} kg). ${loss > 0 ? `Kulang ${kg(loss)} kg (${lossPct.toFixed(1)}%)` : "Walang kulang"}${dala}.`;
  };

  const submit = async (signatures: SignatureOut[]) => {
    setBusy(true);
    setError(null);
    const outputs = outs.map((o, i) => ({ productId: o.productId, quantity: outUnits[i] }));
    const k = kargadorId || undefined;
    let path = "/admin/resacks";
    let body: Record<string, unknown>;
    if (finishing) { path = `/admin/resacks/${finishing.id}/finish`; body = { outputs, signatures }; }
    else if (mode === "start") { path = "/admin/resacks/start"; body = { locationId, inputProductId: inputId, inputQty: inQty, kargadorId: k, signatures }; }
    else if (mode === "open") { path = "/admin/resacks/open-sack"; body = { locationId, sackProductId: inputId, sacks: inQty, looseProductId: outs[0]?.productId, looseGrams: outUnits[0], kargadorId: k, signatures }; }
    else body = { locationId, inputProductId: inputId, inputQty: inQty, outputs, kargadorId: k, signatures };
    const r = await sendStep(path, body, `Resack ${inProduct?.name ?? ""}`.trim());
    setBusy(false);
    if (r.status === "queued") { toast("Walang signal — naka-save sa phone, ipapadala pagbalik ng signal"); reset(); return; }
    const data = r.data as ApiBody | null;
    if (!r.ok) { setSigning(false); setError(errText(data, "Hindi natuloy")); return; }
    toast(mode === "start" ? `Nasimulan: ${String(data?.docNumber ?? "")}` : data?.needsApproval ? "Tapos — lampas 1% ang kulang, ipinaalam sa may-ari" : "Tapos ang resack");
    reset();
    await loadJobs();
  };

  const cancelJob = async (j: Job) => {
    const reason = prompt(`Bakit ikakansela ang ${j.docNumber}? (babalik sa estante ang ${j.inputQty} × ${j.input.name})`);
    if (!reason) return;
    const res = await fetch(`${API_URL}/admin/resacks/${j.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ reason }) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok) { setError(errText(d, "Hindi natuloy")); return; }
    toast("Kinansela — naibalik sa estante");
    await loadJobs();
  };

  const started = jobs.filter((j) => j.status === "STARTED");
  const recent = jobs.filter((j) => j.status !== "STARTED").slice(0, 10);
  const needKargador = !!(finishing?.kargador?.id ?? kargadorId);

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Resack</h1>
        {homeLocationId ? <span className="badge text-bg-light border fs-6">{here?.name}</span> : (
          <select className="form-select" style={{ maxWidth: 240 }} aria-label="Lokasyon" value={locationId} onChange={(e) => { setLocationId(e.target.value); reset(); }}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} · ` : ""}{l.name}</option>)}
          </select>
        )}
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {products.length === 0 && <div className="alert alert-warning py-2">Walang bigas na may timbang. Sa Products, itakda ang laki ng bawat sako (hal. 25 kg) o 1 g para sa tingi.</div>}

      {!mode && !finishing && (
        <>
          <div className="d-grid gap-2 mb-4" style={{ maxWidth: 420 }}>
            <button className="btn btn-success btn-lg" onClick={() => setMode("now")}>Resack ngayon</button>
            <button className="btn btn-outline-dark btn-lg" onClick={() => setMode("start")}>Simulan (tatapusin mamaya)</button>
            <button className="btn btn-outline-dark btn-lg" onClick={() => { setMode("open"); setOuts([{ productId: loose[0]?.id ?? "", amount: "" }]); }}>Buksan ang sako (tingi)</button>
          </div>
          <h2 className="h5">Nasa resack ({started.length})</h2>
          {started.length === 0 ? <p className="text-muted">Wala.</p> : (
            <div className="list-group mb-4">
              {started.map((j) => (
                <div key={j.id} className="list-group-item py-3 d-flex justify-content-between align-items-center gap-2">
                  <div>
                    <div className="fw-semibold">{j.docNumber} · {j.inputQty} × {j.input.name}</div>
                    <div className="small text-muted">{kg(j.inputGrams)} kg{j.kargador ? ` · ${j.kargador.name}` : ""} · {new Date(j.startedAt).toLocaleString("en-PH")}</div>
                  </div>
                  <div className="d-flex gap-2">
                    <button className="btn btn-outline-secondary" onClick={() => void cancelJob(j)}>Kanselahin</button>
                    <button className="btn btn-success" onClick={() => { setFinishing(j); setOuts([{ productId: "", amount: "" }]); }}>Tapusin</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <h2 className="h5">Huling resack</h2>
          {recent.length === 0 ? <p className="text-muted">Wala pa.</p> : (
            <div className="list-group">
              {recent.map((j) => (
                <div key={j.id} className="list-group-item">
                  <div className="d-flex justify-content-between gap-2">
                    <div>
                      <div className="fw-semibold">{j.docNumber} · {j.inputQty} × {j.input.name} → {j.outputs.map((o) => `${o.quantity} × ${o.product.name}`).join(", ") || "—"}</div>
                      {j.status === "FINISHED" && <div className="small">{kg(j.inputGrams)} kg → {kg(j.outputGrams ?? 0)} kg · kulang {kg(j.lossGrams ?? 0)} kg ({((j.lossBp ?? 0) / 100).toFixed(2)}%)</div>}
                    </div>
                    <div className="text-end">
                      {j.status === "CANCELLED" && <span className="badge text-bg-secondary">Kinansela</span>}
                      {j.varietyChange && <span className="badge text-bg-info ms-1">Ibang klase</span>}
                      {j.approvalId && <span className="badge text-bg-warning ms-1">Sa may-ari</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {(mode || finishing) && !signing && (
        <div className="card border-success">
          <div className="card-body">
            <h2 className="h5">{finishing ? `Tapusin ${finishing.docNumber}` : mode === "start" ? "Simulan ang resack" : mode === "open" ? "Buksan ang sako" : "Resack ngayon"}</h2>

            <div className="fw-semibold mt-2">Papasok</div>
            {finishing ? <p className="mb-2">{finishing.inputQty} × {finishing.input.name} ({kg(finishing.inputGrams)} kg)</p> : (
              <div className="row g-2 mb-2">
                <div className="col-8">
                  <select className="form-select form-select-lg" aria-label="Papasok na bigas" value={inputId} onChange={(e) => setInputId(e.target.value)}>
                    <option value="">Pumili…</option>
                    {(mode === "open" ? sacks : products).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="col-4">
                  <input className="form-control form-control-lg text-center" aria-label="Ilang sako" inputMode="numeric" value={inputQty} onChange={(e) => setInputQty(e.target.value.replace(/\D/g, "").slice(0, 4))} />
                </div>
              </div>
            )}

            {mode !== "start" && (
              <>
                <div className="fw-semibold mt-3">Lumabas</div>
                {outs.map((o, i) => {
                  const p = byId.get(o.productId);
                  return (
                    <div key={i} className="row g-2 mb-2 align-items-center">
                      <div className="col-7">
                        <select className="form-select form-select-lg" aria-label={`Lumabas ${i + 1}`} value={o.productId} onChange={(e) => setOuts(outs.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                          <option value="">Pumili…</option>
                          {(mode === "open" ? loose : products).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      </div>
                      <div className="col-4">
                        <div className="input-group input-group-lg">
                          <input className="form-control text-center" aria-label={isLoose(p) ? "Ilang kilo" : "Ilang sako"} inputMode="decimal" value={o.amount}
                            onChange={(e) => setOuts(outs.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^\d.,]/g, "").slice(0, 8) } : x)))} />
                          <span className="input-group-text">{isLoose(p) ? "kg" : "sako"}</span>
                        </div>
                      </div>
                      <div className="col-1">
                        {outs.length > 1 && <button type="button" className="btn btn-link text-danger" aria-label="Alisin" onClick={() => setOuts(outs.filter((_, j) => j !== i))}>×</button>}
                      </div>
                    </div>
                  );
                })}
                {mode !== "open" && outs.length < 10 && <button type="button" className="btn btn-outline-secondary" onClick={() => setOuts([...outs, { productId: "", amount: "" }])}>+ Isa pang lumabas</button>}

                {gramsIn > 0 && (
                  <div className={`alert mt-3 mb-0 ${gramsOut > gramsIn ? "alert-danger" : overTolerance ? "alert-warning" : "alert-success"}`} style={{ fontVariantNumeric: "tabular-nums" }}>
                    <div>Pumasok: <strong>{kg(gramsIn)} kg</strong> · Lumabas: <strong>{kg(gramsOut)} kg</strong></div>
                    {gramsOut > gramsIn ? <div><strong>Sobra</strong> ang lumabas — timbangin ulit.</div>
                      : loss > 0 ? <div><strong>Kulang {kg(loss)} kg ({lossPct.toFixed(1)}%)</strong> — {overTolerance ? "lampas 1%: ipapaalam sa may-ari" : "OK, pasok sa 1%"}</div>
                      : <div><strong>Tama</strong> — walang kulang</div>}
                  </div>
                )}
              </>
            )}

            {!finishing && (
              <div className="mt-3">
                <label className="form-label" htmlFor="rs-kargador">Kargador na gumawa (kung meron)</label>
                <select id="rs-kargador" className="form-select form-select-lg" value={kargadorId} onChange={(e) => setKargadorId(e.target.value)}>
                  <option value="">Wala / staff lang</option>
                  {kargadors.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              </div>
            )}

            <div className="d-flex justify-content-between mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={reset}>Bumalik</button>
              <button type="button" className="btn btn-success btn-lg" disabled={!readyToSign || (mode !== "start" && !finishing && !inputId)} onClick={() => setSigning(true)}>Susunod</button>
            </div>
          </div>
        </div>
      )}

      {(mode || finishing) && signing && (
        <SignCapture
          sentence={sentence()}
          staffName="ikaw (staff)"
          needKargador={needKargador}
          kargadors={kargadors}
          presetKargadorId={finishing?.kargador?.id ?? (kargadorId || null)}
          busy={busy}
          onCancel={() => setSigning(false)}
          onDone={(sigs) => void submit(sigs)}
        />
      )}
    </div>
  );
}

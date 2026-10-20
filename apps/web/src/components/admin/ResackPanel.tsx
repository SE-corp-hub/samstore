"use client";

// Resack: any rice into any rice. Store first, then the rice (with what is left on
// the shelf), weigh in, weigh out, and only the porter (kargador) signs. A receipt
// can be printed right away and reprinted later from "Recent resacks".
// (Old "started" jobs from before are still listed so they can be finished or cancelled.)
// The screen does the arithmetic: kilos in, kilos out, the loss and whether it is
// within 1% — before anyone signs. Over 1% goes to the owner; the stock still moves.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import SignCapture, { type KargadorOption, type SignatureOut } from "./SignCapture";
import { askText } from "../../lib/ask";
import { printSlip, type Slip } from "../../lib/slip-print";
import { getPrinterSettings } from "../../lib/printer-settings";

interface Product { id: string; name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null; stockConversionFamily: string | null; isActive?: boolean }
interface Location { id: string; name: string; code: string | null; isActive: boolean }
interface Job {
  id: string; docNumber: string; status: "STARTED" | "FINISHED" | "CANCELLED"; input: { id: string; name: string }; inputQty: number;
  inputGrams: number; outputGrams: number | null; lossGrams: number | null; lossBp: number | null; varietyChange: boolean; openSack: boolean;
  kargador: { id: string; name: string } | null; approvalId: string | null; startedAt: string;
  outputs: { product: { name: string; soldByWeight?: boolean }; quantity: number }[];
}
type Mode = "now";
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
  const [chosen, setChosen] = useState(false);            // store picked (or fixed to this staff's store)
  const [stock, setStock] = useState<Record<string, number>>({});
  const [storeName, setStoreName] = useState("");
  const [receipt, setReceipt] = useState<Slip | null>(null);
  // "Print the receipt right after each transaction" (Printer settings on this phone).
  useEffect(() => { if (receipt && getPrinterSettings().autoPrint) printSlip(receipt); }, [receipt]);

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
      setLocationId(me?.homeLocationId ?? "");
      setChosen(!!me?.homeLocationId);
      fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setStoreName(d?.store?.name ?? "")).catch(() => {});
      setKargadors((ks?.kargadors ?? []) as KargadorOption[]);
      setProducts(((ps?.products ?? []) as Product[]).filter((p) => p.isActive !== false && weighed(p)));
    })().catch(() => setError("Could not load"));
  }, []);

  const loadJobs = useCallback(async () => {
    if (!locationId) return;
    const res = await fetch(`${API_URL}/admin/resacks?status=ALL&locationId=${encodeURIComponent(locationId)}`, { headers: adminHeaders() });
    if (res.ok) setJobs((await res.json()).resacks);
  }, [locationId]);
  useEffect(() => { void loadJobs(); }, [loadJobs]);
  const loadStock = useCallback(async () => {
    if (!locationId) return;
    const res = await fetch(`${API_URL}/admin/benta/catalog?locationId=${encodeURIComponent(locationId)}`, { headers: adminHeaders() });
    const d = res.ok ? ((await res.json().catch(() => null)) as { products?: { id: string; stock: Record<string, number> }[] } | null) : null;
    setStock(Object.fromEntries((d?.products ?? []).map((i) => [i.id, i.stock?.[locationId] ?? 0])));
  }, [locationId]);
  useEffect(() => { void loadStock(); }, [loadStock]);
  const left = (p: Product) => (isLoose(p) ? `${kg(stock[p.id] ?? 0)} kg left` : `${stock[p.id] ?? 0} sacks left`);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
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
  const readyToSign = gramsIn > 0 && outsValid && gramsOut <= gramsIn && !!(finishing?.kargador?.id ?? kargadorId);

  const reset = () => {
    setMode(null); setFinishing(null); setSigning(false); setInputId(""); setInputQty("1");
    setOuts([{ productId: "", amount: "" }]); setKargadorId("");
  };

  const sentence = () => {
    const outText = outs.map((o, i) => { const p = byId.get(o.productId); return p ? (isLoose(p) ? `${kg(outUnits[i] ?? 0)} kg ${p.name}` : `${outUnits[i]} × ${p.name}`) : ""; }).filter(Boolean).join(", ");
    const k = kargadors.find((x) => x.id === (finishing?.kargador?.id ?? kargadorId))?.name;
    const dala = k ? `, done by ${k}` : "";
    return `Resack at ${here?.name}: ${inQty} × ${inProduct?.name} (${kg(gramsIn)} kg) → ${outText} (${kg(gramsOut)} kg). ${loss > 0 ? `Short ${kg(loss)} kg (${lossPct.toFixed(1)}%)` : "Nothing short"}${dala}.`;
  };

  const submit = async (signatures: SignatureOut[]) => {
    setBusy(true);
    setError(null);
    const outputs = outs.map((o, i) => ({ productId: o.productId, quantity: outUnits[i] }));
    const k = kargadorId || undefined;
    let path = "/admin/resacks";
    let body: Record<string, unknown>;
    if (finishing) { path = `/admin/resacks/${finishing.id}/finish`; body = { outputs, signatures }; }
    else body = { locationId, inputProductId: inputId, inputQty: inQty, outputs, kargadorId: k, signatures };
    const r = await sendStep(path, body, `Resack ${inProduct?.name ?? ""}`.trim());
    setBusy(false);
    if (r.status === "queued") { toast("No signal — saved on this phone, it will be sent when the signal returns"); reset(); return; }
    const data = r.data as ApiBody | null;
    if (!r.ok) { setSigning(false); setError(errText(data, "Did not go through")); return; }
    toast(data?.needsApproval ? "Done — short by more than 1%, the owner was told" : "Resack done");
    const slip: Slip = {
      storeName: storeName || "SAM STORE", title: "RESACK RECEIPT", reference: String(data?.docNumber ?? "") || null, when: new Date().toLocaleString("en-PH"),
      lines: [{ label: "Store", value: here?.name ?? "" }, { label: "From", value: `${inQty} × ${inProduct?.name ?? ""} (${kg(gramsIn)} kg)` }],
      rows: outs.map((o, i) => { const p = byId.get(o.productId); return { name: p?.name ?? "", qty: p ? (isLoose(p) ? `${kg(outUnits[i] ?? 0)} kg` : `${outUnits[i]} sacks`) : "" }; }),
      totals: [{ label: "Out", value: `${kg(gramsOut)} kg` }, { label: loss > 0 ? "Short" : "Short", value: loss > 0 ? `${kg(loss)} kg (${lossPct.toFixed(1)}%)` : "none" }],
      signatures: [{ role: "Porter", name: kargadors.find((x) => x.id === (finishing?.kargador?.id ?? kargadorId))?.name ?? "" }],
      footer: "Signed on the device by the porter.", widthMm: 58,
    };
    reset();
    setReceipt(slip);
    await Promise.all([loadJobs(), loadStock()]);
  };

  const cancelJob = async (j: Job) => {
    const reason = await askText(`Why cancel ${j.docNumber}? (${j.inputQty} × ${j.input.name} goes back to the shelf)`, { ok: "Yes, cancel", danger: true });
    if (!reason) return;
    const res = await fetch(`${API_URL}/admin/resacks/${j.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify({ reason }) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok) { setError(errText(d, "Did not go through")); return; }
    toast("Cancelled — returned to the shelf");
    await loadJobs();
  };

  const started = jobs.filter((j) => j.status === "STARTED");
  const recent = jobs.filter((j) => j.status !== "STARTED").slice(0, 10);
  const reprint = (j: Job) => printSlip({
    storeName: storeName || "SAM STORE", title: j.status === "STARTED" ? "RESACK (IN PROGRESS)" : "RESACK RECEIPT", reference: j.docNumber, when: new Date(j.startedAt).toLocaleString("en-PH"),
    lines: [{ label: "Store", value: here?.name ?? "" }, { label: "From", value: `${j.inputQty} × ${j.input.name} (${kg(j.inputGrams)} kg)` }],
    rows: j.outputs.map((o) => ({ name: o.product.name, qty: o.product.soldByWeight ? `${kg(o.quantity)} kg` : `${o.quantity} sacks` })),
    totals: j.status === "FINISHED" ? [{ label: "Out", value: `${kg(j.outputGrams ?? 0)} kg` }, { label: "Short", value: `${kg(j.lossGrams ?? 0)} kg` }] : [],
    signatures: j.kargador ? [{ role: "Porter", name: j.kargador.name }] : [],
  });

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Resack</h1>
        {chosen && here && (homeLocationId ? <span className="badge text-bg-light border fs-6">{here.name}</span> : (
          <button type="button" className="btn btn-outline-secondary" onClick={() => { setChosen(false); setLocationId(""); reset(); setReceipt(null); }}>Store: {here.name} · change</button>
        ))}
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
      {products.length === 0 && <div className="alert alert-warning py-2">No rice with a weight set. In Products, set the size of each sack (e.g. 25 kg), or 1 g for loose rice.</div>}

      {!chosen && (
        <>
          <h2 className="h5">Which store?</h2>
          <div className="d-grid gap-2 mb-4" style={{ maxWidth: 420 }}>
            {locations.map((l) => <button key={l.id} type="button" className="btn btn-outline-success btn-lg" onClick={() => { setLocationId(l.id); setChosen(true); }}>{l.code ? `${l.code} · ` : ""}{l.name}</button>)}
          </div>
        </>
      )}

      {chosen && receipt && !mode && !finishing && (
        <div className="alert alert-success d-flex flex-wrap align-items-center justify-content-between gap-2">
          <strong>Resack saved{receipt.reference ? ` — ${receipt.reference}` : ""}.</strong>
          <span className="d-flex gap-2">
            <button type="button" className="btn btn-dark btn-lg" onClick={() => printSlip(receipt)}><i className="bi bi-printer me-1"></i>Print receipt</button>
            <button type="button" className="btn btn-outline-secondary" onClick={() => setReceipt(null)}>Close</button>
          </span>
        </div>
      )}

      {chosen && !mode && !finishing && (
        <>
          <div className="d-grid gap-2 mb-4" style={{ maxWidth: 420 }}>
            <button className="btn btn-success btn-lg" onClick={() => { setReceipt(null); setMode("now"); }}>Resack now</button>
          </div>
          <h2 className="h5">In resack ({started.length})</h2>
          {started.length === 0 ? <p className="text-muted">None.</p> : (
            <div className="list-group mb-4">
              {started.map((j) => (
                <div key={j.id} className="list-group-item py-3 d-flex justify-content-between align-items-center gap-2">
                  <div>
                    <div className="fw-semibold">{j.docNumber} · {j.inputQty} × {j.input.name}</div>
                    <div className="small text-muted">{kg(j.inputGrams)} kg{j.kargador ? ` · ${j.kargador.name}` : ""} · {new Date(j.startedAt).toLocaleString("en-PH")}</div>
                  </div>
                  <div className="d-flex gap-2">
                    <button className="btn btn-outline-dark" onClick={() => reprint(j)}><i className="bi bi-receipt me-1"></i>Receipt</button>
                    <button className="btn btn-outline-secondary" onClick={() => void cancelJob(j)}>Cancel</button>
                    <button className="btn btn-success" onClick={() => { setFinishing(j); setOuts([{ productId: "", amount: "" }]); }}>Finish</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <h2 className="h5">Recent resacks</h2>
          {recent.length === 0 ? <p className="text-muted">None yet.</p> : (
            <div className="list-group">
              {recent.map((j) => (
                <div key={j.id} className="list-group-item">
                  <div className="d-flex justify-content-between gap-2">
                    <div>
                      <div className="fw-semibold">{j.docNumber} · {j.inputQty} × {j.input.name} → {j.outputs.map((o) => (o.product.soldByWeight ? `${kg(o.quantity)} kg ${o.product.name}` : `${o.quantity} × ${o.product.name}`)).join(", ") || "—"}</div>
                      {j.status === "FINISHED" && <div className="small">{kg(j.inputGrams)} kg → {kg(j.outputGrams ?? 0)} kg · short {kg(j.lossGrams ?? 0)} kg ({((j.lossBp ?? 0) / 100).toFixed(2)}%)</div>}
                    </div>
                    <div className="text-end">
                      {j.status !== "CANCELLED" && <button type="button" className="btn btn-sm btn-outline-dark me-2" onClick={() => reprint(j)}><i className="bi bi-receipt me-1"></i>Receipt</button>}
                      {j.status === "CANCELLED" && <span className="badge text-bg-secondary">Cancelled</span>}
                      {j.varietyChange && <span className="badge text-bg-info ms-1">Variety change</span>}
                      {j.approvalId && <span className="badge text-bg-warning ms-1">To the owner</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {chosen && (mode || finishing) && !signing && (
        <div className="card border-success">
          <div className="card-body">
            <h2 className="h5">{finishing ? `Finish ${finishing.docNumber}` : "Resack now"}</h2>

            <div className="fw-semibold mt-2">Going in</div>
            {finishing ? <p className="mb-2">{finishing.inputQty} × {finishing.input.name} ({kg(finishing.inputGrams)} kg)</p> : (
              <div className="row g-2 mb-2">
                <div className="col-8">
                  <select className="form-select form-select-lg" aria-label="Rice going in" value={inputId} onChange={(e) => setInputId(e.target.value)}>
                    <option value="">Choose…</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name} — {left(p)}</option>)}
                  </select>
                </div>
                <div className="col-4">
                  <input className="form-control form-control-lg text-center" aria-label="How many sacks" inputMode="numeric" value={inputQty} onChange={(e) => setInputQty(e.target.value.replace(/\D/g, "").slice(0, 4))} />
                </div>
              </div>
            )}

            {(
              <>
                <div className="fw-semibold mt-3">Coming out</div>
                {outs.map((o, i) => {
                  const p = byId.get(o.productId);
                  return (
                    <div key={i} className="row g-2 mb-2 align-items-center">
                      <div className="col-7">
                        <select className="form-select form-select-lg" aria-label={`Coming out ${i + 1}`} value={o.productId} onChange={(e) => setOuts(outs.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                          <option value="">Choose…</option>
                          {products.map((x) => <option key={x.id} value={x.id}>{x.name} — {left(x)}</option>)}
                        </select>
                      </div>
                      <div className="col-4">
                        <div className="input-group input-group-lg">
                          <input className="form-control text-center" aria-label={isLoose(p) ? "How many kilos" : "How many sacks"} inputMode="decimal" value={o.amount}
                            onChange={(e) => setOuts(outs.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^\d.,]/g, "").slice(0, 8) } : x)))} />
                          <span className="input-group-text">{isLoose(p) ? "kg" : "sacks"}</span>
                        </div>
                      </div>
                      <div className="col-1">
                        {outs.length > 1 && <button type="button" className="btn btn-link text-danger" aria-label="Remove" onClick={() => setOuts(outs.filter((_, j) => j !== i))}>×</button>}
                      </div>
                    </div>
                  );
                })}
                {outs.length < 10 && <button type="button" className="btn btn-outline-secondary" onClick={() => setOuts([...outs, { productId: "", amount: "" }])}>+ Another output</button>}

                {gramsIn > 0 && (
                  <div className={`alert mt-3 mb-0 ${gramsOut > gramsIn ? "alert-danger" : overTolerance ? "alert-warning" : "alert-success"}`} style={{ fontVariantNumeric: "tabular-nums" }}>
                    <div>In: <strong>{kg(gramsIn)} kg</strong> · Out: <strong>{kg(gramsOut)} kg</strong></div>
                    {gramsOut > gramsIn ? <div>More came out than went in (<strong>over</strong>) — weigh again.</div>
                      : loss > 0 ? <div><strong>Short {kg(loss)} kg ({lossPct.toFixed(1)}%)</strong> — {overTolerance ? "over 1%: the owner will be told" : "OK, within 1%"}</div>
                      : <div><strong>Correct</strong> — nothing short</div>}
                  </div>
                )}
              </>
            )}

            {!finishing && (
              <div className="mt-3">
                <label className="form-label" htmlFor="rs-kargador">Porter (kargador) who did it — he signs</label>
                <select id="rs-kargador" className="form-select form-select-lg" value={kargadorId} onChange={(e) => setKargadorId(e.target.value)}>
                  <option value="">Choose…</option>
                  {kargadors.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
              </div>
            )}

            <div className="d-flex justify-content-between mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={reset}>Back</button>
              <button type="button" className="btn btn-success btn-lg" disabled={!readyToSign || (!finishing && !inputId)} onClick={() => setSigning(true)}>Next</button>
            </div>
          </div>
        </div>
      )}

      {(mode || finishing) && signing && (
        <SignCapture
          sentence={sentence()}
          staffName="you (staff)"
          skipStaff
          needKargador
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

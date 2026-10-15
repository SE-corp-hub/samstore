"use client";

// Rice Ops M5 — Benta: the counter sale on the staff member's own phone.
//   1. Tap the rice. A sack sells by piece; loose rice asks "Kilo o piso?" and opens the pad.
//      ₱100 at ₱52/kg shows 1.923 kg before it goes in the cart.
//   2. Each tile shows stock at every location; "Kunin sa …" serves a line from another one.
//   3. Bayad: Cash (pad → sukli), GCash (reference) or Utang (customer + their signature).
//   4. Galing sa papel: encode a paper slip — its number, the real time, a photo, staff signs.
//   Bagong item: a rice that isn't in the system yet, with what is on hand now.
// One idempotency key per sale, kept until it succeeds: a double-tap is one sale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
import { newSaleKey } from "../../lib/saleKey";
import { photoToJpeg } from "../../lib/photo";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import QuickCount from "./QuickCount";

interface Loc { id: string; name: string; code: string | null; type: string }
interface Item {
  id: string; name: string; loose: boolean; gramsPerUnit: number | null; priceMinor: number; forReview: boolean;
  stock: Record<string, number>; tracked: boolean;
}
interface Customer { id: string; creditApproved: boolean; creditLimitMinor: number; creditBalanceMinor: number; customer: { name: string; phone: string | null } }
type Mode = "PIECE" | "KILO" | "PESO";
interface CartLine { productId: string; mode: Mode; value: string; sourceLocationId: string | null }
type Pay = "cash" | "gcash" | "utang";
type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;

const peso = (m: number) => `₱${(m / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const kg = (g: number) => `${(g / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg`;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;
const toMinor = (s: string) => Math.round(Number(s || "0") * 100);

/** What a cart line comes to — the same arithmetic the server does (domain/selling.ts). */
function lineOf(item: Item | undefined, l: CartLine): { grams: number | null; units: number; totalMinor: number } {
  if (!item) return { grams: null, units: 0, totalMinor: 0 };
  if (l.mode === "PESO") {
    const amt = toMinor(l.value);
    const g = amt > 0 ? Math.floor((amt * 1000) / item.priceMinor) : 0;
    return { grams: g, units: g, totalMinor: g > 0 ? amt : 0 };
  }
  if (l.mode === "KILO") {
    const g = Math.round(Number(l.value || "0") * 1000);
    const scaled = g * item.priceMinor;
    return { grams: g, units: g, totalMinor: Math.floor(scaled / 1000) + (scaled % 1000 >= 500 ? 1 : 0) };
  }
  const n = Number(l.value || "0");
  return { grams: item.gramsPerUnit ? item.gramsPerUnit * n : null, units: n, totalMinor: n * item.priceMinor };
}

export default function BentaPanel() {
  const [locations, setLocations] = useState<Loc[]>([]);
  const [locationId, setLocationId] = useState("");
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [step, setStep] = useState<"pick" | "pay" | "done">("pick");
  const [pay, setPay] = useState<Pay | null>(null);
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerSig, setCustomerSig] = useState<string | null>(null);
  const [paper, setPaper] = useState(false);
  const [slipNo, setSlipNo] = useState("");
  const [slipTime, setSlipTime] = useState("");
  const [slipPhoto, setSlipPhoto] = useState<string | null>(null);
  const [staffSig, setStaffSig] = useState<string | null>(null);
  const [last, setLast] = useState<{ status: "COMPLETED" | "WAITING_OWNER" | "DECLINED"; smsStatus: string | null; orderNumber: string; totalMinor: number; changeMinor: number; lines: { name: string; soldBy: string | null; quantity: number; grams: number | null; lineTotalMinor: number }[]; releases: { docNumber: string }[]; zeroCheck: { productId: string; name: string }[] } | null>(null);
  const [checking, setChecking] = useState<{ productId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const keyRef = useRef<string | null>(null);

  const loadCatalog = useCallback(async (loc?: string) => {
    const q = loc ? `?locationId=${encodeURIComponent(loc)}` : "";
    const res = await fetch(`${API_URL}/admin/benta/catalog${q}`, { headers: adminHeaders() });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    if (!res.ok || !d) { setError(errText(d, "Hindi ma-load ang mga produkto")); return; }
    setLocations(d.locations as Loc[]);
    setItems(d.products as Item[]);
    setLocationId((d.location as Loc).id);
  }, []);

  useEffect(() => {
    (async () => {
      const [me, cs] = await Promise.all([
        fetch(`${API_URL}/admin/me/rice`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_URL}/admin/customers`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)),
      ]);
      setHomeLocationId(me?.homeLocationId ?? null);
      setCustomers(((cs?.customers ?? []) as Customer[]));
      await loadCatalog(me?.homeLocationId ?? undefined);
    })().catch(() => setError("Hindi ma-load"));
  }, [loadCatalog]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const here = locations.find((l) => l.id === locationId);
  const code = (id: string) => { const l = locations.find((x) => x.id === id); return l?.code ?? l?.name ?? "?"; };
  const shown = items.filter((i) => {
    const q = search.trim().toLowerCase();
    return !q || i.name.toLowerCase().includes(q) || i.name.toLowerCase().split(/\s+/).map((w) => w[0]).join("").startsWith(q);
  });
  const computed = cart.map((l) => lineOf(byId.get(l.productId), l));
  const total = computed.reduce((s, c) => s + c.totalMinor, 0);
  const change = pay === "cash" && tendered ? toMinor(tendered) - total : 0;
  const customer = customers.find((c) => c.id === customerId);

  const reset = () => {
    keyRef.current = null;
    setCart([]); setStep("pick"); setPay(null); setTendered(""); setReference(""); setCustomerId(""); setCustomerSig(null);
    setPaper(false); setSlipNo(""); setSlipTime(""); setSlipPhoto(null); setStaffSig(null); setError(null);
  };

  const canSubmit = total > 0 && !!pay && !busy
    && (pay !== "cash" || !tendered || toMinor(tendered) >= total)
    && (pay !== "gcash" || reference.trim().length >= 4)
    && (pay !== "utang" || (!!customer && !!customerSig))
    && (!paper || (!!slipNo.trim() && !!slipTime && !!slipPhoto && !!staffSig));

  const submit = async () => {
    if (!canSubmit || !pay) return;
    setBusy(true); setError(null);
    if (!keyRef.current) keyRef.current = newSaleKey();
    const signatures: Record<string, unknown>[] = [];
    if (pay === "utang" && customerSig) signatures.push({ signerKind: "CUSTOMER", signerName: customer?.customer.name ?? "Customer", imagePng: customerSig });
    if (paper && staffSig && slipPhoto) signatures.push({ signerKind: "STAFF", imagePng: staffSig }, { signerKind: "SLIP_PHOTO", imagePng: slipPhoto });
    const body = {
      idempotencyKey: keyRef.current, locationId,
      lines: cart.map((l) => ({
        productId: l.productId, sourceLocationId: l.sourceLocationId ?? undefined,
        ...(l.mode === "PIECE" ? { quantity: Number(l.value) } : l.mode === "KILO" ? { kilos: l.value } : { amountMinor: toMinor(l.value) }),
      })),
      payment: { method: pay, tenderedMinor: pay === "cash" && tendered ? toMinor(tendered) : undefined, reference: pay === "gcash" ? reference.trim() : undefined },
      customerId: pay === "utang" ? customerId : undefined,
      paperSlip: paper ? { slipNo: slipNo.trim(), occurredAt: new Date(slipTime).toISOString() } : undefined,
      signatures,
    };
    try {
      // Rice Ops M10: with no signal the sale waits on the phone and is sent later — once (same key).
      const sent = await sendStep("/admin/benta", body, `Benta ${peso(total)}`);
      if (sent.status === "queued") {
        toast("Walang signal — naka-save ang benta sa phone, ipapadala pagbalik ng signal");
        reset();
        return;
      }
      const d = sent.data as ApiBody | null;
      if (!sent.ok || !d) { setError(errText(d, "Hindi natuloy ang benta")); return; }
      setLast(d as unknown as NonNullable<typeof last>);
      toast(d.status === "WAITING_OWNER" ? `Naghihintay sa may-ari: ${String(d.orderNumber)}` : `Naibenta: ${String(d.orderNumber)}`);
      keyRef.current = null;
      setStep("done");
      await loadCatalog(locationId);
    } catch {
      setError("Walang signal — subukan ulit. Hindi madodoble ang benta.");
    } finally {
      setBusy(false);
    }
  };

  // ───────────── screens ─────────────

  if (step === "done" && last) {
    return (
      <div style={{ fontSize: 18, maxWidth: 520 }}>
        {last.status === "WAITING_OWNER" ? (
          <div className="alert alert-warning">
            <div className="h4 mb-1">Naghihintay sa may-ari</div>
            <div>{last.orderNumber} — lampas sa utang limit. Nakareserba ang bigas; ibibigay kapag inaprubahan ng may-ari.</div>
          </div>
        ) : (
          <div className="alert alert-success">
            <div className="h4 mb-1">Naibenta na</div>
            <div>{last.orderNumber}</div>
            {last.smsStatus === "QUEUED" && <div className="small">Ipinapadala ang text sa customer.</div>}
            {last.smsStatus === "SKIPPED" && <div className="small">Walang text — walang mobile number ang customer.</div>}
          </div>
        )}
        <ul className="list-group mb-3" style={{ fontVariantNumeric: "tabular-nums" }}>
          {last.lines.map((l, i) => (
            <li key={i} className="list-group-item d-flex justify-content-between">
              <span>{l.soldBy === "PIECE" || !l.grams ? `${l.quantity} × ` : `${kg(l.grams)} `}{l.name}</span>
              <span>{peso(l.lineTotalMinor)}</span>
            </li>
          ))}
          <li className="list-group-item d-flex justify-content-between fw-bold" style={{ fontSize: 28 }}><span>Kabuuan</span><span>{peso(last.totalMinor)}</span></li>
          {last.changeMinor > 0 && <li className="list-group-item d-flex justify-content-between fw-bold" style={{ fontSize: 24 }}><span>Sukli</span><span>{peso(last.changeMinor)}</span></li>}
        </ul>
        {last.releases.length > 0 && <div className="alert alert-info">Ilalabas sa ibang lokasyon: {last.releases.map((r) => r.docNumber).join(", ")}</div>}
        {checking ? (
          <QuickCount productId={checking.productId} name={checking.name} loose={!!byId.get(checking.productId)?.loose} locationId={locationId}
            onCancel={() => { setLast({ ...last, zeroCheck: last.zeroCheck.filter((z) => z.productId !== checking.productId) }); setChecking(null); }}
            onDone={async () => { setLast({ ...last, zeroCheck: last.zeroCheck.filter((z) => z.productId !== checking.productId) }); setChecking(null); await loadCatalog(locationId); }} />
        ) : last.zeroCheck.length > 0 && (
          <div className="alert alert-warning">
            <div className="fw-semibold mb-2">Ubos na raw dito: {last.zeroCheck.map((z) => z.name).join(", ")}. May natira pa ba?</div>
            <div className="d-flex flex-wrap gap-2">
              {last.zeroCheck.map((z) => <button key={z.productId} type="button" className="btn btn-dark" onClick={() => setChecking(z)}>Bilangin {z.name}</button>)}
              <button type="button" className="btn btn-outline-dark" onClick={() => setLast({ ...last, zeroCheck: [] })}>Wala na</button>
            </div>
          </div>
        )}
        <button className="btn btn-success btn-lg w-100" onClick={reset}>Bagong benta</button>
      </div>
    );
  }

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Benta</h1>
        {homeLocationId ? <span className="badge text-bg-light border fs-6">{here?.name}</span> : (
          <select className="form-select" style={{ maxWidth: 240 }} aria-label="Lokasyon" value={locationId} onChange={(e) => { reset(); void loadCatalog(e.target.value); }}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} · ` : ""}{l.name}</option>)}
          </select>
        )}
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {step === "pick" && !editing && !newItem && (
        <>
          <input className="form-control form-control-lg mb-3" placeholder="Hanapin (pangalan o unang letra)" aria-label="Hanapin" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="row g-2 mb-3">
            {shown.map((i) => (
              <div key={i.id} className="col-6 col-md-4 col-lg-3">
                <button type="button" className="btn btn-outline-dark w-100 h-100 text-start p-2" style={{ minHeight: 120 }}
                  onClick={() => setEditing({ productId: i.id, mode: i.loose ? "KILO" : "PIECE", value: "", sourceLocationId: null })}>
                  <div className="fw-semibold">{i.name}{i.forReview && <span className="badge text-bg-warning ms-1">Susuriin</span>}</div>
                  <div style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }}>{peso(i.priceMinor)}<span className="fs-6 text-muted">{i.loose ? "/kg" : ""}</span></div>
                  <div className="small" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {locations.map((l) => {
                      const n = i.stock[l.id] ?? 0;
                      return <span key={l.id} className={`me-2 ${n === 0 ? "text-danger" : ""}`}>{l.code ?? l.name} {i.loose ? kg(n) : n}</span>;
                    })}
                  </div>
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-outline-secondary mb-3" onClick={() => setNewItem(true)}>+ Bagong item (wala pa sa listahan)</button>

          {cart.length > 0 && (
            <div className="card border-success position-sticky bottom-0">
              <div className="card-body">
                <ul className="list-unstyled mb-2" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {cart.map((l, idx) => {
                    const it = byId.get(l.productId);
                    const c = computed[idx]!;
                    return (
                      <li key={idx} className="d-flex justify-content-between align-items-center py-1 border-bottom">
                        <span>
                          {l.mode === "PIECE" ? `${l.value} × ` : `${kg(c.grams ?? 0)} `}{it?.name}
                          {l.mode === "PESO" && <span className="text-muted"> (₱{l.value})</span>}
                          {l.sourceLocationId && <span className="badge text-bg-info ms-1">kunin sa {code(l.sourceLocationId)}</span>}
                        </span>
                        <span className="text-nowrap">{peso(c.totalMinor)}
                          <button type="button" className="btn btn-link text-danger p-0 ms-2" aria-label="Alisin" onClick={() => setCart(cart.filter((_, j) => j !== idx))}>×</button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="d-flex justify-content-between align-items-center">
                  <span style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }} className="fw-bold">{peso(total)}</span>
                  <button type="button" className="btn btn-success btn-lg" onClick={() => setStep("pay")}>Bayad</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {step === "pick" && checking && (
        <QuickCount productId={checking.productId} name={checking.name} loose={!!byId.get(checking.productId)?.loose} locationId={locationId}
          onCancel={() => setChecking(null)} onDone={async () => { setChecking(null); await loadCatalog(locationId); }} />
      )}

      {step === "pick" && editing && !checking && (() => {
        const it = byId.get(editing.productId);
        if (!it) return null;
        const c = lineOf(it, editing);
        const from = editing.sourceLocationId ?? locationId;
        const avail = it.stock[from] ?? 0;
        const short = it.tracked && c.units > avail;
        return (
          <div className="card border-success" style={{ maxWidth: 520 }}>
            <div className="card-body">
              <h2 className="h5">{it.name} · {peso(it.priceMinor)}{it.loose ? "/kg" : ""}</h2>
              {it.loose && (
                <div className="btn-group w-100 mb-3" role="group" aria-label="Kilo o piso?">
                  <button type="button" className={`btn btn-lg ${editing.mode === "KILO" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setEditing({ ...editing, mode: "KILO", value: "" })}>Kilo</button>
                  <button type="button" className={`btn btn-lg ${editing.mode === "PESO" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setEditing({ ...editing, mode: "PESO", value: "" })}>Piso</button>
                </div>
              )}
              <NumPad value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} decimals={editing.mode === "KILO" ? 3 : editing.mode === "PESO" ? 2 : 0}
                label={editing.mode === "PESO" ? "Halaga sa piso" : editing.mode === "KILO" ? "Ilang kilo" : "Ilan"} unit={editing.mode === "PESO" ? "₱" : editing.mode === "KILO" ? "kg" : it.gramsPerUnit ? "sako" : "piraso"} />
              <div className="mt-2" style={{ fontVariantNumeric: "tabular-nums" }}>
                {editing.mode === "PESO" && c.grams ? <div className="fs-5">= <strong>{kg(c.grams)}</strong> · bayad <strong>{peso(c.totalMinor)}</strong></div> : null}
                {editing.mode === "KILO" && c.totalMinor > 0 ? <div className="fs-5">= <strong>{peso(c.totalMinor)}</strong></div> : null}
                {editing.mode === "PIECE" && c.totalMinor > 0 ? <div className="fs-5">= <strong>{peso(c.totalMinor)}</strong></div> : null}
              </div>
              <label className="form-label mt-3" htmlFor="bt-from">Kunin sa</label>
              <select id="bt-from" className="form-select form-select-lg" value={from} onChange={(e) => setEditing({ ...editing, sourceLocationId: e.target.value === locationId ? null : e.target.value })}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.id === locationId ? " (dito)" : ""} — {it.loose ? kg(it.stock[l.id] ?? 0) : `${it.stock[l.id] ?? 0}`}</option>)}
              </select>
              {short && (
                <div className="alert alert-danger mt-2 mb-0">
                  <strong>Kulang</strong> — {it.loose ? kg(avail) : avail} lang sa {code(from)}. Bawasan, o kunin sa ibang lokasyon.
                  {from === locationId && <button type="button" className="btn btn-dark btn-sm ms-2" onClick={() => setChecking({ productId: it.id, name: it.name })}>May natira pa? Bilangin</button>}
                </div>
              )}
              <div className="d-flex justify-content-between mt-3">
                <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setEditing(null)}>Bumalik</button>
                <button type="button" className="btn btn-success btn-lg" disabled={c.totalMinor <= 0 || short || (editing.mode === "PIECE" && !Number.isInteger(c.units))}
                  onClick={() => { setCart([...cart, editing]); setEditing(null); setSearch(""); }}>Idagdag</button>
              </div>
            </div>
          </div>
        );
      })()}

      {step === "pick" && newItem && <NewItemForm locationId={locationId} onCancel={() => setNewItem(false)} onDone={async () => { setNewItem(false); await loadCatalog(locationId); }} />}

      {step === "pay" && (
        <div className="card border-success" style={{ maxWidth: 520 }}>
          <div className="card-body">
            <div className="small text-muted">Hakbang 2 sa 2</div>
            <div className="d-flex justify-content-between align-items-baseline mb-3">
              <h2 className="h5 mb-0">Bayad</h2>
              <span className="fw-bold" style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }}>{peso(total)}</span>
            </div>
            <div className="d-grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {(["cash", "gcash", "utang"] as Pay[]).map((p) => (
                <button key={p} type="button" className={`btn btn-lg ${pay === p ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setPay(p)}>
                  {p === "cash" ? "Cash" : p === "gcash" ? "GCash" : "Utang"}
                </button>
              ))}
            </div>

            {pay === "cash" && (
              <>
                <NumPad value={tendered} onChange={setTendered} decimals={2} label="Perang tinanggap" unit="₱" />
                {tendered && <div className={`mt-2 fs-4 ${change < 0 ? "text-danger" : ""}`} style={{ fontVariantNumeric: "tabular-nums" }}>{change < 0 ? `Kulang ${peso(-change)}` : `Sukli ${peso(change)}`}</div>}
              </>
            )}
            {pay === "gcash" && (
              <>
                <label className="form-label" htmlFor="bt-ref">GCash reference no.</label>
                <input id="bt-ref" className="form-control form-control-lg" inputMode="numeric" value={reference} onChange={(e) => setReference(e.target.value.replace(/\s/g, "").slice(0, 40))} />
              </>
            )}
            {pay === "utang" && (
              <>
                <label className="form-label" htmlFor="bt-cust">Customer</label>
                <select id="bt-cust" className="form-select form-select-lg mb-2" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setCustomerSig(null); }}>
                  <option value="">Pumili…</option>
                  {customers.filter((c) => c.creditApproved).map((c) => <option key={c.id} value={c.id}>{c.customer.name} — utang {peso(c.creditBalanceMinor)}</option>)}
                </select>
                {customer && (
                  <>
                    <p className="mb-2">Utang ngayon: <strong>{peso(total)}</strong>. Kabuuang utang pagkatapos: <strong>{peso(customer.creditBalanceMinor + total)}</strong>.</p>
                    {customer.creditLimitMinor > 0 && customer.creditBalanceMinor + total > customer.creditLimitMinor && (
                      <div className="alert alert-warning py-2">Lampas sa limit ({peso(customer.creditLimitMinor)}) — ipapaalam sa may-ari. Nakareserba ang bigas habang naghihintay.</div>
                    )}
                    <div className="fw-semibold">Pirma ni {customer.customer.name}</div>
                    <SignaturePad key={customerId} onSignature={setCustomerSig} />
                  </>
                )}
              </>
            )}

            <div className="form-check form-switch mt-3">
              <input className="form-check-input" type="checkbox" id="bt-paper" checked={paper} onChange={(e) => setPaper(e.target.checked)} />
              <label className="form-check-label" htmlFor="bt-paper">Galing sa papel (i-encode ang slip)</label>
            </div>
            {paper && (
              <div className="border rounded p-2 mt-2">
                <div className="row g-2">
                  <div className="col-5">
                    <label className="form-label" htmlFor="bt-slip">Numero ng papel</label>
                    <input id="bt-slip" className="form-control form-control-lg" value={slipNo} onChange={(e) => setSlipNo(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20))} />
                  </div>
                  <div className="col-7">
                    <label className="form-label" htmlFor="bt-time">Petsa at oras sa papel</label>
                    <input id="bt-time" type="datetime-local" className="form-control form-control-lg" value={slipTime} onChange={(e) => setSlipTime(e.target.value)} />
                  </div>
                </div>
                <label className="form-label mt-2" htmlFor="bt-photo">Litrato ng papel</label>
                <input id="bt-photo" type="file" accept="image/*" capture="environment" className="form-control"
                  onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setSlipPhoto(await photoToJpeg(f)); } catch (err) { setError(err instanceof Error ? err.message : "Hindi mabasa ang litrato"); } }} />
                {slipPhoto && <img src={slipPhoto} alt="Litrato ng papel" className="img-fluid mt-2 border" style={{ maxHeight: 160 }} />}
                <div className="fw-semibold mt-2">Pirma mo (staff)</div>
                <SignaturePad onSignature={setStaffSig} />
              </div>
            )}

            <div className="d-flex justify-content-between mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={() => setStep("pick")}>Bumalik</button>
              <button type="button" className="btn btn-success btn-lg" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "Sandali…" : "Tapos"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Bagong item: name, sold as, weight, price, cost, what is on hand now — signed by staff. */
function NewItemForm({ locationId, onCancel, onDone }: { locationId: string; onCancel: () => void; onDone: () => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [soldAs, setSoldAs] = useState<"SACK" | "KILO" | "PIECE">("SACK");
  const [kilosPerSack, setKilosPerSack] = useState("25");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [onHand, setOnHand] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length >= 2 && Number(price) > 0 && Number(onHand) > 0 && !!sig && (soldAs !== "SACK" || Number(kilosPerSack) > 0);

  const save = async () => {
    setBusy(true); setError(null);
    const body = {
      name: name.trim(), soldAs, locationId,
      gramsPerSack: soldAs === "SACK" ? Math.round(Number(kilosPerSack) * 1000) : undefined,
      priceMinor: toMinor(price), costMinor: toMinor(cost),
      openingQty: soldAs === "KILO" ? Math.round(Number(onHand) * 1000) : Math.floor(Number(onHand)),
      signatures: [{ signerKind: "STAFF", imagePng: sig }],
    };
    const res = await fetch(`${API_URL}/admin/benta/manual-item`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => null)) as ApiBody | null;
    setBusy(false);
    if (!res.ok) { setError(errText(d, "Hindi naidagdag")); return; }
    toast(`Naidagdag: ${name.trim()} (Susuriin ng may-ari)`);
    await onDone();
  };

  const num = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 10);
  return (
    <div className="card border-success" style={{ maxWidth: 520 }}>
      <div className="card-body">
        <h2 className="h5">Bagong item</h2>
        {error && <div className="alert alert-danger py-2">{error}</div>}
        <label className="form-label" htmlFor="ni-name">Pangalan</label>
        <input id="ni-name" className="form-control form-control-lg mb-2" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} />
        <div className="btn-group w-100 mb-2" role="group" aria-label="Binebenta bilang">
          {(["SACK", "KILO", "PIECE"] as const).map((s) => (
            <button key={s} type="button" className={`btn btn-lg ${soldAs === s ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setSoldAs(s)}>{s === "SACK" ? "Sako" : s === "KILO" ? "Kilo" : "Piraso"}</button>
          ))}
        </div>
        {soldAs === "SACK" && (
          <><label className="form-label" htmlFor="ni-kg">Ilang kilo ang isang sako</label>
            <input id="ni-kg" className="form-control form-control-lg mb-2" inputMode="decimal" value={kilosPerSack} onChange={(e) => setKilosPerSack(num(e.target.value))} /></>
        )}
        <div className="row g-2">
          <div className="col-6"><label className="form-label" htmlFor="ni-price">Presyo{soldAs === "KILO" ? " /kg" : ""} (₱)</label>
            <input id="ni-price" className="form-control form-control-lg" inputMode="decimal" value={price} onChange={(e) => setPrice(num(e.target.value))} /></div>
          <div className="col-6"><label className="form-label" htmlFor="ni-cost">Puhunan{soldAs === "KILO" ? " /kg" : ""} (₱)</label>
            <input id="ni-cost" className="form-control form-control-lg" inputMode="decimal" value={cost} onChange={(e) => setCost(num(e.target.value))} /></div>
        </div>
        <label className="form-label mt-2" htmlFor="ni-onhand">Hawak ngayon ({soldAs === "KILO" ? "kilo" : soldAs === "SACK" ? "sako" : "piraso"})</label>
        <input id="ni-onhand" className="form-control form-control-lg mb-2" inputMode="decimal" value={onHand} onChange={(e) => setOnHand(num(e.target.value))} />
        <div className="fw-semibold">Pirma mo (staff)</div>
        <SignaturePad onSignature={setSig} />
        <div className="d-flex justify-content-between mt-3">
          <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={onCancel}>Bumalik</button>
          <button type="button" className="btn btn-success btn-lg" disabled={!ready || busy} onClick={() => void save()}>{busy ? "Sandali…" : "Idagdag"}</button>
        </div>
      </div>
    </div>
  );
}

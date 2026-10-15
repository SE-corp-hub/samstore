"use client";

// Rice Ops M3 — Lipat at Ilabas: every trip between locations, by step.
//   Ilabas            — stock waiting to leave this location (count, pick kargador, sign)
//   Tanggapin         — restock on its way here (count what arrived, sign)
//   Naihatid          — this store's sales served from another location (count delivered, sign)
//   Tanggapin pabalik — refused / partial deliveries coming back here
//   Ibinalik          — a customer brings rice back after a sale
// Staff see their own location; owner/manager pick any. One question per screen,
// numbers in a big field, the sentence is read back before anyone signs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import SignCapture, { type KargadorOption, type SignatureOut } from "./SignCapture";

type View = "ilabas" | "tanggapin" | "naihatid" | "pabalik" | "all";
interface Place { id: string; name: string; code: string | null }
interface Trip {
  id: string; docNumber: string | null; kind: "RESTOCK" | "ORDER_RELEASE"; status: string; quantity: number;
  releasedQty: number | null; receivedQty: number | null; deliveredQty: number | null; returnedQty: number | null;
  shortQty: number; pendingReturn: number; from: Place; to: Place; product: { id: string; name: string };
  kargador: { id: string; name: string } | null; order: { orderNumber: string } | null; customerName: string | null; createdAt: string;
}
interface Location extends Place { isActive: boolean }
interface ProductOption { id: string; name: string }
type ApiBody = { message?: string; errors?: string[] };

const VIEWS: { id: View; label: string }[] = [
  { id: "ilabas", label: "Ilabas" },
  { id: "tanggapin", label: "Tanggapin" },
  { id: "naihatid", label: "Naihatid" },
  { id: "pabalik", label: "Pabalik" },
  { id: "all", label: "Lahat" },
];
const STATUS: Record<string, [string, string]> = {
  REQUESTED: ["text-bg-warning", "Naghihintay ng apruba"],
  APPROVED: ["text-bg-warning", "Naghihintay ilabas"],
  IN_TRANSIT: ["text-bg-primary", "Nasa daan"],
  RETURNING: ["text-bg-warning", "Pabalik"],
  COMPLETED: ["text-bg-success", "Tapos"],
  CANCELLED: ["text-bg-secondary", "Kinansela"],
};
const errText = (d: ApiBody | null, fallback: string) => d?.errors?.join(", ") ?? d?.message ?? fallback;

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => null)) as (ApiBody & Record<string, unknown>) | null };
}

type Step = { trip: Trip; action: "release" | "receive" | "deliver" | "return"; qty: string; note: string; kargadorId: string; signing: boolean };

export default function TripsPanel() {
  const [view, setView] = useState<View>("ilabas");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [homeLocationId, setHomeLocationId] = useState<string | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [kargadors, setKargadors] = useState<KargadorOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState<{ productId: string; qty: string; condition: "GOOD" | "DAMAGED"; reason: string; signing: boolean } | null>(null);

  // Facts that do not change while the panel is open.
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
      const plist = (ps?.products ?? ps?.items ?? []) as ProductOption[];
      setProducts(plist.map((p) => ({ id: p.id, name: p.name })));
    })().catch(() => setError("Hindi ma-load ang mga lokasyon"));
  }, []);

  const load = useCallback(async () => {
    if (!locationId && view !== "all") return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ view, ...(locationId ? { locationId } : {}) });
      const res = await fetch(`${API_URL}/admin/trips?${q}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Hindi ma-load ang mga lipat");
      setTrips((await res.json()).trips);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [view, locationId]);

  useEffect(() => { void load(); }, [load]);

  const here = useMemo(() => locations.find((l) => l.id === locationId), [locations, locationId]);

  const open = (trip: Trip, action: Step["action"]) => {
    const qty = action === "release" ? trip.quantity : action === "return" ? trip.pendingReturn : trip.releasedQty ?? 0;
    setStep({ trip, action, qty: String(qty), note: "", kargadorId: trip.kargador?.id ?? "", signing: false });
  };

  const sentence = (s: Step) => {
    const n = Number(s.qty);
    const k = kargadors.find((x) => x.id === s.kargadorId)?.name;
    const dala = k ? `, dala ni ${k}` : "";
    switch (s.action) {
      case "release": return `Ilalabas: ${n} × ${s.trip.product.name} mula ${s.trip.from.name}${dala}, para sa ${s.trip.kind === "ORDER_RELEASE" ? `customer (${s.trip.customerName ?? "customer"})` : s.trip.to.name}.`;
      case "receive": return `Tatanggapin sa ${s.trip.to.name}: ${n} × ${s.trip.product.name} galing ${s.trip.from.name}${dala}.`;
      case "deliver": return `Naihatid kay ${s.trip.customerName ?? "customer"}: ${n} × ${s.trip.product.name}${dala}.`;
      case "return": return `Ibinalik sa ${s.trip.from.name}: ${n} × ${s.trip.product.name}${dala}.`;
    }
  };

  const submit = async (s: Step, signatures: SignatureOut[]) => {
    setBusy(true);
    setError(null);
    const kargadorId = signatures.find((x) => x.signerKind === "KARGADOR")?.kargadorId ?? s.kargadorId;
    const body = { quantity: Number(s.qty), signatures, ...(s.action === "release" ? { kargadorId } : {}), ...(s.action === "deliver" ? { note: s.note } : {}) };
    const { ok, data } = await post(`/admin/trips/${s.trip.id}/${s.action}`, body);
    setBusy(false);
    setStep(null);
    if (!ok) { setError(errText(data, "Hindi natuloy")); return; }
    const short = Number((data as Record<string, unknown>)?.shortQty ?? 0);
    const pending = Number((data as Record<string, unknown>)?.pendingReturn ?? 0);
    toast(s.action === "release" ? "Nailabas na" : s.action === "receive" ? (short ? `Natanggap — kulang ${short}, ipinaalam sa may-ari` : "Natanggap na")
      : s.action === "deliver" ? (pending ? `Naihatid — ${pending} pabalik` : "Naihatid na") : (short ? `Naibalik — kulang ${short}` : "Naibalik na"));
    await load();
  };

  const submitReturn = async (signatures: SignatureOut[]) => {
    if (!returning) return;
    setBusy(true);
    const { ok, data } = await post("/admin/returns", {
      locationId, productId: returning.productId, quantity: Number(returning.qty), condition: returning.condition, reason: returning.reason, signatures,
    });
    setBusy(false);
    setReturning(null);
    if (!ok) { setError(errText(data, "Hindi natuloy")); return; }
    toast(`Naitala ang ibinalik (${String((data as Record<string, unknown>)?.docNumber ?? "")})`);
    await load();
  };

  const qtyOk = (s: Step) => {
    const n = Number(s.qty);
    if (!Number.isInteger(n) || n < 0) return false;
    if (s.action === "release") return n >= 1 && n <= s.trip.quantity;
    if (s.action === "return") return n <= s.trip.pendingReturn;
    return n <= (s.trip.releasedQty ?? 0);
  };
  const needsNote = (s: Step) => s.action === "deliver" && Number(s.qty) < (s.trip.releasedQty ?? 0);

  return (
    <div style={{ fontSize: 18 }}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h1 className="h4 mb-0">Lipat at Ilabas</h1>
        {homeLocationId ? (
          <span className="badge text-bg-light border fs-6">{here?.name ?? ""}</span>
        ) : (
          <select className="form-select" style={{ maxWidth: 240 }} aria-label="Lokasyon" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} · ` : ""}{l.name}</option>)}
          </select>
        )}
      </div>

      <div className="btn-group w-100 mb-3" role="group" aria-label="Hakbang">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" className={`btn ${view === v.id ? "btn-dark" : "btn-outline-dark"}`} onClick={() => { setView(v.id); setStep(null); }}>{v.label}</button>
        ))}
      </div>
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

      {step && !step.signing && (
        <div className="card border-success mb-3">
          <div className="card-body">
            <div className="fw-semibold mb-2">{step.trip.docNumber} · {step.trip.product.name}</div>
            <label className="form-label" htmlFor="tp-qty">
              {step.action === "release" ? `Ilan ang ilalabas? (hiningi: ${step.trip.quantity})`
                : step.action === "receive" ? `Ilan ang dumating? (inilabas: ${step.trip.releasedQty})`
                : step.action === "deliver" ? `Ilan ang naihatid? (inilabas: ${step.trip.releasedQty})`
                : `Ilan ang naibalik? (dapat: ${step.trip.pendingReturn})`}
            </label>
            <input id="tp-qty" className="form-control form-control-lg text-center mb-3" style={{ maxWidth: 200, fontSize: 28, fontVariantNumeric: "tabular-nums" }}
              inputMode="numeric" value={step.qty} onChange={(e) => setStep({ ...step, qty: e.target.value.replace(/\D/g, "").slice(0, 5) })} />
            {needsNote(step) && (
              <div className="mb-3">
                <label className="form-label" htmlFor="tp-note">Bakit hindi lahat? (babalik ang natira)</label>
                <input id="tp-note" className="form-control form-control-lg" value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} />
              </div>
            )}
            {step.action === "receive" && Number(step.qty) < (step.trip.releasedQty ?? 0) && qtyOk(step) && (
              <div className="alert alert-warning py-2"><strong>Kulang</strong> ng {(step.trip.releasedQty ?? 0) - Number(step.qty)} — itatala sa lipat at ipapaalam sa may-ari.</div>
            )}
            <div className="d-flex justify-content-between">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setStep(null)}>Bumalik</button>
              <button type="button" className="btn btn-success btn-lg" disabled={!qtyOk(step) || (needsNote(step) && step.note.trim().length < 3)} onClick={() => setStep({ ...step, signing: true })}>Susunod</button>
            </div>
          </div>
        </div>
      )}
      {step && step.signing && (
        <SignCapture
          sentence={sentence(step)}
          staffName="ikaw (staff)"
          needKargador
          kargadors={kargadors}
          presetKargadorId={step.action === "release" ? null : step.trip.kargador?.id ?? null}
          customer={step.action === "deliver" ? { name: step.trip.customerName, optional: true } : undefined}
          busy={busy}
          onCancel={() => setStep({ ...step, signing: false })}
          onDone={(sigs) => void submit(step, sigs)}
        />
      )}

      {returning && !returning.signing && (
        <div className="card border-success mb-3">
          <div className="card-body">
            <h2 className="h5">Ibinalik ng customer — sa {here?.name}</h2>
            <label className="form-label" htmlFor="rt-product">Anong bigas?</label>
            <select id="rt-product" className="form-select form-select-lg mb-2" value={returning.productId} onChange={(e) => setReturning({ ...returning, productId: e.target.value })}>
              <option value="">Pumili…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label className="form-label" htmlFor="rt-qty">Ilan?</label>
            <input id="rt-qty" className="form-control form-control-lg mb-2" style={{ maxWidth: 160 }} inputMode="numeric" value={returning.qty} onChange={(e) => setReturning({ ...returning, qty: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
            <div className="btn-group mb-2" role="group" aria-label="Kondisyon">
              <button type="button" className={`btn btn-lg ${returning.condition === "GOOD" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setReturning({ ...returning, condition: "GOOD" })}>Maayos — ibalik sa stock</button>
              <button type="button" className={`btn btn-lg ${returning.condition === "DAMAGED" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setReturning({ ...returning, condition: "DAMAGED" })}>Sira</button>
            </div>
            <label className="form-label d-block" htmlFor="rt-reason">Dahilan</label>
            <input id="rt-reason" className="form-control form-control-lg mb-3" value={returning.reason} onChange={(e) => setReturning({ ...returning, reason: e.target.value })} />
            <div className="d-flex justify-content-between">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setReturning(null)}>Bumalik</button>
              <button type="button" className="btn btn-success btn-lg" disabled={!returning.productId || !(Number(returning.qty) >= 1) || returning.reason.trim().length < 3} onClick={() => setReturning({ ...returning, signing: true })}>Susunod</button>
            </div>
          </div>
        </div>
      )}
      {returning && returning.signing && (
        <SignCapture
          sentence={`Ibinalik sa ${here?.name ?? ""}: ${returning.qty} × ${products.find((p) => p.id === returning.productId)?.name ?? ""} (${returning.condition === "GOOD" ? "maayos, balik sa stock" : "sira"}). Ipapaalam sa may-ari para sa bayad.`}
          staffName="ikaw (staff)"
          busy={busy}
          onCancel={() => setReturning({ ...returning, signing: false })}
          onDone={(sigs) => void submitReturn(sigs)}
        />
      )}

      {!step && !returning && (
        <>
          {loading ? <p className="text-muted">Loading…</p> : trips.length === 0 ? (
            <div className="text-center text-muted py-4">Walang naghihintay dito.</div>
          ) : (
            <div className="list-group mb-3">
              {trips.map((t) => {
                const [badge, word] = STATUS[t.status] ?? ["text-bg-secondary", t.status];
                return (
                  <div key={t.id} className="list-group-item py-3">
                    <div className="d-flex justify-content-between gap-2">
                      <div>
                        <div className="small text-muted">{t.docNumber ?? "—"} · {t.kind === "ORDER_RELEASE" ? `Benta${t.order ? ` ${t.order.orderNumber}` : ""}` : "Lipat"}</div>
                        <div className="fw-semibold">{t.quantity} × {t.product.name}</div>
                        <div className="small">{t.from.name} → {t.kind === "ORDER_RELEASE" ? `customer${t.customerName ? ` (${t.customerName})` : ""} ng ${t.to.name}` : t.to.name}{t.kargador ? ` · ${t.kargador.name}` : ""}</div>
                        {t.shortQty > 0 && <div className="small"><span className="badge text-bg-danger">Kulang {t.shortQty}</span></div>}
                      </div>
                      <span className={`badge align-self-start ${badge}`}>{word}</span>
                    </div>
                    <div className="mt-2">
                      {view === "ilabas" && <button className="btn btn-success btn-lg" onClick={() => open(t, "release")}>Ilabas</button>}
                      {view === "tanggapin" && <button className="btn btn-success btn-lg" onClick={() => open(t, "receive")}>Tanggapin</button>}
                      {view === "naihatid" && <button className="btn btn-success btn-lg" onClick={() => open(t, "deliver")}>Naihatid</button>}
                      {view === "pabalik" && <button className="btn btn-success btn-lg" onClick={() => open(t, "return")}>Tanggapin pabalik ({t.pendingReturn})</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <button type="button" className="btn btn-outline-dark btn-lg" disabled={!locationId} onClick={() => setReturning({ productId: "", qty: "1", condition: "GOOD", reason: "", signing: false })}>
            Ibinalik ng customer
          </button>
        </>
      )}
    </div>
  );
}

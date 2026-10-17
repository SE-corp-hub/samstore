"use client";

// Rice Ops M3 — Transfers & releases: every trip between locations, by step.
//   Release           — stock waiting to leave this location (count, pick porter, sign)
//   Receive           — restock on its way here (count what arrived, sign)
//   Delivered         — this store's sales served from another location (count delivered, sign)
//   Receive return    — refused / partial deliveries coming back here
//   Customer return   — a customer brings rice back after a sale
// Staff see their own location; owner/manager pick any. One question per screen,
// numbers in a big field, the sentence is read back before anyone signs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";
import { sendStep } from "../../lib/offlineQueue";
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
  { id: "ilabas", label: "Release" },
  { id: "tanggapin", label: "Receive" },
  { id: "naihatid", label: "Delivered" },
  { id: "pabalik", label: "Return" },
  { id: "all", label: "All" },
];
const STATUS: Record<string, [string, string]> = {
  REQUESTED: ["text-bg-warning", "Waiting for approval"],
  APPROVED: ["text-bg-warning", "Waiting to release"],
  IN_TRANSIT: ["text-bg-primary", "In transit"],
  RETURNING: ["text-bg-warning", "Returning"],
  COMPLETED: ["text-bg-success", "Done"],
  CANCELLED: ["text-bg-secondary", "Cancelled"],
};
const errText = (d: ApiBody | null, fallback: string) => d?.errors?.join(", ") ?? d?.message ?? fallback;

/** Rice Ops M10: a signed step goes through the phone's queue — with no signal it waits and is sent later (once). */
async function post(path: string, body: unknown, label = "Step") {
  const r = await sendStep(path, body, label);
  if (r.status === "queued") return { ok: true, queued: true, data: null as (ApiBody & Record<string, unknown>) | null };
  return { ok: r.ok, queued: false, data: r.data as (ApiBody & Record<string, unknown>) | null };
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
    })().catch(() => setError("Could not load the locations"));
  }, []);

  const load = useCallback(async () => {
    if (!locationId && view !== "all") return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ view, ...(locationId ? { locationId } : {}) });
      const res = await fetch(`${API_URL}/admin/trips?${q}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Could not load the transfers");
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
    const dala = k ? `, carried by ${k}` : "";
    switch (s.action) {
      case "release": return `Release: ${n} × ${s.trip.product.name} from ${s.trip.from.name}${dala}, for ${s.trip.kind === "ORDER_RELEASE" ? `customer (${s.trip.customerName ?? "customer"})` : s.trip.to.name}.`;
      case "receive": return `Receive at ${s.trip.to.name}: ${n} × ${s.trip.product.name} from ${s.trip.from.name}${dala}.`;
      case "deliver": return `Delivered to ${s.trip.customerName ?? "customer"}: ${n} × ${s.trip.product.name}${dala}.`;
      case "return": return `Returned to ${s.trip.from.name}: ${n} × ${s.trip.product.name}${dala}.`;
    }
  };

  const submit = async (s: Step, signatures: SignatureOut[]) => {
    setBusy(true);
    setError(null);
    const kargadorId = signatures.find((x) => x.signerKind === "KARGADOR")?.kargadorId ?? s.kargadorId;
    const body = { quantity: Number(s.qty), signatures, ...(s.action === "release" ? { kargadorId } : {}), ...(s.action === "deliver" ? { note: s.note } : {}) };
    const { ok, data, queued } = await post(`/admin/trips/${s.trip.id}/${s.action}`, body, `${s.trip.docNumber ?? "Trip"} ${s.action}`);
    setBusy(false);
    setStep(null);
    if (queued) { toast("No signal — saved on this phone, will be sent when the signal is back"); return; }
    if (!ok) { setError(errText(data, "Did not go through")); return; }
    const short = Number((data as Record<string, unknown>)?.shortQty ?? 0);
    const pending = Number((data as Record<string, unknown>)?.pendingReturn ?? 0);
    toast(s.action === "release" ? "Released" : s.action === "receive" ? (short ? `Received — short ${short}, the owner was told` : "Received")
      : s.action === "deliver" ? (pending ? `Delivered — ${pending} coming back` : "Delivered") : (short ? `Returned — short ${short}` : "Returned"));
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
    if (!ok) { setError(errText(data, "Did not go through")); return; }
    toast(`Return recorded (${String((data as Record<string, unknown>)?.docNumber ?? "")})`);
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
        <h1 className="h4 mb-0">Transfers &amp; releases</h1>
        {homeLocationId ? (
          <span className="badge text-bg-light border fs-6">{here?.name ?? ""}</span>
        ) : (
          <select className="form-select" style={{ maxWidth: 240 }} aria-label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} · ` : ""}{l.name}</option>)}
          </select>
        )}
      </div>

      <div className="btn-group w-100 mb-3" role="group" aria-label="Step">
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
              {step.action === "release" ? `How many to release? (asked for: ${step.trip.quantity})`
                : step.action === "receive" ? `How many arrived? (released: ${step.trip.releasedQty})`
                : step.action === "deliver" ? `How many were delivered? (released: ${step.trip.releasedQty})`
                : `How many came back? (expected: ${step.trip.pendingReturn})`}
            </label>
            <Stepper id="tp-qty" value={step.qty} onChange={(qty) => setStep({ ...step, qty })} />
            {!qtyOk(step) && step.qty !== "" && (() => {
              const cap = step.action === "release" ? step.trip.quantity : step.action === "return" ? step.trip.pendingReturn : step.trip.releasedQty ?? 0;
              return (
                <div className="alert alert-danger py-2" role="alert">
                  {step.action === "release" && Number(step.qty) < 1 ? "Release at least one." : `Only up to ${cap} — ${step.action === "release" ? "that is what was asked for" : step.action === "return" ? "that is what should come back" : "that is what was released"}. If there are really more, make a new transfer.`}
                </div>
              );
            })()}
            {needsNote(step) && (
              <div className="mb-3">
                <label className="form-label" htmlFor="tp-note">Why not all? (the rest will come back)</label>
                <input id="tp-note" className="form-control form-control-lg" value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} />
              </div>
            )}
            {step.action === "receive" && Number(step.qty) < (step.trip.releasedQty ?? 0) && qtyOk(step) && (
              <div className="alert alert-warning py-2"><strong>Short</strong> by {(step.trip.releasedQty ?? 0) - Number(step.qty)} — this goes on the transfer and the owner will be told.</div>
            )}
            <div className="d-flex justify-content-between">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setStep(null)}>Back</button>
              <button type="button" className="btn btn-success btn-lg" disabled={!qtyOk(step) || (needsNote(step) && step.note.trim().length < 3)} onClick={() => setStep({ ...step, signing: true })}>Next</button>
            </div>
          </div>
        </div>
      )}
      {step && step.signing && (
        <SignCapture
          sentence={sentence(step)}
          staffName="you (staff)"
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
            <h2 className="h5">Returned by a customer — at {here?.name}</h2>
            <label className="form-label" htmlFor="rt-product">Which rice?</label>
            <select id="rt-product" className="form-select form-select-lg mb-2" value={returning.productId} onChange={(e) => setReturning({ ...returning, productId: e.target.value })}>
              <option value="">Choose…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label className="form-label" htmlFor="rt-qty">How many?</label>
            <Stepper id="rt-qty" value={returning.qty} onChange={(qty) => setReturning({ ...returning, qty })} />
            <div className="btn-group mb-2" role="group" aria-label="Condition">
              <button type="button" className={`btn btn-lg ${returning.condition === "GOOD" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setReturning({ ...returning, condition: "GOOD" })}>Good — back to stock</button>
              <button type="button" className={`btn btn-lg ${returning.condition === "DAMAGED" ? "btn-dark" : "btn-outline-dark"}`} onClick={() => setReturning({ ...returning, condition: "DAMAGED" })}>Damaged</button>
            </div>
            <label className="form-label d-block" htmlFor="rt-reason">Reason</label>
            <input id="rt-reason" className="form-control form-control-lg mb-3" value={returning.reason} onChange={(e) => setReturning({ ...returning, reason: e.target.value })} />
            <div className="d-flex justify-content-between">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setReturning(null)}>Back</button>
              <button type="button" className="btn btn-success btn-lg" disabled={!returning.productId || !(Number(returning.qty) >= 1) || returning.reason.trim().length < 3} onClick={() => setReturning({ ...returning, signing: true })}>Next</button>
            </div>
          </div>
        </div>
      )}
      {returning && returning.signing && (
        <SignCapture
          sentence={`Returned to ${here?.name ?? ""}: ${returning.qty} × ${products.find((p) => p.id === returning.productId)?.name ?? ""} (${returning.condition === "GOOD" ? "good, back to stock" : "damaged"}). The owner will be told so the money can be settled.`}
          staffName="you (staff)"
          busy={busy}
          onCancel={() => setReturning({ ...returning, signing: false })}
          onDone={(sigs) => void submitReturn(sigs)}
        />
      )}

      {!step && !returning && (
        <>
          {loading ? <p className="text-muted">Loading…</p> : trips.length === 0 ? (
            <div className="text-center text-muted py-4">Nothing waiting here.</div>
          ) : (
            <div className="list-group mb-3">
              {trips.map((t) => {
                const [badge, word] = STATUS[t.status] ?? ["text-bg-secondary", t.status];
                return (
                  <div key={t.id} className="list-group-item py-3">
                    <div className="d-flex justify-content-between gap-2">
                      <div>
                        <div className="small text-muted">{t.docNumber ?? "—"} · {t.kind === "ORDER_RELEASE" ? `Sale${t.order ? ` ${t.order.orderNumber}` : ""}` : "Transfer"}</div>
                        <div className="fw-semibold">{t.quantity} × {t.product.name}</div>
                        <div className="small">{t.from.name} → {t.kind === "ORDER_RELEASE" ? `customer${t.customerName ? ` (${t.customerName})` : ""} of ${t.to.name}` : t.to.name}{t.kargador ? ` · ${t.kargador.name}` : ""}</div>
                        {t.shortQty > 0 && <div className="small"><span className="badge text-bg-danger">Short {t.shortQty}</span></div>}
                      </div>
                      <span className={`badge align-self-start ${badge}`}>{word}</span>
                    </div>
                    <div className="mt-2">
                      {view === "ilabas" && <button className="btn btn-success btn-lg" onClick={() => open(t, "release")}>Release</button>}
                      {view === "tanggapin" && <button className="btn btn-success btn-lg" onClick={() => open(t, "receive")}>Receive</button>}
                      {view === "naihatid" && <button className="btn btn-success btn-lg" onClick={() => open(t, "deliver")}>Delivered</button>}
                      {view === "pabalik" && <button className="btn btn-success btn-lg" onClick={() => open(t, "return")}>Receive return ({t.pendingReturn})</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <button type="button" className="btn btn-outline-dark btn-lg" disabled={!locationId} onClick={() => setReturning({ productId: "", qty: "1", condition: "GOOD", reason: "", signing: false })}>
            Returned by a customer
          </button>
        </>
      )}
    </div>
  );
}

/** Big − / + buttons around the count: sacks are counted, not typed. The number can still be typed. */
function Stepper({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const n = Number(value || "0");
  return (
    <div className="input-group input-group-lg mb-3" style={{ maxWidth: 280 }}>
      <button type="button" className="btn btn-outline-dark" style={{ minWidth: 64, fontSize: 28 }} aria-label="One less" disabled={n <= 0} onClick={() => onChange(String(Math.max(0, n - 1)))}>−</button>
      <input id={id} className="form-control text-center" style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }} inputMode="numeric"
        value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 5))} />
      <button type="button" className="btn btn-outline-dark" style={{ minWidth: 64, fontSize: 28 }} aria-label="One more" onClick={() => onChange(String(n + 1))}>+</button>
    </div>
  );
}

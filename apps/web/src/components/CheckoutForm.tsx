"use client";

import { useEffect, useState } from "react";
import type { CheckoutResponse, PublicStoreDTO } from "../types";
import {
  fetchRegions,
  fetchProvinces,
  fetchCities,
  fetchBarangays,
  type PhRegionOption,
  type PhProvinceOption,
  type PhCityOption,
  type PhBarangayOption,
} from "../api/address";

interface CheckoutFormProps {
  cartToken: string;
  store: PublicStoreDTO;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  onSuccess: (r: CheckoutResponse) => void;
  onClose: () => void;
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

const EMPTY_PH = { code: "", name: "" };

const SAVED_ADDRESS_USE_KEY = "samstore.savedAddress";

interface SavedAddressPreset {
  addressLine1?: string | null;
  addressLine2?: string | null;
  landmark?: string | null;
  regionCode?: string | null;
  provinceCode?: string | null;
  cityCode?: string | null;
  barangayCode?: string | null;
}

function readSavedAddressPreset(): SavedAddressPreset | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SAVED_ADDRESS_USE_KEY);
    return raw ? (JSON.parse(raw) as SavedAddressPreset) : null;
  } catch {
    return null;
  }
}

export default function CheckoutForm({ cartToken, store, subtotalMinor, deliveryFeeMinor, onSuccess, onClose }: CheckoutFormProps) {
  const customerToken = typeof window !== "undefined" ? localStorage.getItem("samstore.customer.token") : null;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState(() => {
    let saved: { name?: string; phone?: string } = {};
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem("samstore.lastContact");
        if (raw) saved = JSON.parse(raw);
      } catch { /* ignore */ }
    }
    return {
      customerName: saved.name ?? "",
      customerPhone: saved.phone ?? "",
      deliveryAddressLine1: "",
      deliveryAddressLine2: "",
      landmark: "",
      deliverySchedule: "",
      notes: "",
      voucherCode: "",
      loyaltyPoints: "",
    };
  });
  const [deliveryType, setDeliveryType] = useState<"delivery" | "pickup">(store.deliveryEnabled ? "delivery" : "pickup");
  const [paymentMethod, setPaymentMethod] = useState<"cod" | "credit">("cod");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P3b: statutory 20% discount (Senior Citizen / PWD) + DPA consent
  const [statutory, setStatutory] = useState<{ type: "" | "senior" | "pwd"; id: string; name: string }>({ type: "", id: "", name: "" });
  const [consentGranted, setConsentGranted] = useState(false);

  // P1: PH address cascade
  const [regions, setRegions] = useState<PhRegionOption[]>([]);
  const [provinces, setProvinces] = useState<PhProvinceOption[]>([]);
  const [cities, setCities] = useState<PhCityOption[]>([]);
  const [barangays, setBarangays] = useState<PhBarangayOption[]>([]);
  const [region, setRegion] = useState<{ code: string; name: string }>(EMPTY_PH);
  const [province, setProvince] = useState<{ code: string; name: string }>(EMPTY_PH);
  const [city, setCity] = useState<{ code: string; name: string }>(EMPTY_PH);
  const [barangay, setBarangay] = useState<{ code: string; name: string }>(EMPTY_PH);
  const [addrLoading, setAddrLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    if (deliveryType === "delivery" && regions.length === 0) {
      fetchRegions().then((r) => {
        if (alive) setRegions(r);
      });
    }
    return () => {
      alive = false;
    };
  }, [deliveryType, regions.length]);

  // Prefill from a saved address chosen in the Account book ("use at checkout").
  const [preset, setPreset] = useState<SavedAddressPreset | null>(() => readSavedAddressPreset());
  const [prefillDone, setPrefillDone] = useState(false);

  useEffect(() => {
    void setPreset;
    if (!preset || prefillDone || deliveryType !== "delivery") return;
    if (regions.length === 0) return;
    const region = regions.find((r) => r.code === preset.regionCode);
    if (!region) { setPrefillDone(true); return; } // preset no longer resolves — ignore silently
    setRegion({ code: region.code, name: region.name });
    void (async () => {
      const ps = await fetchProvinces(region.code);
      setProvinces(ps);
      const prov = preset.provinceCode ? ps.find((x) => x.code === preset.provinceCode) : null;
      if (!prov) { setPrefillDone(true); return; }
      setProvince({ code: prov.code, name: prov.name });
      const cs = await fetchCities(prov.code);
      setCities(cs);
      const city = preset.cityCode ? cs.find((x) => x.code === preset.cityCode) : null;
      if (!city) { setPrefillDone(true); return; }
      setCity({ code: city.code, name: city.name });
      const bs = await fetchBarangays(city.code);
      setBarangays(bs);
      const brgy = preset.barangayCode ? bs.find((x) => x.code === preset.barangayCode) : null;
      if (!brgy) { setPrefillDone(true); return; }
      setBarangay({ code: brgy.code, name: brgy.name });
      if (preset.addressLine1 || preset.addressLine2 || preset.landmark) {
        setForm((f) => ({
          ...f,
          deliveryAddressLine1: f.deliveryAddressLine1 || preset.addressLine1 || "",
          deliveryAddressLine2: preset.addressLine2 ?? "",
          landmark: preset.landmark ?? "",
        }));
      }
      setPrefillDone(true);
    })();
  }, [regions, preset, prefillDone, deliveryType]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const resetPane = () => {
    setProvince(EMPTY_PH);
    setCity(EMPTY_PH);
    setBarangay(EMPTY_PH);
    setProvinces([]);
    setCities([]);
    setBarangays([]);
  };

  const onRegionSelect = async (code: string) => {
    const chosen = regions.find((r) => r.code === code);
    setRegion(chosen ? { code, name: chosen.name } : EMPTY_PH);
    resetPane();
    if (!code) return;
    setAddrLoading(true);
    const ps = await fetchProvinces(code);
    setProvinces(ps);
    setAddrLoading(false);
  };

  const onProvinceSelect = async (code: string) => {
    const chosen = provinces.find((p) => p.code === code);
    setProvince(chosen ? { code, name: chosen.name } : EMPTY_PH);
    setCity(EMPTY_PH);
    setBarangay(EMPTY_PH);
    setCities([]);
    setBarangays([]);
    if (!code) return;
    setAddrLoading(true);
    const cs = await fetchCities(code);
    setCities(cs);
    setAddrLoading(false);
  };

  const onCitySelect = async (code: string) => {
    const chosen = cities.find((c) => c.code === code);
    setCity(chosen ? { code, name: chosen.name } : EMPTY_PH);
    setBarangay(EMPTY_PH);
    setBarangays([]);
    if (!code) return;
    setAddrLoading(true);
    const bs = await fetchBarangays(code);
    setBarangays(bs);
    setAddrLoading(false);
  };

  const onBarangaySelect = (code: string) => {
    const chosen = barangays.find((b) => b.code === code);
    setBarangay(chosen ? { code, name: chosen.name } : EMPTY_PH);
  };

  const delivery = deliveryType === "delivery";
  const addressComplete = !delivery || (!!region.code && !!province.code && !!city.code && !!barangay.code);
  const fee = delivery ? deliveryFeeMinor : 0;
  const total = subtotalMinor + fee;
  const canPickup = store.pickupEnabled;
  const canCredit = !!customerToken;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `ck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          deliveryAddressLine1: delivery ? form.deliveryAddressLine1 : undefined,
          regionCode: delivery ? region.code || undefined : undefined,
          provinceCode: delivery ? province.code || undefined : undefined,
          cityCode: delivery ? city.code || undefined : undefined,
          barangayCode: delivery ? barangay.code || undefined : undefined,
          cartToken,
          deliveryType,
          paymentMethod,
          idempotencyKey,
          voucherCode: form.voucherCode.trim() || undefined,
          customerToken: customerToken ?? undefined,
          loyaltyPoints: form.loyaltyPoints ? parseInt(form.loyaltyPoints, 10) : undefined,
          consentGranted,
          ...(statutory.type ? { statutoryType: statutory.type, statutoryId: statutory.id, statutoryName: statutory.name } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errors = (data?.errors as string[]) ?? [data?.message ?? "Checkout failed"];
        setError(Array.isArray(errors) ? errors.join(" · ") : String(errors));
        if (step === 3) setStep(2);
        return;
      }
      try {
        localStorage.setItem("samstore.lastContact", JSON.stringify({ name: form.customerName, phone: form.customerPhone }));
      } catch { /* ignore */ }
      onSuccess(data as CheckoutResponse);
    } catch {
      setError("Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  };

  const fullAddressLine = [
    form.deliveryAddressLine1,
    form.deliveryAddressLine2,
    barangay.name,
    city.name,
    province.name,
    region.name,
  ]
    .filter((x) => x && x.trim())
    .join(", ");

  const steps = [
    { n: 1, label: "Contact" },
    { n: 2, label: "Review" },
    { n: 3, label: "Pay" },
  ];

  const selectClassName = "form-select small";

  return (
    <div className="checkout-form">
      {/* Progress */}
      <ol className="nav nav-pills justify-content-center gap-2 mb-4">
        {steps.map((s) => (
          <li key={s.n} className="nav-item">
            <span className={`nav-link small px-3 ${step >= s.n ? "active bg-primary" : "disabled text-muted"}`}>
              {s.n}. {s.label}
            </span>
          </li>
        ))}
      </ol>
      <h5 className="mb-3">Checkout</h5>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {step === 1 && (
        <div>
          <h6 className="small fw-bold mb-2">Delivery or pickup</h6>
          <div className="d-flex gap-2 mb-3">
            {store.deliveryEnabled && (
              <button type="button" className={`btn ${delivery ? "btn-primary" : "btn-outline-primary"} flex-fill`} onClick={() => setDeliveryType("delivery")}>
                <i className="bi bi-truck me-1"></i>Delivery{store.deliveryFeeMinor > 0 ? ` · ${toPesos(store.deliveryFeeMinor)}` : ""}
              </button>
            )}
            {canPickup && (
              <button type="button" className={`btn ${!delivery ? "btn-primary" : "btn-outline-primary"} flex-fill`} onClick={() => setDeliveryType("pickup")}>
                <i className="bi bi-shop me-1"></i>Pickup
              </button>
            )}
          </div>

          <div className="mb-2">
            <label className="form-label small">Full name *</label>
            <input className="form-control" value={form.customerName} onChange={set("customerName")} required minLength={2} />
          </div>
          <div className="mb-2">
            <label className="form-label small">Phone *</label>
            <input className="form-control" value={form.customerPhone} onChange={set("customerPhone")} required placeholder="+63..." />
          </div>

          {delivery ? (
            <>
              <div className="mb-2">
                <label className="form-label small" htmlFor="checkoutRegion">Region *</label>
                <select
                  id="checkoutRegion"
                  className={selectClassName}
                  value={region.code}
                  onChange={(e) => onRegionSelect(e.target.value)}
                  disabled={addrLoading}
                >
                  <option value="">{addrLoading ? "Loading…" : "Select region"}</option>
                  {regions.map((r) => (
                    <option key={r.code} value={r.code}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div className="mb-2">
                <label className="form-label small" htmlFor="checkoutProvince">Province *</label>
                <select
                  id="checkoutProvince"
                  className={selectClassName}
                  value={province.code}
                  onChange={(e) => onProvinceSelect(e.target.value)}
                  disabled={!region.code || addrLoading}
                >
                  <option value="">{!region.code ? "Select a region first" : addrLoading ? "Loading…" : "Select province"}</option>
                  {provinces.map((p) => (
                    <option key={p.code} value={p.code}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="mb-2">
                <label className="form-label small" htmlFor="checkoutCity">City / Municipality *</label>
                <select
                  id="checkoutCity"
                  className={selectClassName}
                  value={city.code}
                  onChange={(e) => onCitySelect(e.target.value)}
                  disabled={!province.code || addrLoading}
                >
                  <option value="">{!province.code ? "Select a province first" : addrLoading ? "Loading…" : "Select city / municipality"}</option>
                  {cities.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}{c.type === "municipality" ? " (Municipality)" : ""}</option>
                  ))}
                </select>
              </div>
              <div className="mb-2">
                <label className="form-label small" htmlFor="checkoutBarangay">Barangay *</label>
                <select
                  id="checkoutBarangay"
                  className={selectClassName}
                  value={barangay.code}
                  onChange={(e) => onBarangaySelect(e.target.value)}
                  disabled={!city.code || addrLoading}
                >
                  <option value="">{!city.code ? "Select a city / municipality first" : addrLoading ? "Loading…" : "Select barangay"}</option>
                  {barangays.map((b) => (
                    <option key={b.code} value={b.code}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div className="mb-2">
                <label className="form-label small">Street / House no. *</label>
                <input className="form-control" value={form.deliveryAddressLine1} onChange={set("deliveryAddressLine1")} required minLength={5} placeholder="e.g. 123 Mabini St." />
              </div>
              <div className="mb-2">
                <label className="form-label small">Building / Unit (optional)</label>
                <input className="form-control" value={form.deliveryAddressLine2} onChange={set("deliveryAddressLine2")} placeholder="e.g. Unit 5, Blk 2" />
              </div>
              <div className="mb-2">
                <label className="form-label small">Landmark</label>
                <input className="form-control" value={form.landmark} onChange={set("landmark")} />
              </div>
              <div className="mb-2">
                <label className="form-label small">Delivery schedule</label>
                <input className="form-control" value={form.deliverySchedule} onChange={set("deliverySchedule")} placeholder="e.g. Today 5-8pm" />
              </div>
            </>
          ) : (
            <div className="alert alert-light border small"><i className="bi bi-shop me-1"></i>Pickup order — we&apos;ll prep and have it ready for pickup.</div>
          )}
          <div className="mb-3">
            <label className="form-label small">Notes</label>
            <input className="form-control" value={form.notes} onChange={set("notes")} />
          </div>

          {/* P3b: statutory 20% discount (Senior Citizen / PWD) */}
          <div className="border rounded p-2 mb-3">
            <div className="small fw-semibold mb-1">Statutory discount (20%)</div>
            <div className="d-flex gap-2 mb-1">
              <button type="button" className={`btn btn-sm ${statutory.type === "senior" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setStatutory({ type: statutory.type === "senior" ? "" : "senior", id: "", name: "" })}>Senior Citizen</button>
              <button type="button" className={`btn btn-sm ${statutory.type === "pwd" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => setStatutory({ type: statutory.type === "pwd" ? "" : "pwd", id: "", name: "" })}>PWD</button>
            </div>
            {statutory.type && (
              <div className="row g-1">
                <div className="col-5">
                  <input className="form-control form-control-sm" placeholder="ID number" value={statutory.id} onChange={(e) => setStatutory({ ...statutory, id: e.target.value })} />
                </div>
                <div className="col-7">
                  <input className="form-control form-control-sm" placeholder="Name on card" value={statutory.name} onChange={(e) => setStatutory({ ...statutory, name: e.target.value })} />
                </div>
                <small className="text-muted mt-1">20% off your subtotal — we&apos;ll verify your ID at {delivery ? "delivery" : "pickup"}.</small>
              </div>
            )}
          </div>

          <div className="d-flex justify-content-between">
            <button type="button" className="btn btn-outline-secondary" onClick={onClose}>Back to cart</button>
            <button type="button" className="btn btn-primary" disabled={!form.customerName.trim() || !form.customerPhone.trim() || (delivery && (form.deliveryAddressLine1.trim().length < 5 || !addressComplete))}
              onClick={() => { setError(null); setStep(2); }}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <h6 className="small fw-bold mb-2">Payment</h6>
          <div className="d-grid gap-2 mb-3">
            <label className={`border rounded p-3 d-flex align-items-center gap-2 ${paymentMethod === "cod" ? "border-primary bg-light" : ""}`} style={{ cursor: "pointer" }}>
              <input type="radio" name="pay" checked={paymentMethod === "cod"} onChange={() => setPaymentMethod("cod")} />
              <span className="flex-grow-1">
                <span className="fw-semibold d-block"><i className="bi bi-cash me-1"></i>Cash on delivery</span>
                <small className="text-muted">Pay when {delivery ? "your order arrives" : "you pick up"}.</small>
              </span>
            </label>
            {canCredit && (
              <label className={`border rounded p-3 d-flex align-items-center gap-2 ${paymentMethod === "credit" ? "border-primary bg-light-subtle" : ""}`} style={{ cursor: "pointer" }}>
                <input type="radio" name="pay" checked={paymentMethod === "credit"} onChange={() => setPaymentMethod("credit")} />
                <span className="flex-grow-1">
                  <span className="fw-semibold d-block"><i className="bi bi-journal-text me-1"></i>Pay on credit</span>
                  <small className="text-muted">Available to approved customers within their limit.</small>
                </span>
              </label>
            )}
          </div>

          <div className="row g-2 mb-3">
            <div className="col-6">
              <label className="form-label small">Voucher code</label>
              <input className="form-control" value={form.voucherCode} onChange={set("voucherCode")} placeholder="SAM10 (optional)" />
            </div>
            <div className="col-6">
              <label className="form-label small">Loyalty points</label>
              <input className="form-control" type="number" min="0" step="100" value={form.loyaltyPoints} onChange={set("loyaltyPoints")} placeholder="100 pts = ₱1" />
            </div>
          </div>

          <div className="d-flex justify-content-between">
            <button type="button" className="btn btn-outline-secondary" onClick={() => setStep(1)}>Back</button>
            <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>Review order</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="card mb-3">
            <div className="card-body small">
              {delivery && (
                <div className="mb-1 d-flex justify-content-between"><span className="text-muted">Deliver to</span><span className="text-end">{fullAddressLine}</span></div>
              )}
              <div className="d-flex justify-content-between"><span className="text-muted">Subtotal</span><span>{toPesos(subtotalMinor)}</span></div>
              <div className="d-flex justify-content-between"><span className="text-muted">{delivery ? "Delivery" : "Pickup"}</span>
                <span>{delivery ? toPesos(fee) : "Free — self pickup"}</span></div>
              {form.voucherCode.trim() && <div className="d-flex justify-content-between text-success"><span>Voucher {form.voucherCode.toUpperCase()}</span><span>applies at checkout</span></div>}
              {statutory.type && <div className="d-flex justify-content-between text-success"><span>Statutory discount ({statutory.type === "senior" ? "Senior" : "PWD"})</span><span>20% applies at checkout</span></div>}
              <hr className="my-2" />
              <div className="d-flex justify-content-between fw-bold"><span>Total</span><span>{toPesos(total)}</span></div>
              <div className="text-muted mt-1"><i className="bi bi-cash me-1"></i>{paymentMethod === "cod" ? "Cash on delivery" : "Pay on credit"}</div>
            </div>
          </div>

          {/* P3b: DPA consent gate */}
          <div className="form-check mb-2">
            <input className="form-check-input" type="checkbox" id="dpconsent" checked={consentGranted} onChange={(e) => setConsentGranted(e.target.checked)} />
            <label className="form-check-label small" htmlFor="dpconsent">I agree to the processing of my personal data for order fulfilment &amp; updates, per the Data Privacy Act (R.A. 10173).</label>
          </div>

          <div className="d-flex justify-content-between">
            <button type="button" className="btn btn-outline-secondary" onClick={() => setStep(2)}>Back</button>
            <button className="btn btn-success" type="button" disabled={submitting || !consentGranted} onClick={submit}>
              {submitting ? "Placing order…" : `Place order · ${toPesos(total)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

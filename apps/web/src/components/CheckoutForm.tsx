"use client";

import { useState } from "react";
import type { CheckoutResponse, PublicStoreDTO } from "../types";

interface CheckoutFormProps {
  cartToken: string;
  store: PublicStoreDTO;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  onSuccess: (r: CheckoutResponse) => void;
  onClose: () => void;
}

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

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

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const delivery = deliveryType === "delivery";
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
          cartToken,
          deliveryType,
          paymentMethod,
          idempotencyKey,
          voucherCode: form.voucherCode.trim() || undefined,
          customerToken: customerToken ?? undefined,
          loyaltyPoints: form.loyaltyPoints ? parseInt(form.loyaltyPoints, 10) : undefined,
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

  const steps = [
    { n: 1, label: "Contact" },
    { n: 2, label: "Review" },
    { n: 3, label: "Pay" },
  ];

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
                <label className="form-label small">Address line 1 *</label>
                <input className="form-control" value={form.deliveryAddressLine1} onChange={set("deliveryAddressLine1")} required minLength={5} placeholder="House no. & street" />
              </div>
              <div className="mb-2">
                <label className="form-label small">Address line 2</label>
                <input className="form-control" value={form.deliveryAddressLine2} onChange={set("deliveryAddressLine2")} placeholder="Barangay / city" />
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

          <div className="d-flex justify-content-between">
            <button type="button" className="btn btn-outline-secondary" onClick={onClose}>Back to cart</button>
            <button type="button" className="btn btn-primary" disabled={!form.customerName.trim() || !form.customerPhone.trim() || (delivery && form.deliveryAddressLine1.trim().length < 5)}
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
                  <span className="fw-semibold d-block"><i className="bi bi-journal-text me-1"></i>Pay on credit (utang)</span>
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
              <div className="d-flex justify-content-between"><span className="text-muted">Subtotal</span><span>{toPesos(subtotalMinor)}</span></div>
              <div className="d-flex justify-content-between"><span className="text-muted">{delivery ? "Delivery" : "Pickup"}</span>
                <span>{delivery ? toPesos(fee) : "Free — self pickup"}</span></div>
              {form.voucherCode.trim() && <div className="d-flex justify-content-between text-success"><span>Voucher {form.voucherCode.toUpperCase()}</span><span>applies at checkout</span></div>}
              <hr className="my-2" />
              <div className="d-flex justify-content-between fw-bold"><span>Total</span><span>{toPesos(total)}</span></div>
              <div className="text-muted mt-1"><i className="bi bi-cash me-1"></i>{paymentMethod === "cod" ? "Cash on delivery" : "Pay on credit (utang)"}</div>
            </div>
          </div>

          <div className="d-flex justify-content-between">
            <button type="button" className="btn btn-outline-secondary" onClick={() => setStep(2)}>Back</button>
            <button className="btn btn-success" type="button" disabled={submitting} onClick={submit}>
              {submitting ? "Placing order…" : `Place order · ${toPesos(total)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
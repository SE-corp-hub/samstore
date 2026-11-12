"use client";

// Payment review: orders whose payment someone still has to check. Today that is a Facebook order the customer
// said they pay by GCash: it waits here until staff look at the GCash app and press "Money received". An order
// stays here even after delivery until that is pressed, so an unpaid GCash order is never forgotten.
// Self-contained modal; every write reloads the parent orders list.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { peso } from "../../lib/number-format";

interface QueueItem {
  id: string;
  orderNumber: string;
  totalMinor: number;
  customerName: string | null;
  paymentMethod: string;
  createdAt: string;
  status?: string;
  deliveryType?: string;
  source?: string;
  sourcePage?: string | null;
  externalRef?: string | null;
  customerPhone?: string | null;
  payment: { id: string; proofData: string | null; reference: string | null } | undefined;
}

const METHOD: Record<string, string> = { gcash: "GCash", bank_transfer: "Bank transfer", cod: "Cash on delivery" };
const waited = (iso: string): string => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

const toPesos = (m: number) => peso(m);

interface PaymentReviewProps {
  onClose: () => void;
  onChanged: () => void;
}

export default function PaymentReview({ onClose, onChanged }: PaymentReviewProps) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    void fetch(`${API_URL}/admin/payments/review-queue`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => setItems(d?.items ?? []))
      .catch(() => setErr("Couldn't load the review queue"));
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const review = async (orderId: string) => {
    setBusy(orderId);
    setErr(null);
    try {
      const res = await fetch(`${API_URL}/admin/orders/${orderId}/payments/review`, {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      const d = await res.json();
      if (!res.ok) { setErr(d?.message ?? "Could not save. Try again."); return; }
      onChanged();
      setItems((cur) => cur?.filter((i) => i.id !== orderId) ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="payrev-title">
      <div className="modal-dialog modal-dialog-scrollable modal-lg">
        <div className="modal-content">
          <div className="modal-header">
            <h2 className="modal-title h5" id="payrev-title"><i className="bi bi-phone me-2" aria-hidden="true"></i>Payments to check</h2>
            <button type="button" className="btn-close payrev-close" onClick={onClose} aria-label="Close"></button>
          </div>
          <div className="modal-body">
            <p className="mb-3">These customers said they paid by GCash. Open your GCash, look for the amount, then press <strong>Money received</strong>.</p>
            {err && <div className="alert alert-danger py-2" role="alert">{err}</div>}
            {items === null ? (
              <p className="text-muted" role="status">Loading…</p>
            ) : items.length === 0 ? (
              <p className="payrev-empty" role="status"><i className="bi bi-check-circle-fill me-2" aria-hidden="true"></i>Nothing to check. Every GCash order is confirmed.</p>
            ) : (
              <ul className="payrev-list">
                {items.map((i) => {
                  const given = i.status === "DELIVERED" || i.status === "COMPLETED";
                  return (
                    <li key={i.id} className={given ? "is-given" : ""}>
                      <div className="payrev-who">
                        <div className="fw-bold">{i.customerName ?? "Customer"}{i.customerPhone ? <span className="fw-normal"> · {i.customerPhone}</span> : null}</div>
                        <div className="text-muted">
                          {i.orderNumber}{i.source === "hub" ? ` · ${[i.sourcePage, i.externalRef].filter(Boolean).join(" ") || "Facebook"}` : ""} · {waited(i.createdAt)}
                        </div>
                        {given && <div className="payrev-warn"><i className="bi bi-exclamation-triangle-fill me-1" aria-hidden="true"></i>Already {i.deliveryType === "pickup" ? "picked up" : "delivered"}, payment not confirmed yet</div>}
                      </div>
                      <div className="payrev-amount">
                        <span className="payrev-total">{toPesos(i.totalMinor)}</span>
                        <span className="badge text-bg-primary">{METHOD[i.paymentMethod] ?? i.paymentMethod}</span>
                      </div>
                      <button type="button" className="btn btn-success fw-bold payrev-ok" disabled={busy === i.id} onClick={() => void review(i.id)}>
                        <i className="bi bi-check-lg me-1" aria-hidden="true"></i>{busy === i.id ? "Saving…" : "Money received"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-muted mt-3 mb-0">Money did not come in? Open the order and cancel it, or collect cash when you hand over the rice and then press Money received.</p>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline-dark" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

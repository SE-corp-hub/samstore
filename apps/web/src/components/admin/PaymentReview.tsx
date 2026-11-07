"use client";

// P4b: payment review queue — orders awaiting operator review of a bank-transfer
// proof (paymentStatus RECEIVED). Review confirms; a proof image can be uploaded
// first. Self-contained modal; every write reloads the parent orders list.

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
  payment: { id: string; proofData: string | null; reference: string | null } | undefined;
}

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
      if (!res.ok) { setErr(d?.message ?? "Review failed"); return; }
      onChanged();
      setItems((cur) => cur?.filter((i) => i.id !== orderId) ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy(null);
    }
  };

  const toDataUrl = async (file: File): Promise<string> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return `data:${file.type};base64,${btoa(binary)}`;
  };

  const uploadProof = async (orderId: string, file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setErr("Proof must be an image (PNG/JPEG)"); return; }
    if (file.size > 2 * 1024 * 1024) { setErr("Proof image must be ≤ 2 MB"); return; }
    setBusy(orderId);
    setErr(null);
    try {
      const proofDataUrl = await toDataUrl(file);
      const res = await fetch(`${API_URL}/admin/orders/${orderId}/payments/proof`, {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ proofDataUrl }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d?.errors?.join(", ") ?? d?.message ?? "Upload failed"); return; }
      onChanged();
      setItems((cur) => cur ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
      <div className="modal-dialog modal-dialog-scrollable modal-lg">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Payment review queue</h5>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close"></button>
          </div>
          <div className="modal-body">
            {err && <div className="alert alert-danger py-2 small">{err}</div>}
            {items === null ? (
              <div className="text-muted small">Loading…</div>
            ) : items.length === 0 ? (
              <p className="text-muted text-center py-3">No payments awaiting review.</p>
            ) : (
              <table className="table table-sm align-middle mb-0">
                <thead>
                  <tr><th>Order</th><th className="text-end">Total</th><th>Customer</th><th>Method</th><th className="text-end">Actions</th></tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="fw-semibold">{i.orderNumber}</td>
                      <td className="text-end">{toPesos(i.totalMinor)}</td>
                      <td className="small text-muted">{i.customerName ?? "—"}</td>
                      <td className="small text-muted">{i.paymentMethod}</td>
                      <td className="text-end">
                        <label className="btn btn-sm btn-outline-primary mb-0 me-1">
                          <i className="bi bi-upload me-1"></i>Proof
                          <input type="file" accept="image/png,image/jpeg" className="d-none" onChange={(e) => void uploadProof(i.id, e.target.files?.[0])} />
                        </label>
                        <button className="btn btn-sm btn-success" disabled={busy === i.id} onClick={() => void review(i.id)}>
                          {busy === i.id ? "…" : "Review"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <small className="text-muted d-block mt-2">
              Bank-transfer proofs: upload the image to move the order to <strong>Received</strong>, then <strong>Review</strong> to confirm the funds.
            </small>
          </div>
          <div className="modal-footer">
            <button className="btn btn-outline-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
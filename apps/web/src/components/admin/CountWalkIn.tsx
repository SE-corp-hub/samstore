"use client";

// "Missing = sold to walk-ins": the owner or manager records a posted count's shortages as one walk-in
// cash sale at this store's price. The cash joins the open drawer, so closing the drawer checks it.
// At a consignment store the count's charge is replaced by the sale's (the unit price is charged once).

import { useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { formatKg, pesoText } from "../../lib/count-view";

export interface WalkInInfo {
  open: { lineId: string; productId: string; name: string; loose: boolean; quantity: number; priceMinor: number; amountMinor: number }[];
  openMinor: number;
  drawerOpen: boolean;
  sales: { orderId: string; orderNumber: string; totalMinor: number; lines: number; inDrawer: boolean }[];
}

const qty = (loose: boolean, n: number) => (loose ? formatKg(n / 1000) : `${n} ×`);

export default function CountWalkIn({ countId, info, onDone }: { countId: string; info: WalkInInfo; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/benta/from-count/${countId}`, {
        method: "POST", headers: { ...adminHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ lineIds: info.open.map((l) => l.lineId) }),
      });
      const d = (await res.json().catch(() => null)) as { message?: string; errors?: string[] } | null;
      if (!res.ok) { setError(d?.errors?.join(", ") ?? d?.message ?? "Could not record the sale"); return; }
      setConfirm(false);
      onDone();
    } catch {
      setError("No internet. Try again when the tablet is online.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mb-3 border-primary-subtle" aria-labelledby="walkin-title">
      <div className="card-body">
        {info.sales.map((s) => (
          <div key={s.orderId} className="alert alert-success py-2 mb-2" role="status">
            <i className="bi bi-check-circle me-1" aria-hidden="true"></i>
            Recorded as walk-in sale <strong>{s.orderNumber}</strong> · {pesoText(s.totalMinor)}
            <div className="small">{s.inDrawer ? "The cash is in the drawer count." : "No drawer was open, so this cash was not checked in a drawer."}</div>
          </div>
        ))}
        {info.open.length > 0 && (
          <>
            <h3 id="walkin-title" className="h6 mb-1">Was the missing rice sold to walk-ins?</h3>
            <p className="small text-muted mb-2">If customers bought it without a receipt, record it as one cash sale at this store&apos;s price. The stock stays as counted.</p>
            <ul className="list-group mb-2" style={{ fontVariantNumeric: "tabular-nums" }}>
              {info.open.map((l) => (
                <li key={l.lineId} className="list-group-item d-flex justify-content-between gap-2">
                  <span>{qty(l.loose, l.quantity)} {l.name}<span className="text-muted small"> · {pesoText(l.priceMinor)}{l.loose ? "/kg" : ""}</span></span>
                  <span className="fw-semibold">{pesoText(l.amountMinor)}</span>
                </li>
              ))}
              <li className="list-group-item d-flex justify-content-between fw-bold"><span>Cash to find</span><span>{pesoText(info.openMinor)}</span></li>
            </ul>
            <p className="small mb-2">
              <i className={`bi ${info.drawerOpen ? "bi-cash-stack" : "bi-exclamation-triangle"} me-1`} aria-hidden="true"></i>
              {info.drawerOpen ? `${pesoText(info.openMinor)} is added to the open drawer, so the drawer count checks it.` : "No drawer is open here. The sale is saved, but the cash is not checked in a drawer."}
            </p>
            {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
            {!confirm ? (
              <button type="button" className="btn btn-primary btn-lg w-100" onClick={() => setConfirm(true)}>
                <i className="bi bi-receipt me-1" aria-hidden="true"></i>Record as walk-in sales · {pesoText(info.openMinor)}
              </button>
            ) : (
              <div className="d-flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary btn-lg flex-grow-1" onClick={record} disabled={busy} aria-busy={busy}>
                  {busy ? "Recording…" : `Yes, record ${pesoText(info.openMinor)} cash`}
                </button>
                <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

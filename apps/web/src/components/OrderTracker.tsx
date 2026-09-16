"use client";

import { useEffect, useRef, useState } from "react";
import type { CheckoutResponse } from "../types";

interface TrackerProps {
  /** Pass a claim token to auto-load (after checkout) or null to prompt for one. */
  initialToken?: string | null;
}

interface OrderView {
  orderNumber: string;
  status: string;
  currencyCode: string;
  totalMinor: number;
  customerName: string;
  deliverySchedule: string | null;
  createdAt: string;
  items: { productName: string; sku: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }[];
}

export default function OrderTracker({ initialToken = null }: TrackerProps) {
  const [token, setToken] = useState(initialToken ?? "");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const autoLoaded = useRef(false);

  // Auto-load once when embedded after checkout (e.g. success tracking card).
  useEffect(() => {
    if (initialToken && !autoLoaded.current) {
      autoLoaded.current = true;
      track();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const track = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!token.trim()) { setError("Paste your order link token"); return; }
    setLoading(true); setError(null); setOrder(null);
    try {
      const res = await fetch("/api/orders/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimToken: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.message ?? "Could not load order"); return; }
      setOrder(data);
    } catch { setError("Network error"); } finally { setLoading(false); }
  };

  const pesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

  if (order) {
    return (
      <div className="card shadow-sm mt-4">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <div>
              <h6 className="mb-0">Order {order.orderNumber}</h6>
              <small className="text-muted">Placed {new Date(order.createdAt).toLocaleString()}</small>
            </div>
            <span className="badge text-bg-success">{order.status}</span>
          </div>
          <ul className="list-group list-group-flush mb-3">
            {order.items.map((i, idx) => (
              <li key={idx} className="list-group-item px-0 d-flex justify-content-between">
                <span>{i.productName} × {i.quantity}</span>
                <span>{pesos(i.lineTotalMinor)}</span>
              </li>
            ))}
          </ul>
          <div className="d-flex justify-content-between fw-bold">
            <span>Total ({order.currencyCode})</span><span>{pesos(order.totalMinor)}</span>
          </div>
          {order.deliverySchedule && <small className="text-muted d-block mt-2">Delivery: {order.deliverySchedule}</small>}
          <button className="btn btn-sm btn-outline-secondary mt-3" onClick={() => { setOrder(null); setToken(""); }}>
            Track another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={track} className="mt-4">
      <div className="input-group">
        <input
          className="form-control"
          placeholder="Paste your order link token (e.g. orderId.signature)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn btn-outline-primary" type="submit" disabled={loading}>
          {loading ? "…" : "Track"}
        </button>
      </div>
      {error && <div className="alert alert-danger py-2 small mt-2 mb-0">{error}</div>}
    </form>
  );
}
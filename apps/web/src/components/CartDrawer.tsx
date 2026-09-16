"use client";

import { useState } from "react";
import type { ProductDTO } from "../types";

export interface CartLineUI {
  product: ProductDTO;
  quantity: number;
}

interface CartDrawerProps {
  open: boolean;
  onClose: () => void;
  lines: CartLineUI[];
  onUpdateQty: (productId: string, qty: number) => void;
  onCheckout: () => void;
  deliveryFeeMinor: number;
  minOrderMinor: number;
}

const toPesos = (minor: number) => `₱${(minor / 100).toFixed(2)}`;

export default function CartDrawer({
  open, onClose, lines, onUpdateQty, onCheckout, deliveryFeeMinor, minOrderMinor,
}: CartDrawerProps) {
  const subtotal = lines.reduce((s, l) => s + l.product.priceMinor * l.quantity, 0);
  const total = subtotal + (subtotal > 0 ? deliveryFeeMinor : 0);
  const belowMin = minOrderMinor > 0 && total < minOrderMinor;
  const [checkingOut, setCheckingOut] = useState(false);

  const handleCheckout = () => {
    setCheckingOut(true);
    onCheckout();
    setCheckingOut(false);
  };

  return (
    <>
      <div className={`offcanvas offcanvas-end cart-drawer ${open ? "show" : ""}`} tabIndex={-1} style={{ width: 380 }}>
        <div className="offcanvas-header border-bottom">
          <h5 className="offcanvas-title">Your Cart</h5>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close"></button>
        </div>
        <div className="offcanvas-body d-flex flex-column">
          {lines.length === 0 ? (
            <div className="text-center text-muted py-5">
              <i className="bi bi-cart3 fs-1 d-block mb-2"></i>
              Your cart is empty
            </div>
          ) : (
            <ul className="list-group list-group-flush">
              {lines.map((l) => (
                <li key={l.product.id} className="list-group-item px-0 d-flex gap-2 align-items-center">
                  <div className="flex-grow-1">
                    <div className="fw-semibold small">{l.product.name}</div>
                    <div className="text-muted small">{toPesos(l.product.priceMinor)} each</div>
                  </div>
                  <div className="input-group input-group-sm" style={{ width: 110 }}>
                    <button className="btn btn-outline-secondary" onClick={() => onUpdateQty(l.product.id, l.quantity - 1)}>
                      <i className="bi bi-dash"></i>
                    </button>
                    <input
                      className="form-control form-control-sm text-center"
                      value={l.quantity}
                      min={1}
                      readOnly
                    />
                    <button className="btn btn-outline-secondary" onClick={() => onUpdateQty(l.product.id, l.quantity + 1)}>
                      <i className="bi bi-plus"></i>
                    </button>
                  </div>
                  <div className="fw-semibold small" style={{ width: 70, textAlign: "right" }}>
                    {toPesos(l.product.priceMinor * l.quantity)}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-auto border-top pt-3">
            <div className="d-flex justify-content-between small text-muted">
              <span>Subtotal</span><span>{toPesos(subtotal)}</span>
            </div>
            <div className="d-flex justify-content-between small text-muted">
              <span>Delivery</span><span>{subtotal > 0 ? toPesos(deliveryFeeMinor) : "—"}</span>
            </div>
            <div className="d-flex justify-content-between fw-bold mb-3">
              <span>Total</span><span>{toPesos(total)}</span>
            </div>
            {belowMin && (
              <div className="alert alert-warning py-2 small">
                Minimum order is {toPesos(minOrderMinor)} (you&apos;re {toPesos(minOrderMinor - total)} short)
              </div>
            )}
            <button
              className="btn btn-primary w-100"
              disabled={lines.length === 0 || belowMin || checkingOut}
              onClick={handleCheckout}
            >
              Checkout · {toPesos(total)}
            </button>
          </div>
        </div>
      </div>
      {open && <div className="offcanvas-backdrop fade show" onClick={onClose}></div>}
    </>
  );
}
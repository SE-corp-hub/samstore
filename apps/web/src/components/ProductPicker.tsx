"use client";

import { useEffect, useState } from "react";
import type { ProductDTO, ProductVariantDTO } from "../types";

interface ProductPickerProps {
  product: ProductDTO;
  products?: ProductDTO[];
  onAdd: (product: ProductDTO, opts: { variantId?: string; addons?: { addonId: string; optionId: string }[] }) => void;
  onSwitch?: (product: ProductDTO) => void;
  onClose: () => void;
}

const toPesos = (minor: number) => `₱${(minor / 100).toFixed(2)}`;

export default function ProductPicker({ product, products, onAdd, onSwitch, onClose }: ProductPickerProps) {
  const hasVariants = product.variants.length > 0;
  const hasAddons = product.addons.length > 0;
  const [variantId, setVariantId] = useState<string>(product.variants[0]?.id ?? "");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  // P3d: related/upsell targets resolved to full products from the loaded catalog.
  const resolveLinks = (ids: { id: string }[]) =>
    (products ?? [])
      .filter((p) => ids.some((r) => r.id === p.id) && p.id !== product.id)
      .slice(0, 4);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const variant = product.variants.find((v) => v.id === variantId) ?? null;
  const basePrice = variant?.priceMinor ?? product.priceMinor;
  const addonTotal = hasAddons
    ? product.addons.reduce((sum, g) => {
        const optId = picks[g.id];
        const opt = optId ? g.options.find((o) => o.id === optId) : null;
        return sum + (opt?.priceMinor ?? 0);
      }, 0)
    : 0;
  const lineTotal = (basePrice + addonTotal) * qty;

  const missing = product.addons.filter((g) => g.required && !picks[g.id]);
  const unavailable = variant && variant.availableQuantity <= 0;

  const submit = () => {
    if (hasVariants && !variantId) { setErr("Please pick an option"); return; }
    if (missing.length > 0) { setErr(`Please choose: ${missing.map((g) => g.name).join(", ")}`); return; }
    if (unavailable) { setErr("This option is out of stock"); return; }
    const addons = hasAddons
      ? product.addons.filter((g) => picks[g.id]).map((g) => ({ addonId: g.id, optionId: picks[g.id]! }))
      : [];
    onAdd(product, { variantId: hasVariants ? variantId : undefined, addons: addons.length ? addons : undefined });
  };

  return (
    <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">{product.name}</h5>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close"></button>
          </div>
          <div className="modal-body">
            {product.description && <p className="text-muted small mb-2">{product.description}</p>}

            {hasVariants && (
              <div className="mb-2">
                <div className="small fw-semibold mb-1">Options</div>
                <div className="d-flex flex-wrap gap-2">
                  {product.variants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className={`btn btn-sm ${v.id === variantId ? "btn-primary" : "btn-outline-primary"}`}
                      disabled={v.availableQuantity <= 0}
                      onClick={() => { setVariantId(v.id); setErr(null); }}
                    >
                      {v.name} · {toPesos(v.priceMinor)}
                      {v.availableQuantity <= 0 ? " (sold out)" : ""}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {hasAddons && (
              <div className="mb-2">
                {product.addons.map((g) => (
                  <div key={g.id} className="mb-1">
                    <div className="small fw-semibold mb-1">
                      {g.name}{g.required ? " *" : ""}
                    </div>
                    <div className="d-flex flex-wrap gap-2">
                      {g.options.map((o) => {
                        const selected = picks[g.id] === o.id;
                        return (
                          <button
                            key={o.id}
                            type="button"
                            className={`btn btn-sm ${selected ? "btn-primary" : "btn-outline-primary"}`}
                            onClick={() => {
                              const next = { ...picks };
                              if (selected) delete next[g.id]; else next[g.id] = o.id;
                              setPicks(next);
                              setErr(null);
                            }}
                          >
                            {o.name}{o.priceMinor > 0 ? ` +${toPesos(o.priceMinor)}` : ""}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mb-2 d-flex align-items-center gap-2">
              <span className="small fw-semibold">Qty</span>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setQty(Math.max(1, qty - 1))}><i className="bi bi-dash"></i></button>
              <span className="fw-semibold">{qty}</span>
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setQty(qty + 1)}><i className="bi bi-plus"></i></button>
            </div>

            {err && <div className="alert alert-danger py-2 small mb-2">{err}</div>}
          </div>
          <div className="modal-footer">
            <div className="fw-bold">{toPesos(lineTotal)}</div>
            <button type="button" className="btn btn-outline-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={submit}>Add to cart</button>
          </div>

          {/* P3d: related ("You may also like") + upsell ("Upgrade") */}
          {(() => {
            const related = resolveLinks(product.related ?? []);
            const upsell = resolveLinks(product.upsell ?? []);
            if (related.length === 0 && upsell.length === 0) return null;
            return (
              <div className="modal-footer d-block text-start border-top">
                {related.length > 0 && (
                  <>
                    <div className="small fw-semibold mb-1"><i className="bi bi-arrow-repeat me-1"></i>You may also like</div>
                    {related.map((r) => (
                      <button key={r.id} type="button" className="btn btn-outline-primary btn-sm me-1" onClick={() => onSwitch?.(r)}>
                        {r.name} · {toPesos(r.priceMinor)}
                      </button>
                    ))}
                  </>
                )}
                {upsell.length > 0 && (
                  <>
                    <div className="small fw-semibold mb-1"><i className="bi bi-arrow-up-circle me-1"></i>Upgrade</div>
                    {upsell.map((r) => (
                      <button key={r.id} type="button" className="btn btn-outline-primary btn-sm me-1" onClick={() => onSwitch?.(r)}>
                        {r.name} · {toPesos(r.priceMinor)}
                      </button>
                    ))}
                  </>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
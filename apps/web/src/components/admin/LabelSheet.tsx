"use client";

// M3 — product label sheet: one 57 × 40 mm label per page on a 57 mm roll (operator decision:
// browser print CSS only, no ESC/POS bridge). Batch-printed from the Products panel.

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

interface LabelProduct {
  id: string;
  name: string;
  sku: string;
  priceMinor: number;
  barcode?: string | null;
  unit?: string | null;
}

export default function LabelSheet({
  productIds,
  onClose,
}: {
  productIds: string[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<LabelProduct[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [storeName, setStoreName] = useState("");
  const [copies, setCopies] = useState(1);
  const pesos = (m: number) => `₱${(m / 100).toFixed(2)}`;

  useEffect(() => {
    let alive = true;
    setError(null);
    fetch(`${API_URL}/admin/products`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load products"))))
      .then((d) => {
        if (!alive) return;
        const all: LabelProduct[] = d?.products ?? [];
        const wanted = all.filter((p) => productIds.includes(p.id));
        if (wanted.length === 0) setError("No products selected");
        setRows(wanted);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Load failed"));
    fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => { if (alive) setStoreName(d?.settings?.name ?? d?.name ?? ""); })
      .catch(() => {});
    return () => { alive = false; };
  }, [productIds]);

  const labels: LabelProduct[] = [];
  for (let c = 0; c < Math.max(1, Math.min(copies, 50)); c++) labels.push(...rows);

  return (
    <>
      <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="labelSheetTitle">
        <div className="modal-dialog modal-dialog-centered" style={{ maxWidth: 520 }}>
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title" id="labelSheetTitle"><i className="bi bi-tags me-1"></i>Print labels</h5>
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-danger py-2 small">{error}</div>}
              <div className="d-flex align-items-center gap-2 mb-2">
                <label className="form-label small mb-0" htmlFor="labelCopies">Copies per product</label>
                <input id="labelCopies" className="form-control form-control-sm" type="number" min="1" max="50" style={{ width: 90 }} value={copies} onChange={(e) => setCopies(Number.parseInt(e.target.value || "1", 10))} />
                <span className="small text-muted">{rows.length} product(s) · {labels.length} label(s) · 57 × 40 mm</span>
              </div>

              {rows.length > 0 && (
                <div className="label-sheet border rounded p-2" style={{ maxHeight: 320, overflow: "auto" }}>
                  {labels.map((p, idx) => (
                    <div key={`${p.id}-${idx}`} className="label-cell">
                      <div className="label-store">{storeName}</div>
                      <div className="label-name">{p.name}</div>
                      <div className="label-price">{pesos(p.priceMinor)}</div>
                      <div className="label-meta">{p.sku}{p.unit ? ` · ${p.unit}` : ""}</div>
                      {/* A real barcode lands with M5; the SKU is printed until then. */}
                      <div className="label-barcode">{p.barcode || p.sku}</div>
                    </div>
                  ))}
                </div>
              )}
              {rows.length === 0 && !error && <p className="text-muted small mb-0">Loading…</p>}
              <p className="small text-muted mt-2 mb-0">
                The browser print dialog defaults to a 57 mm roll: one label per page, cut after each.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onClose}>Close</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()} disabled={labels.length === 0}>
                <i className="bi bi-printer me-1"></i>Print
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" onClick={onClose}></div>
      <style>{`
        /* On screen: preview the 57 × 40 mm cell so the operator sees exactly what prints. */
        .label-sheet .label-cell {
          width: 57mm; height: 40mm; box-sizing: border-box; padding: 2mm;
          margin: 0 auto 2mm auto; border: 1px dashed #adb5bd; border-radius: 4px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          text-align: center; overflow: hidden; background: #fff; color: #000;
        }
        .label-cell .label-store { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
        .label-cell .label-name { font-size: 12px; font-weight: 700; line-height: 1.15; margin: 1mm 0; }
        .label-cell .label-price { font-size: 20px; font-weight: 800; }
        .label-cell .label-meta { font-size: 9px; margin-top: 1mm; }
        .label-cell .label-barcode { font-family: ui-monospace, "Courier New", monospace; font-size: 10px; margin-top: 1mm; }
        @media print {
          @page { size: 57mm 40mm; margin: 0; }
          body * { visibility: hidden; }
          .label-sheet, .label-sheet * { visibility: visible; }
          .label-sheet { position: absolute; left: 0; top: 0; width: 57mm; max-height: none; overflow: visible; border: 0 !important; padding: 0 !important; }
          .label-sheet .label-cell {
            border: 0; border-radius: 0; margin: 0; background: #fff;
            page-break-after: always; break-after: page;
          }
          .label-sheet .label-cell:last-child { page-break-after: auto; break-after: auto; }
        }
      `}</style>
    </>
  );
}

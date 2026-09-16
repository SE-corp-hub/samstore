"use client";

import { useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";

// Printable receipt view (browser print). VAT display-only label per decision #2.

interface ReceiptData {
  orderNumber: string;
  status: string;
  source: string;
  storeName: string;
  currencyCode: string;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  discountMinor: number;
  totalMinor: number;
  paymentMethod: string;
  paymentStatus: string;
  customerName: string;
  createdAt: string;
  signatureData?: string;
  signatureAt?: string;
  items: { productName: string; sku: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }[];
  payments: {
    id: string; method: string; methodLabel?: string; kind?: string;
    amountMinor: number; tenderedMinor?: number | null; changeMinor: number;
    reference?: string | null; type: string; note: string | null; receivedAt: string;
  }[];
  tenders?: { paidMinor: number; refundedMinor: number; changeMinor: number; outstandingMinor: number; settlement: "PAID" | "PARTIAL" | "UNPAID" };
  // M4: the frozen VAT breakdown + the owner's display preference for the slip.
  vat?: {
    enabled: boolean;
    rateBp: number;
    pricesIncludeVat: boolean;
    vatableMinor: number;
    vatMinor: number;
    vatExemptMinor: number;
    showOnReceipt: boolean;
    tin: string | null;
  };
}

function useReceipt(orderId: string) {
  const [data, setData] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ receiptHeader?: string | null; receiptFooter?: string | null; showVatLabel?: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => { if (alive) setSettings(d?.settings ?? null); })
      .catch(() => {});
    fetch(`${API_URL}/admin/orders/${orderId}/receipt`, { headers: adminHeaders() })
      .then((r) => r.json())
      .then((d) => { if (alive) { if (d?.orderNumber) setData(d); else setError(d?.message ?? "Load failed"); } })
      .catch(() => alive && setError("Network error"));
    return () => { alive = false; };
  }, [orderId]);
  return { data, error, settings };
}

export default function ReceiptModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { data, error, settings } = useReceipt(orderId);
  const pesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
  const showVat = settings?.showVatLabel ?? true;

  return (
    <>
      <div className="modal fade show d-block" tabIndex={-1}>
        <div className="modal-dialog modal-dialog-centered" style={{ maxWidth: 420 }}>
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title"><i className="bi bi-receipt me-1"></i>Receipt</h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-danger py-2 small">{error}</div>}
              {!data && !error && <p className="text-muted small">Loading…</p>}
              {data && (
                <div className="receipt-print">
                  {settings?.receiptHeader && (
                    <div className="text-center small text-muted mb-1">{settings.receiptHeader}</div>
                  )}
                  <div className="text-center mb-2">
                    <div className="fw-bold">{data.storeName}</div>
                    <div className="small text-muted">Order {data.orderNumber}</div>
                    <div className="small text-muted">{new Date(data.createdAt).toLocaleString()}</div>
                  </div>
                  <table className="table table-sm small mb-2">
                    <thead><tr><th>Item</th><th className="text-end">Qty</th><th className="text-end">Amount</th></tr></thead>
                    <tbody>
                      {data.items.map((i, idx) => (
                        <tr key={idx}>
                          <td>{i.productName}</td>
                          <td className="text-end">{i.quantity}</td>
                          <td className="text-end">{pesos(i.lineTotalMinor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="small">
                    <div className="d-flex justify-content-between"><span>Subtotal</span><span>{pesos(data.subtotalMinor)}</span></div>
                    {data.deliveryFeeMinor > 0 && (
                      <div className="d-flex justify-content-between"><span>Delivery</span><span>{pesos(data.deliveryFeeMinor)}</span></div>
                    )}
                    {data.discountMinor > 0 && (
                      <div className="d-flex justify-content-between text-danger"><span>Discount</span><span>-{pesos(data.discountMinor)}</span></div>
                    )}
                    <div className="d-flex justify-content-between fw-bold"><span>TOTAL</span><span>{pesos(data.totalMinor)}</span></div>
                    {/* M4: BIR-style VAT breakdown. `showOnReceipt` is display-only — flipping it
                        on the Settings page only hides these lines, it never changes a total. */}
                    {showVat && data.vat?.showOnReceipt && data.vat.enabled && (
                      <div className="mt-2" data-testid="vat-breakdown">
                        <hr className="my-2" />
                        <div className="d-flex justify-content-between">
                          <span>VATable Sales</span>
                          <span>{pesos(data.vat.vatableMinor)}</span>
                        </div>
                        <div className="d-flex justify-content-between">
                          <span>
                            VAT {data.vat.pricesIncludeVat ? "(incl.) " : ""}
                            {(data.vat.rateBp / 100).toFixed(data.vat.rateBp % 100 === 0 ? 0 : 2)}%
                          </span>
                          <span>{pesos(data.vat.vatMinor)}</span>
                        </div>
                        {data.vat.vatExemptMinor > 0 && (
                          <div className="d-flex justify-content-between">
                            <span>VAT-Exempt Sales</span>
                            <span>{pesos(data.vat.vatExemptMinor)}</span>
                          </div>
                        )}
                        <div className="d-flex justify-content-between">
                          <span>Zero-Rated Sales</span>
                          <span>{pesos(0)}</span>
                        </div>
                        {data.vat.tin && <div className="text-muted mt-1">TIN {data.vat.tin}</div>}
                        {data.vat.pricesIncludeVat && (
                          <div className="text-muted">Prices are VAT-inclusive (BIR)</div>
                        )}
                      </div>
                    )}
                    <hr className="my-2" />
                    {/* M3: what settled the order — one line per tender (label, handed-over, change, ref) */}
                    {data.tenders && (
                      <div className="d-flex justify-content-between">
                        <span>Status</span>
                        <span className="fw-semibold">
                          {data.tenders.settlement}
                          {data.tenders.outstandingMinor > 0 ? ` · ${pesos(data.tenders.outstandingMinor)} due` : ""}
                        </span>
                      </div>
                    )}
                    {data.payments.map((p) => (
                      <div key={p.id}>
                        {p.type === "refund" && <span className="text-danger">Refund </span>}
                        {p.type === "void" && <span className="text-warning">Void </span>}
                        {p.type !== "refund" && p.type !== "void" && (
                          <div className="d-flex justify-content-between">
                            <span>{p.methodLabel ?? p.method}</span>
                            <span>
                              {pesos(p.amountMinor)}
                              {p.tenderedMinor != null && p.tenderedMinor !== p.amountMinor && (
                                <span className="text-muted"> ({pesos(p.tenderedMinor)} handed)</span>
                              )}
                            </span>
                          </div>
                        )}
                        {p.type === "refund" && (
                          <div className="d-flex justify-content-between"><span className="text-danger">Refund</span><span className="text-danger">{pesos(p.amountMinor)}</span></div>
                        )}
                        {p.reference && <div className="text-muted" style={{ paddingLeft: "1em" }}>ref {p.reference}</div>}
                        {p.changeMinor > 0 && (
                          <div className="d-flex justify-content-between fw-semibold"><span>Change</span><span>{pesos(p.changeMinor)}</span></div>
                        )}
                        {p.note && <div className="text-muted small" style={{ paddingLeft: "1em" }}>{p.note}</div>}
                      </div>
                    ))}
                    {data.signatureData && (
                      <div className="text-center small text-muted mt-2">
                        <img src={data.signatureData} alt="Customer signature" style={{ maxWidth: "100%", maxHeight: 90 }} />
                        <div>Customer signature</div>
                      </div>
                    )}
                  </div>
                  {settings?.receiptFooter && (
                    <div className="text-center small text-muted mt-2">{settings.receiptFooter}</div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline-secondary btn-sm" onClick={onClose}>Close</button>
              <button className="btn btn-primary btn-sm" onClick={() => window.print()}>Print</button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" onClick={onClose}></div>
      <style>{`
        /* M3: 57 mm thermal roll. The receipt is the only visible node, top-left, monospace,
           and the page box is the roll width so the browser's print dialog defaults to it. */
        @media print {
          @page { size: 57mm auto; margin: 2mm; }
          body * { visibility: hidden; }
          .receipt-print, .receipt-print * { visibility: visible; }
          .receipt-print {
            position: absolute; left: 0; top: 0;
            width: 57mm; max-width: 57mm;
            font-family: ui-monospace, "Courier New", monospace;
            font-size: 11px; line-height: 1.3; color: #000;
          }
          .receipt-print table { width: 100%; font-size: 11px; margin-bottom: 2mm; }
          .receipt-print .table td, .receipt-print .table th { padding: 0 1mm; border: 0; }
          .receipt-print .text-muted { color: #333 !important; }
          .receipt-print hr { border: 0; border-top: 1px dashed #000; margin: 1.5mm 0; }
          .receipt-print img { max-width: 40mm; max-height: 20mm; }
        }
      `}</style>
    </>
  );
}
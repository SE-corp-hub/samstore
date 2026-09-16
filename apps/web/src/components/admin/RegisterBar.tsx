"use client";

// N1 — Cash drawer bar for the POS: shift status, open/close, cash in/out and X/Z report.
// Mounted at the top of the POS panel so a cashier always sees whether the drawer is open.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { toast } from "../../lib/toast";

const toPesos = (m: number) => `₱${(m / 100).toFixed(2)}`;
const toPesosInput = (m: number) => (m / 100).toFixed(2);

interface SessionTotals {
  openingFloatMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  cashRefundsMinor: number;
  cashSalesMinor: number;
  cashSalesCount: number;
  nonCashSalesMinor: number;
  ordersCount: number;
  salesTotalMinor: number;
  byMethod: { method: string; count: number; amountMinor: number }[];
  lastSaleAt: string | null;
  expectedMinor: number;
}

interface Session {
  sessionId: string;
  registerName: string;
  status: "OPEN" | "CLOSED";
  openedBy: string;
  openedAt: string;
  openingFloatMinor: number;
  closedBy: string | null;
  closedAt: string | null;
  countedMinor: number | null;
  expectedMinor: number | null;
  varianceMinor: number | null;
  notes: string | null;
  live: SessionTotals;
}

interface Report {
  kind: "x" | "z";
  session: Session;
  movements: { type: string; amountMinor: number; reason: string | null; createdBy: string; createdAt: string }[];
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function RegisterBar({ onShiftChange }: { onShiftChange?: (open: boolean) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [openModal, setOpenModal] = useState(false);
  const [floatInput, setFloatInput] = useState("");
  const [openNotes, setOpenNotes] = useState("");

  const [moveModal, setMoveModal] = useState<null | "CASH_IN" | "CASH_OUT">(null);
  const [moveAmount, setMoveAmount] = useState("");
  const [moveReason, setMoveReason] = useState("");

  const [closeModal, setCloseModal] = useState(false);
  const [countedInput, setCountedInput] = useState("");
  const [closeNotes, setCloseNotes] = useState("");

  const [report, setReport] = useState<Report | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/admin/registers/current`, { headers: adminHeaders() });
      const data = await res.json();
      const s: Session | null = data?.session ?? null;
      setSession(s);
      onShiftChange?.(Boolean(s));
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, [onShiftChange]);

  useEffect(() => { void load(); }, [load]);

  const post = async (path: string, body: unknown, okMsg: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast(data?.message ?? data?.errors?.join(" · ") ?? "Request failed", "danger");
        return null;
      }
      toast(okMsg, "success");
      await load();
      return data;
    } finally {
      setBusy(false);
    }
  };

  const moneyToMinor = (value: string) => {
    const n = Number(value.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };

  const countedMinor = moneyToMinor(countedInput);
  const variance = Number.isFinite(countedMinor) && session ? countedMinor - session.live.expectedMinor : null;

  if (loading) return null;

  return (
    <>
      <div className={`alert ${session ? "alert-success" : "alert-warning"} d-flex flex-wrap align-items-center gap-2 py-2 mb-3`} role="status">
        <i className={`bi ${session ? "bi-safe" : "bi-exclamation-triangle"} me-1`}></i>
        {session ? (
          <>
            <span className="fw-semibold">Shift open</span>
            <span className="small">since {fmtTime(session.openedAt)} · expected drawer <strong>{toPesos(session.live.expectedMinor)}</strong></span>
            <span className="badge text-bg-light ms-1">{session.live.cashSalesCount} cash sale{session.live.cashSalesCount === 1 ? "" : "s"}</span>
          </>
        ) : (
          <span className="fw-semibold">No shift open — cash sales are blocked until you open the drawer</span>
        )}
        <div className="ms-auto d-flex flex-wrap gap-2">
          {session ? (
            <>
              <button className="btn btn-sm btn-outline-primary" disabled={busy} onClick={() => { setMoveAmount(""); setMoveReason(""); setMoveModal("CASH_IN"); }}>Cash in</button>
              <button className="btn btn-sm btn-outline-secondary" disabled={busy} onClick={() => { setMoveAmount(""); setMoveReason(""); setMoveModal("CASH_OUT"); }}>Cash out</button>
              <button className="btn btn-sm btn-outline-dark" disabled={busy} onClick={async () => { const d = await fetch(`${API_URL}/admin/registers/report?kind=x`, { headers: adminHeaders() }).then((r) => r.json()); if (d?.report) setReport(d.report); }}>X-report</button>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => { setCountedInput(toPesosInput(session.live.expectedMinor)); setCloseNotes(""); setCloseModal(true); }}>Close shift</button>
            </>
          ) : (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => { setFloatInput(""); setOpenNotes(""); setOpenModal(true); }}>Open shift</button>
          )}
        </div>
      </div>

      {/* Open shift */}
      {openModal && (
        <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">Open shift</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setOpenModal(false)}></button>
              </div>
              <div className="modal-body">
                <label className="form-label small">Opening float (cash already in the drawer)</label>
                <div className="input-group mb-3">
                  <span className="input-group-text">₱</span>
                  <input className="form-control" inputMode="decimal" placeholder="0.00" value={floatInput} onChange={(e) => setFloatInput(e.target.value)} />
                </div>
                <label className="form-label small">Notes</label>
                <input className="form-control" value={openNotes} onChange={(e) => setOpenNotes(e.target.value)} />
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" onClick={() => setOpenModal(false)}>Cancel</button>
                <button
                  className="btn btn-primary"
                  disabled={busy || (floatInput !== "" && !Number.isFinite(moneyToMinor(floatInput)))}
                  onClick={async () => {
                    const r = await post("/admin/registers/open", { openingFloatMinor: floatInput === "" ? 0 : moneyToMinor(floatInput), ...(openNotes.trim() ? { notes: openNotes.trim() } : {}) }, "Shift opened");
                    if (r) setOpenModal(false);
                  }}
                >
                  Open shift
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cash in / out */}
      {moveModal && (
        <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">{moveModal === "CASH_IN" ? "Cash in" : "Cash out"}</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setMoveModal(null)}></button>
              </div>
              <div className="modal-body">
                <label className="form-label small">Amount</label>
                <div className="input-group mb-3">
                  <span className="input-group-text">₱</span>
                  <input className="form-control" inputMode="decimal" placeholder="0.00" value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} />
                </div>
                <label className="form-label small">Reason</label>
                <input className="form-control" placeholder={moveModal === "CASH_IN" ? "change fund top-up" : "bank drop"} value={moveReason} onChange={(e) => setMoveReason(e.target.value)} />
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" onClick={() => setMoveModal(null)}>Cancel</button>
                <button
                  className="btn btn-primary"
                  disabled={busy || !(moneyToMinor(moveAmount) > 0)}
                  onClick={async () => {
                    const r = await post("/admin/registers/movements", { type: moveModal, amountMinor: moneyToMinor(moveAmount), ...(moveReason.trim() ? { reason: moveReason.trim() } : {}) }, moveModal === "CASH_IN" ? "Cash added" : "Cash removed");
                    if (r) setMoveModal(null);
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Close shift */}
      {closeModal && session && (
        <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">Close shift</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setCloseModal(false)}></button>
              </div>
              <div className="modal-body">
                <div className="d-flex justify-content-between"><span className="text-muted">Expected in drawer</span><span className="fw-semibold">{toPesos(session.live.expectedMinor)}</span></div>
                <hr className="my-2" />
                <label className="form-label small">Counted cash</label>
                <div className="input-group mb-2">
                  <span className="input-group-text">₱</span>
                  <input className="form-control" inputMode="decimal" value={countedInput} onChange={(e) => setCountedInput(e.target.value)} />
                </div>
                {variance !== null && (
                  <div className={`small ${variance === 0 ? "text-success" : variance < 0 ? "text-danger" : "text-warning-emphasis"}`}>
                    Variance: {variance === 0 ? "balanced" : `${variance < 0 ? "short " : "over "}${toPesos(Math.abs(variance))}`}
                  </div>
                )}
                <label className="form-label small mt-3">Notes</label>
                <input className="form-control" value={closeNotes} onChange={(e) => setCloseNotes(e.target.value)} />
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" onClick={() => setCloseModal(false)}>Cancel</button>
                <button
                  className="btn btn-danger"
                  disabled={busy || !Number.isFinite(countedMinor)}
                  onClick={async () => {
                    const r = await post("/admin/registers/close", { countedMinor, ...(closeNotes.trim() ? { notes: closeNotes.trim() } : {}) }, "Shift closed");
                    if (r) {
                      setCloseModal(false);
                      const z = await fetch(`${API_URL}/admin/registers/report?kind=z&sessionId=${encodeURIComponent(r.session.sessionId)}`, { headers: adminHeaders() }).then((x) => x.json());
                      if (z?.report) setReport(z.report);
                    }
                  }}
                >
                  Close &amp; print Z-report
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* X / Z report */}
      {report && (
        <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">{report.kind === "z" ? "Z-report (shift close)" : "X-report (mid-shift)"}</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setReport(null)}></button>
              </div>
              <div className="modal-body">
                <div className="register-report">
                  <div className="text-center mb-2">
                    <div className="fw-bold">Cash drawer report</div>
                    <div className="small text-muted">{report.session.registerName} · {report.kind.toUpperCase()}-report</div>
                    <div className="small text-muted">Opened {fmtTime(report.session.openedAt)}{report.session.closedAt ? ` · Closed ${fmtTime(report.session.closedAt)}` : ""}</div>
                  </div>
                  <table className="table table-sm mb-2">
                    <tbody>
                      <tr><td>Opening float</td><td className="text-end">{toPesos(report.session.openingFloatMinor)}</td></tr>
                      <tr><td>Cash sales ({report.session.live.cashSalesCount})</td><td className="text-end">{toPesos(report.session.live.cashSalesMinor)}</td></tr>
                      <tr><td>Cash refunds</td><td className="text-end">−{toPesos(report.session.live.cashRefundsMinor)}</td></tr>
                      <tr><td>Cash in</td><td className="text-end">{toPesos(report.session.live.cashInMinor)}</td></tr>
                      <tr><td>Cash out</td><td className="text-end">−{toPesos(report.session.live.cashOutMinor)}</td></tr>
                      <tr className="fw-bold"><td>Expected in drawer</td><td className="text-end">{toPesos(report.session.expectedMinor ?? report.session.live.expectedMinor)}</td></tr>
                      {report.kind === "z" && (
                        <>
                          <tr><td>Counted</td><td className="text-end">{toPesos(report.session.countedMinor ?? 0)}</td></tr>
                          <tr className={report.session.varianceMinor === 0 ? "text-success" : "text-danger"}>
                            <td>Variance</td><td className="text-end">{toPesos(report.session.varianceMinor ?? 0)}</td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>
                  <div className="small text-muted mb-1">Tenders by method</div>
                  <table className="table table-sm">
                    <tbody>
                      {report.session.live.byMethod.map((m) => (
                        <tr key={m.method}><td className="text-capitalize">{m.method} × {m.count}</td><td className="text-end">{toPesos(m.amountMinor)}</td></tr>
                      ))}
                      {report.session.live.byMethod.length === 0 && <tr><td className="text-muted">No tenders recorded</td><td></td></tr>}
                    </tbody>
                  </table>
                  {report.movements.length > 0 && (
                    <>
                      <div className="small text-muted mb-1">Cash movements</div>
                      <table className="table table-sm">
                        <tbody>
                          {report.movements.map((m, i) => (
                            <tr key={i}>
                              <td>{m.type}{m.reason ? ` · ${m.reason}` : ""}</td>
                              <td className="text-end">{toPesos(m.amountMinor)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  <div className="small text-center text-muted">Orders in shift: {report.session.live.ordersCount} · sales {toPesos(report.session.live.salesTotalMinor)}</div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-outline-secondary" onClick={() => setReport(null)}>Close</button>
                <button className="btn btn-primary" onClick={() => window.print()}><i className="bi bi-printer me-1"></i>Print</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
"use client";

// "Close the store": one path at closing time for a store that does not ring up its walk-in customers.
//   1 Count   every rice at the store (− / + for sacks, kilos for loose rice)
//   2 Check   the differences; one tap marks every shortage "Sold but not rung up"
//   3 Walk-ins  the shortages sold to walk-ins become one cash sale at the store's price
//   4 Cash    the cash from today's sales here (plus those walk-ins) against the cash counted; the
//             person signs and the day closes (the same closing record as Reports, Closing & stock)
//   5 Done    a short summary and a slip to print
// Steps 1 and 2 are the count sheet and the check (BilanginPanel / CountCheck); this file holds the
// step bar and steps 3-5, which work on a posted count. Nothing here moves stock twice: the walk-in
// sale is the existing "missing = sold to walk-ins" sale, and the cash step moves no stock or money.

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { formatKg, pesoText } from "../../lib/count-view";
import { peso, pesosToMinor, cleanTyping } from "../../lib/number-format";
import { getPrinterSettings } from "../../lib/printer-settings";
import { printSlip } from "../../lib/slip-print";
import { toast } from "../../lib/toast";
import CountReport from "./CountReport";
import CountWalkIn, { type WalkInInfo } from "./CountWalkIn";
import SignaturePad from "./SignaturePad";

export const CLOSE_STEPS = ["Count", "Check", "Walk-ins", "Cash", "Done"] as const;
export type CloseStep = (typeof CLOSE_STEPS)[number];

/** Where the closing is: the steps before are ticked, this one is filled. */
export function CloseSteps({ step }: { step: CloseStep }) {
  const at = CLOSE_STEPS.indexOf(step);
  return (
    <ol className="close-steps" aria-label="Close the store, steps">
      {CLOSE_STEPS.map((s, i) => (
        <li key={s} className={i < at ? "done" : undefined} aria-current={i === at ? "step" : undefined}>
          <span className="n" aria-hidden="true">{i < at ? <i className="bi bi-check-lg"></i> : i + 1}</span>
          {s}
          {i < at && <span className="visually-hidden"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}

type ApiBody = { message?: string; errors?: string[] } & Record<string, unknown>;
const errText = (d: ApiBody | null, f: string) => d?.errors?.join(", ") ?? d?.message ?? f;

interface ShortLine { productId: string; name: string; loose: boolean; varianceQty: number; varianceValueMinor: number; reasonLabel: string | null; soldToWalkIns?: boolean }
interface Report {
  count: { id: string; docNumber: string; location: string; postedAt: string | null; countedBy: string | null };
  summary: { counted: number; correct: number; short: number; over: number; kulangValueMinor: number; sobraValueMinor: number };
  lines: ShortLine[];
  walkIn?: WalkInInfo | null;
}
interface Cash {
  day: string; location: string; salesMinor: number; salesCount: number; walkInMinor: number; expectedMinor: number;
  /** Step 4 of the per-store build (an older server does not send these). */
  creditPaidMinor?: number; givenBackMinor?: number; paidOutMinor?: number; handedOverMinor?: number;
  saved: { countedMinor: number; expectedMinor: number; diffMinor: number; note: string | null; at: string } | null;
  /** The closing of that day at this store, made here or on Reports, Closing & stock (an older server does not send it). */
  closed?: { countedMinor: number; expectedMinor: number; diffMinor: number; at: string; fromThisCount: boolean } | null;
}

const qty = (loose: boolean, n: number) => (loose ? formatKg(Math.abs(n) / 1000) : `${Math.abs(n)}`);

/** Steps 3-5 of a posted "Close the store" count. */
export default function CloseStoreAfter({ countId, onClose }: { countId: string; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [cash, setCash] = useState<Cash | null>(null);
  const [step, setStep] = useState<CloseStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storeName, setStoreName] = useState("");
  const [full, setFull] = useState(false);

  const load = useCallback(async (): Promise<{ r: Report; c: Cash } | null> => {
    const [rr, cr] = await Promise.all([
      fetch(`${API_URL}/admin/counts/${countId}/report`, { headers: adminHeaders() }),
      fetch(`${API_URL}/admin/counts/${countId}/cash`, { headers: adminHeaders() }),
    ]);
    const [rd, cd] = [(await rr.json().catch(() => null)) as ApiBody | null, (await cr.json().catch(() => null)) as ApiBody | null];
    if (!rr.ok) { setError(errText(rd, "Could not open the count")); return null; }
    if (!cr.ok) { setError(errText(cd, "Could not load the cash")); return null; }
    const r = rd as unknown as Report, c = cd as unknown as Cash;
    setReport(r); setCash(c); setError(null);
    return { r, c };
  }, [countId]);

  useEffect(() => {
    void load().then((x) => {
      if (!x) return;
      // Open where the person left off: walk-ins still to record, then the cash, then the summary.
      setStep(x.r.walkIn?.open.length ? "Walk-ins" : x.c.saved || x.c.closed ? "Done" : "Cash");
    }).catch(() => setError("No internet. Try again when the tablet is online."));
    void fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() }).then((r) => (r.ok ? r.json() : null)).then((d) => setStoreName(d?.name ?? "")).catch(() => {});
  }, [load]);

  if (!report || !cash || !step) {
    return (
      <div style={{ maxWidth: 720 }}>
        {error ? <div className="alert alert-danger" role="alert">{error}</div> : <p className="text-muted">Opening…</p>}
        <button type="button" className="btn btn-outline-dark btn-lg" onClick={onClose}>← Counts</button>
      </div>
    );
  }

  const walkInMinor = (report.walkIn?.sales ?? []).reduce((s, x) => s + x.totalMinor, 0);
  const notSales = report.lines.filter((l) => l.varianceQty < 0 && !l.soldToWalkIns && l.reasonLabel && !report.walkIn?.open.some((o) => o.productId === l.productId));
  // With today's server the day is closed only by the signed cash step (or on Reports, Closing & stock).
  const dayClosed = cash.closed === undefined ? !!cash.saved : !!cash.closed;
  const head = (
    <>
      <h2 className="h4 mb-2">Close the store · {report.count.location}</h2>
      {/* The summary of a day that is not closed yet keeps the Cash step open in the bar. */}
      <CloseSteps step={step === "Done" && !dayClosed ? "Cash" : step} />
      {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}
    </>
  );

  if (step === "Walk-ins") {
    return (
      <div style={{ maxWidth: 720 }}>
        {head}
        <p className="mb-2">The count is saved. These items are short and marked <strong>Sold but not rung up</strong>.</p>
        {report.walkIn && <CountWalkIn countId={countId} info={report.walkIn} onDone={() => { void load().then((x) => { if (x && !x.r.walkIn?.open.length) { toast("Walk-in sales recorded"); setStep("Cash"); } }); }} />}
        {notSales.length > 0 && <NotSales lines={notSales} />}
        <div className="d-flex flex-wrap gap-2 mt-3">
          <button type="button" className="btn btn-outline-dark btn-lg" onClick={() => setStep("Cash")}>Skip: these were not sold</button>
        </div>
      </div>
    );
  }

  if (step === "Cash") {
    return (
      <div style={{ maxWidth: 1080 }}>
        {head}
        {walkInMinor > 0 && <div className="alert alert-success py-2" role="status"><i className="bi bi-check-circle me-1" aria-hidden="true"></i>Walk-in sales recorded: <strong>{peso(walkInMinor)}</strong></div>}
        {notSales.length > 0 && !report.walkIn?.open.length && <NotSales lines={notSales} />}
        <CashStep countId={countId} cash={cash} onSaved={(c) => { setCash(c); setStep("Done"); }} onSkip={() => setStep("Done")} />
      </div>
    );
  }

  // Done. A closed day shows the numbers it was closed with (one closing a day, here or on Reports, Closing & stock).
  const s = cash.closed ? { countedMinor: cash.closed.countedMinor, expectedMinor: cash.closed.expectedMinor, diffMinor: cash.closed.diffMinor, note: cash.saved?.note ?? null } : cash.saved;
  const expectedMinor = s?.expectedMinor ?? cash.expectedMinor;
  const lossMinor = report.lines.filter((l) => l.varianceQty < 0 && !l.soldToWalkIns).reduce((sum, l) => sum + Math.abs(l.varianceValueMinor), 0);
  const printClosing = () => printSlip({
    storeName: storeName || "SAM STORE", title: "STORE CLOSED", reference: report.count.docNumber,
    when: report.count.postedAt ? new Date(report.count.postedAt).toLocaleString("en-PH") : new Date().toLocaleString("en-PH"),
    lines: [{ label: "Store", value: report.count.location }, ...(report.count.countedBy ? [{ label: "Counted by", value: report.count.countedBy }] : [])],
    rows: report.lines.filter((l) => l.varianceQty !== 0).map((l) => ({
      name: l.name, qty: `${l.varianceQty > 0 ? "+" : "−"}${qty(l.loose, l.varianceQty)}`,
      note: l.soldToWalkIns ? "sold to walk-ins" : l.reasonLabel ?? undefined,
    })),
    totals: [
      { label: "Items counted", value: String(report.summary.counted) },
      { label: "Walk-in sales", value: peso(walkInMinor) },
      { label: "Cash expected", value: peso(expectedMinor) },
      ...(s ? [{ label: "Cash counted", value: peso(s.countedMinor) }, { label: s.diffMinor === 0 ? "Cash" : s.diffMinor < 0 ? "Cash short" : "Cash over", value: s.diffMinor === 0 ? "matches" : pesoText(s.diffMinor) }] : []),
    ],
    signatures: [{ role: "Closed by", name: "" }],
    widthMm: getPrinterSettings().widthMm === 80 ? 80 : 58,
  });
  return (
    <div style={{ maxWidth: 720 }}>
      {head}
      <div className="card mb-3">
        <div className="card-body">
          {dayClosed
            ? <h3 className="h5 text-success"><i className="bi bi-check-circle-fill me-1" aria-hidden="true"></i>{report.count.location} is closed for today</h3>
            : <h3 className="h5"><i className="bi bi-exclamation-triangle-fill text-warning me-1" aria-hidden="true"></i>The count is saved. The day is not closed yet.</h3>}
          {cash.closed && !cash.closed.fromThisCount && <p className="mb-2">The cash was already counted and signed on Reports, Closing &amp; stock. Nothing more to do here.</p>}
          <div className="cash-row"><span>Rice counted</span><strong>{report.summary.counted} items · {report.summary.correct} correct</strong></div>
          <div className="cash-row"><span>Walk-in sales recorded</span><strong>{peso(walkInMinor)}</strong></div>
          {lossMinor > 0 && <div className="cash-row"><span>Short and not sold, at cost (spilled, wet…)</span><strong className="text-danger">{pesoText(lossMinor)}</strong></div>}
          <div className="cash-row"><span>Cash expected</span><strong>{peso(expectedMinor)}</strong></div>
          {s ? (
            <>
              <div className="cash-row"><span>Cash counted</span><strong>{peso(s.countedMinor)}</strong></div>
              <div className={`cash-result mt-2 ${s.diffMinor === 0 ? "ok" : s.diffMinor < 0 ? "short" : "over"}`} role="status">
                {s.diffMinor === 0 ? "The cash matches." : s.diffMinor < 0 ? `Cash short ${pesoText(s.diffMinor)}` : `Cash over ${pesoText(s.diffMinor)}`}
                {s.note && <div className="fw-normal fs-6">{s.note}</div>}
              </div>
            </>
          ) : <p className="mb-0 mt-2">The cash was not counted.</p>}
          {!dayClosed && <p className="mb-0 mt-2">To close the day, count the cash and sign.</p>}
        </div>
      </div>
      <div className="d-flex flex-wrap gap-2 mb-3">
        {dayClosed
          ? <button type="button" className="btn btn-primary btn-lg" onClick={onClose}>Finish</button>
          : <button type="button" className="btn btn-primary btn-lg" onClick={() => setStep("Cash")}>Count the cash and close the day</button>}
        <button type="button" className="btn btn-outline-primary btn-lg" onClick={printClosing}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print closing slip</button>
        {!dayClosed && <button type="button" className="btn btn-outline-dark btn-lg" onClick={onClose}>Close it later</button>}
        <button type="button" className="btn btn-outline-dark btn-lg" aria-expanded={full} onClick={() => setFull((v) => !v)}>{full ? "Hide the full report" : "See the full report"}</button>
      </div>
      {full && <CountReport countId={countId} embedded />}
    </div>
  );
}

/** Shortages with another reason: they stay losses, never sales. */
function NotSales({ lines }: { lines: ShortLine[] }) {
  return (
    <div className="card mb-2">
      <div className="card-body py-2">
        <div className="fw-semibold">Short, but not sold (they stay as losses)</div>
        <ul className="list-unstyled mb-0">
          {lines.map((l) => <li key={l.productId}>{qty(l.loose, l.varianceQty)}{l.loose ? "" : " ×"} {l.name} · {l.reasonLabel}</li>)}
        </ul>
      </div>
    </div>
  );
}

/** Step 4: count the cash from today's sales here; the difference shows as you type. Signing closes the day. */
function CashStep({ countId, cash, onSaved, onSkip }: { countId: string; cash: Cash; onSaved: (c: Cash) => void; onSkip: () => void }) {
  const [typed, setTyped] = useState(cash.saved ? String(cash.saved.countedMinor / 100) : "");
  const [note, setNote] = useState(cash.saved?.note ?? "");
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counted = typed.trim() === "" ? null : pesosToMinor(typed);
  const diff = counted === null ? null : counted - cash.expectedMinor;
  const day = new Date(`${cash.day}T00:00:00+08:00`).toLocaleDateString("en-PH", { day: "numeric", month: "short", timeZone: "Asia/Manila" });

  const save = async () => {
    if (counted === null || !sig) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/admin/counts/${countId}/cash`, { method: "POST", headers: { ...adminHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ countedMinor: counted, note: note.trim() || undefined, signatures: [{ signerKind: "STAFF", imagePng: sig }] }) });
      const d = (await res.json().catch(() => null)) as ApiBody | null;
      if (!res.ok) { setError(errText(d, "Could not close the day")); return; }
      toast("The day is closed");
      onSaved(d as unknown as Cash);
    } catch {
      setError("No internet. Try again when the tablet is online.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mb-3" aria-labelledby="cash-title">
      <div className="card-body">
        <h3 id="cash-title" className="h5 mb-1">Count the cash and close the day</h3>
        <p className="mb-2">Count all the cash taken in today at {cash.location}. Do not include the change money you started with.</p>
        <div className="row g-3">
        <div className="col-lg-6">
          <div className="cash-row"><span>Cash sales today ({day}) · {cash.salesCount} sale{cash.salesCount === 1 ? "" : "s"} rung up</span><span>{peso(cash.salesMinor)}</span></div>
          <div className="cash-row"><span>Walk-in sales from this count</span><span>{peso(cash.walkInMinor)}</span></div>
          {!!cash.creditPaidMinor && <div className="cash-row"><span>Credit paid in cash</span><span>{peso(cash.creditPaidMinor)}</span></div>}
          {!!cash.givenBackMinor && <div className="cash-row"><span>Less: cash given back to customers</span><span>−{peso(cash.givenBackMinor)}</span></div>}
          {!!cash.paidOutMinor && <div className="cash-row"><span>Less: expenses paid from the drawer</span><span>−{peso(cash.paidOutMinor)}</span></div>}
          {!!cash.handedOverMinor && <div className="cash-row"><span>Less: cash handed over to the owner</span><span>−{peso(cash.handedOverMinor)}</span></div>}
          <div className="cash-row total"><span>Cash you should have</span><span>{peso(cash.expectedMinor)}</span></div>
        </div>
        <div className="col-lg-6">
        <label className="form-label" htmlFor="cash-counted">Cash you counted (₱)</label>
        <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
          <input id="cash-counted" className="form-control cash-input" inputMode="decimal" autoComplete="off" placeholder="0" value={typed}
            onChange={(e) => setTyped(cleanTyping(e.target.value, "peso").slice(0, 12))} aria-describedby="cash-diff" />
          <button type="button" className="btn btn-outline-dark btn-lg" onClick={() => setTyped(String(cash.expectedMinor / 100))}>Exactly {peso(cash.expectedMinor)}</button>
        </div>
        <div id="cash-diff" aria-live="polite">
          {diff !== null && (
            <div className={`cash-result mb-2 ${diff === 0 ? "ok" : diff < 0 ? "short" : "over"}`}>
              {diff === 0 ? <><i className="bi bi-check-circle me-1" aria-hidden="true"></i>The cash matches.</> : diff < 0 ? <>Short {pesoText(diff)}. Count again, or write why below.</> : <>Over {pesoText(diff)}. Count again, or write why below.</>}
            </div>
          )}
        </div>
        {diff !== null && diff !== 0 && (
          <>
            <label className="form-label" htmlFor="cash-note">Why? (optional)</label>
            <input id="cash-note" className="form-control form-control-lg mb-2" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. paid the kargador ₱200 from the drawer" />
          </>
        )}
        <div className="fw-semibold mt-2">Your signature</div>
        <div className="cash-sign"><SignaturePad onSignature={setSig} /></div>
        {error && <div className="alert alert-danger py-2 mt-2" role="alert">{error}</div>}
        <div className="d-flex flex-wrap gap-2 mt-2">
          <button type="button" className="btn btn-primary btn-lg flex-grow-1" disabled={busy || counted === null || !sig} aria-busy={busy} onClick={() => void save()}>{busy ? "Closing…" : "Close the day"}</button>
          <button type="button" className="btn btn-outline-dark btn-lg" disabled={busy} onClick={onSkip}>Close it later</button>
        </div>
        {(counted === null || !sig) && <p className="text-muted mb-0 mt-2">{counted === null ? "Type the cash you counted, then sign." : "Sign in the box to close the day."}</p>}
        </div>
        </div>
      </div>
    </section>
  );
}

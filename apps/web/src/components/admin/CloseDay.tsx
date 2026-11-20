"use client";

// Close day (Z-read): one screen, five steps, no skipping ahead.
//   1 Check    everything on this tablet is sent; sales on hold; cash taken out today is written down
//   2 Cash     count the drawer bill by bill (or type the total)
//   3 GCash    type today's total from the GCash app
//   4 Balance  should be / counted / result for cash and GCash; a reason when it does not match;
//              the change fund kept for tomorrow
//   5 Sign     signature, Close day → the Z-read, Print
// The counts are typed BEFORE the "should be" amounts show, so nobody counts toward a number.

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { flushQueue, heldSteps, QUEUE_EVENT, queuedSteps } from "../../lib/offlineQueue";
import { useOffline } from "../../lib/offlineCache";
import { peso } from "../../lib/number-format";
import { printSlip } from "../../lib/slip-print";
import { toast } from "../../lib/toast";
import { DENOMINATIONS, dayText, timeText, VARIANCE_REASONS, zLabel, zSlip, type DayFigures } from "../../lib/day";
import NumPad from "./NumPad";
import SignaturePad from "./SignaturePad";
import Steps from "./Steps";
import { PesoInput } from "../NumberBoxes";

const STEPS = ["Check", "Cash", "GCash", "Balance", "Sign"];
const toMinor = (s: string) => Math.round(Number(s.replace(/,/g, "") || "0") * 100);
const errText = (d: { message?: string; errors?: string[] } | null, fallback: string) => d?.errors?.join(", ") || d?.message || fallback;
const diffWords = (m: number) => (m === 0 ? "Correct" : m < 0 ? `Short ${peso(-m)}` : `Over ${peso(m)}`);
const diffClass = (m: number) => (m === 0 ? "day-ok" : m < 0 ? "day-short" : "day-over");

/** The figures of a Z-read or X-read, as a list on screen. */
export function ZView({ z, kind }: { z: DayFigures; kind: "X" | "Z" }) {
  const row = (label: string, value: string, strong = false) => (
    <div className={`d-flex justify-content-between gap-3 py-1 border-bottom${strong ? " fw-bold" : ""}`}><span>{label}</span><span className="text-end">{value}</span></div>
  );
  return (
    <div className="zview">
      <p className="mb-2"><strong>{z.location.name}</strong> · {dayText(z.businessDate)}<br />
        <span className="text-muted">Opened {timeText(z.openedAt)} by {z.openedBy}{z.closedAt ? ` · closed ${timeText(z.closedAt)} by ${z.closedBy}` : ""}</span></p>
      {z.reopened && <div className="alert alert-warning py-2">Reopened {timeText(z.reopened.at)} by {z.reopened.by}: {z.reopened.reason}</div>}
      <h3 className="h6 mt-2">Sales</h3>
      {row(`Sales (${z.sales.count})`, peso(z.sales.grossMinor))}
      {z.sales.takenBackCount > 0 && row(`Taken back (${z.sales.takenBackCount})`, `−${peso(z.sales.takenBackMinor)}`)}
      {row("Net sales", peso(z.sales.netMinor), true)}
      {row("Cash", peso(z.sales.cashMinor))}
      {row("GCash", peso(z.sales.gcashMinor))}
      {row("Credit", peso(z.sales.creditMinor))}
      {z.sales.otherMinor !== 0 && row("Maya / bank", peso(z.sales.otherMinor))}
      {row("Credit collected", peso(z.creditCollectedMinor))}
      {z.receipts.first && row("Receipts", z.receipts.first === z.receipts.last ? z.receipts.first : `${z.receipts.first} to ${z.receipts.last}`)}
      <h3 className="h6 mt-3">Cash drawer</h3>
      {row("Change fund", peso(z.cash.floatMinor))}
      {row("Cash in", peso(z.cash.inMinor))}
      {z.cash.givenBackMinor > 0 && row("Given back", `−${peso(z.cash.givenBackMinor)}`)}
      {z.cash.paidOutMinor > 0 && row("Expenses from the drawer", `−${peso(z.cash.paidOutMinor)}`)}
      {z.cash.handedOverMinor > 0 && row("Handed to the owner", `−${peso(z.cash.handedOverMinor)}`)}
      {row("Cash should be", peso(z.cash.shouldBeMinor), true)}
      {z.cash.countedMinor !== null && row("Cash counted", peso(z.cash.countedMinor), true)}
      {z.cash.differenceMinor !== null && <div className={`py-1 fw-bold ${diffClass(z.cash.differenceMinor)}`}>Cash: {diffWords(z.cash.differenceMinor)}</div>}
      <h3 className="h6 mt-3">GCash</h3>
      {row("GCash should be", peso(z.gcash.shouldBeMinor), true)}
      {z.gcash.countedMinor !== null && row("GCash counted", peso(z.gcash.countedMinor), true)}
      {z.gcash.differenceMinor !== null && <div className={`py-1 fw-bold ${diffClass(z.gcash.differenceMinor)}`}>GCash: {diffWords(z.gcash.differenceMinor)}</div>}
      {z.varianceReason && row("Reason", z.varianceReason)}
      {z.keepFloatMinor !== null && row("Change fund kept for tomorrow", peso(z.keepFloatMinor))}
      {kind === "X" && <p className="small text-muted mt-2 mb-0">X-read: the day is still open. Nothing was closed.</p>}
    </div>
  );
}

export default function CloseDay({ locationId, storeName, placeName, heldCount, businessDate, onCancel, onClosed }: {
  locationId: string; storeName: string; placeName: string; heldCount: number; businessDate: string;
  onCancel: () => void; onClosed: () => void | Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [fig, setFig] = useState<DayFigures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(() => queuedSteps().length);
  const [others, setOthers] = useState(() => heldSteps().length);
  const [cashOutOk, setCashOutOk] = useState<boolean | null>(null);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [byTotal, setByTotal] = useState(false);
  const [cashTotal, setCashTotal] = useState("");
  const [gcash, setGcash] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [keep, setKeep] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [done, setDone] = useState<DayFigures | null>(null);
  const offline = useOffline();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/admin/rice/day/xread?locationId=${encodeURIComponent(locationId)}`, { headers: adminHeaders() });
      const d = (await res.json().catch(() => null)) as (DayFigures & { message?: string; errors?: string[] }) | null;
      if (!res.ok || !d) { setError(errText(d, "Could not load the day")); return null; }
      setFig(d); setError(null);
      return d;
    } catch {
      setError("Needs internet to close the day");
      return null;
    }
  }, [locationId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const upd = () => { setWaiting(queuedSteps().length); setOthers(heldSteps().length); };
    window.addEventListener(QUEUE_EVENT, upd);
    return () => window.removeEventListener(QUEUE_EVENT, upd);
  }, []);
  useEffect(() => { if (fig && keep === "") setKeep(String(fig.cash.floatMinor / 100)); }, [fig]); // eslint-disable-line react-hooks/exhaustive-deps

  const countedMinor = useMemo(() => (byTotal ? toMinor(cashTotal) : DENOMINATIONS.reduce((s, d) => s + d.minor * (counts[d.minor] ?? 0), 0)), [byTotal, cashTotal, counts]);
  const gcashMinor = toMinor(gcash);
  const cashDiff = fig ? countedMinor - fig.cash.shouldBeMinor : 0;
  const gcashDiff = fig ? gcashMinor - fig.gcash.shouldBeMinor : 0;
  const matches = cashDiff === 0 && gcashDiff === 0;
  const keepMinor = toMinor(keep);

  const setCount = (minor: number, n: number) => setCounts((c) => ({ ...c, [minor]: Math.max(0, Math.min(9999, n)) }));

  const sendNow = async () => { setBusy(true); await flushQueue(); setBusy(false); setWaiting(queuedSteps().length); };
  const toBalance = async () => { setBusy(true); const f = await load(); setBusy(false); if (f) setStep(3); };

  const close = async () => {
    setBusy(true); setError(null);
    const cashCounts = byTotal ? undefined : Object.fromEntries(DENOMINATIONS.filter((d) => (counts[d.minor] ?? 0) > 0).map((d) => [String(d.minor), counts[d.minor]]));
    const body = {
      locationId, gcashCountedMinor: gcashMinor, keepFloatMinor: keepMinor,
      ...(cashCounts ? { cashCounts } : { cashCountedMinor: countedMinor }),
      ...(!matches ? { varianceReason: reason } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      signatures: sig ? [{ signerKind: "STAFF", imagePng: sig }] : [],
    };
    const res = await fetch(`${API_URL}/admin/rice/day/close`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as (DayFigures & { message?: string; errors?: string[] }) | null;
    setBusy(false);
    if (!res) { setError("Needs internet to close the day"); return; }
    if (!res.ok || !d) {
      setError(errText(d, "Could not close the day"));
      // The amounts changed meanwhile (a late sale): show the balance again.
      if (res.status === 422 && /match|add up/i.test(errText(d, ""))) { await load(); setStep(3); }
      return;
    }
    setDone(d);
    toast(`${placeName}: day closed · ${zLabel(d.zNumber)}`);
  };

  const canLeaveCheck = waiting === 0 && !offline && !!fig && cashOutOk === true;

  return (
    <div className="close-day position-fixed top-0 start-0 w-100 h-100 bg-body overflow-auto rice-ui" role="dialog" aria-modal="true" aria-labelledby="cd-title" style={{ zIndex: 1075 }}>
      <div className="close-day-body py-3 px-3 mx-auto">
        <div className="d-flex align-items-center gap-2 mb-2">
          <h1 id="cd-title" className="h4 mb-0 me-auto"><i className="bi bi-lock me-2" aria-hidden="true"></i>Close day · {placeName}</h1>
          {!done && <button type="button" className="btn btn-outline-secondary btn-lg" onClick={onCancel}>Back to POS</button>}
        </div>
        <p className="text-muted mb-2">{dayText(businessDate)}</p>
        {!done && <Steps items={STEPS} current={step} />}
        {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

        {done ? (
          <div className="card border-success">
            <div className="card-body">
              <h2 className="h4 text-success mb-3"><i className="bi bi-check-circle me-2" aria-hidden="true"></i>Day closed · {zLabel(done.zNumber)}</h2>
              <ZView z={done} kind="Z" />
              <div className="d-grid gap-2 mt-3">
                <button type="button" className="btn btn-success btn-lg" onClick={() => printSlip(zSlip(done, storeName, "Z"))}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print the Z-read</button>
                <button type="button" className="btn btn-outline-dark btn-lg" onClick={() => void onClosed()}>Done</button>
              </div>
            </div>
          </div>
        ) : step === 0 ? (
          <div className="card"><div className="card-body">
            <h2 className="h5">1. Before counting</h2>
            {offline && <div className="alert alert-warning py-2">No internet. Closing the day needs internet, so every sale on this tablet is sent first.</div>}
            {waiting > 0 ? (
              <div className="alert alert-warning py-2 d-flex flex-wrap align-items-center gap-2">
                <span className="me-auto"><strong>{waiting}</strong> {waiting === 1 ? "sale or step is" : "sales or steps are"} still on this tablet. Send {waiting === 1 ? "it" : "them"} first so the count is complete.</span>
                <button type="button" className="btn btn-success" disabled={busy || offline} onClick={() => void sendNow()}>{busy ? "Sending…" : "Send now"}</button>
              </div>
            ) : (
              <p className="day-ok mb-2"><i className="bi bi-check-circle me-1" aria-hidden="true"></i>Everything on this tablet is sent.</p>
            )}
            {others > 0 && <div className="alert alert-warning py-2">{others} {others === 1 ? "step was" : "steps were"} saved on this tablet by another login. They send when that person signs in here again; if it is a sale of today, the count will be off by it.</div>}
            {heldCount > 0 && <p className="mb-2"><i className="bi bi-pause-circle me-1" aria-hidden="true"></i>{heldCount} {heldCount === 1 ? "sale is" : "sales are"} on hold. A sale on hold is not paid yet, so it is not in today&apos;s count.</p>}
            <h3 className="h6 mt-3">Cash taken out of the drawer today</h3>
            {!fig ? <p className="text-muted">Loading…</p> : fig.cashOut.length === 0 ? <p className="mb-2">Nothing written down yet.</p> : (
              <ul className="list-group mb-2">{fig.cashOut.map((c, i) => <li key={i} className="list-group-item d-flex justify-content-between gap-2"><span>{c.what} <span className="text-muted small">{timeText(c.at)}</span></span><strong>{peso(c.amountMinor)}</strong></li>)}</ul>
            )}
            <p className="fw-semibold mb-2">Did anyone take cash out that is NOT on this list (an expense, cash for the owner)?</p>
            <div className="d-flex flex-wrap gap-2 mb-2" role="group" aria-label="Cash taken out">
              <button type="button" className={`btn btn-lg ${cashOutOk === true ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={cashOutOk === true} onClick={() => setCashOutOk(true)}>No, all written down</button>
              <button type="button" className={`btn btn-lg ${cashOutOk === false ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={cashOutOk === false} onClick={() => setCashOutOk(false)}>Yes</button>
            </div>
            {cashOutOk === false && <div className="alert alert-warning py-2">Write it down first: Menu → Expenses (paid from the drawer), or Money → Cash → Hand over. Then come back and close.</div>}
            <button type="button" className="btn btn-success btn-lg w-100 mt-2" disabled={!canLeaveCheck} onClick={() => setStep(1)}>Next: count the cash</button>
          </div></div>
        ) : step === 1 ? (
          <div className="card"><div className="card-body">
            <h2 className="h5">2. Count the cash in the drawer</h2>
            <p className="mb-2">Count everything in the drawer, the change fund too.</p>
            <div className="d-flex gap-2 mb-3" role="group" aria-label="How to count">
              <button type="button" className={`btn ${!byTotal ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={!byTotal} onClick={() => setByTotal(false)}>Bill by bill</button>
              <button type="button" className={`btn ${byTotal ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={byTotal} onClick={() => setByTotal(true)}>Type the total</button>
            </div>
            {byTotal ? (
              <div className="mx-auto" style={{ maxWidth: 360 }}><NumPad value={cashTotal} onChange={setCashTotal} decimals={2} label="Cash counted" unit="₱" /></div>
            ) : (
              <div className="denoms">
                {DENOMINATIONS.map((d) => {
                  const n = counts[d.minor] ?? 0;
                  return (
                    <div key={d.minor} className="denom-row">
                      <span className="denom-label">{d.label}{d.coin ? <span className="text-muted small"> coin</span> : null}</span>
                      <span className="d-flex align-items-center gap-1">
                        <button type="button" className="btn btn-outline-dark qty-btn" aria-label={`One less ${d.label}`} disabled={n === 0} onClick={() => setCount(d.minor, n - 1)}>−</button>
                        <input className="form-control text-center denom-n" inputMode="numeric" aria-label={`How many ${d.label}`} value={n || ""} placeholder="0"
                          onChange={(e) => setCount(d.minor, Number(e.target.value.replace(/\D/g, "") || "0"))} onFocus={(e) => e.target.select()} />
                        <button type="button" className="btn btn-outline-dark qty-btn" aria-label={`One more ${d.label}`} onClick={() => setCount(d.minor, n + 1)}>+</button>
                      </span>
                      <span className="denom-sum">{n ? peso(d.minor * n) : ""}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="d-flex justify-content-between align-items-baseline mt-3 fs-4"><span>Cash counted</span><strong className="sale-total">{peso(countedMinor)}</strong></div>
            <div className="d-flex gap-2 mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setStep(0)}>Back</button>
              <button type="button" className="btn btn-success btn-lg flex-grow-1" onClick={() => setStep(2)}>Next: GCash</button>
            </div>
          </div></div>
        ) : step === 2 ? (
          <div className="card"><div className="card-body">
            <h2 className="h5">3. GCash received today</h2>
            <p className="mb-2">Open the GCash app and type today&apos;s total received (0 if none).</p>
            <div className="mx-auto" style={{ maxWidth: 360 }}><NumPad value={gcash} onChange={setGcash} decimals={2} label="GCash received today" unit="₱" /></div>
            <div className="d-flex gap-2 mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setStep(1)}>Back</button>
              <button type="button" className="btn btn-success btn-lg flex-grow-1" disabled={busy || offline} onClick={() => void toBalance()}>{busy ? "Please wait…" : "Next: check the balance"}</button>
            </div>
          </div></div>
        ) : step === 3 && fig ? (
          <div className="card"><div className="card-body">
            <h2 className="h5">4. Does it balance?</h2>
            <table className="table align-middle day-balance mb-2">
              <thead><tr><th></th><th className="text-end">Should be</th><th className="text-end">Counted</th><th className="text-end">Result</th></tr></thead>
              <tbody>
                <tr><th scope="row">Cash</th><td className="text-end">{peso(fig.cash.shouldBeMinor)}</td><td className="text-end">{peso(countedMinor)}</td><td className={`text-end fw-bold ${diffClass(cashDiff)}`}>{diffWords(cashDiff)}</td></tr>
                <tr><th scope="row">GCash</th><td className="text-end">{peso(fig.gcash.shouldBeMinor)}</td><td className="text-end">{peso(gcashMinor)}</td><td className={`text-end fw-bold ${diffClass(gcashDiff)}`}>{diffWords(gcashDiff)}</td></tr>
              </tbody>
            </table>
            <p className="small text-muted">Cash should be = change fund {peso(fig.cash.floatMinor)} + cash in {peso(fig.cash.inMinor)}{fig.cash.givenBackMinor ? ` − given back ${peso(fig.cash.givenBackMinor)}` : ""}{fig.cash.paidOutMinor ? ` − expenses ${peso(fig.cash.paidOutMinor)}` : ""}{fig.cash.handedOverMinor ? ` − to the owner ${peso(fig.cash.handedOverMinor)}` : ""}.</p>
            {!matches && (
              <>
                <p className="fw-semibold mb-2">It does not match. Count again, or choose why:</p>
                <div className="d-flex flex-wrap gap-2 mb-2" role="group" aria-label="Why it does not match">
                  {VARIANCE_REASONS.map((r) => <button key={r} type="button" className={`btn ${reason === r ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
                </div>
                <input className="form-control form-control-lg mb-2" aria-label="Note (optional)" placeholder="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
                <div className="mb-3"><button type="button" className="btn btn-outline-primary" onClick={() => setStep(1)}>Count again</button></div>
              </>
            )}
            <label className="form-label fw-semibold" htmlFor="cd-keep">Change fund left in the drawer for tomorrow</label>
            <PesoInput id="cd-keep" className="form-control form-control-lg mb-1" value={keep} onChange={setKeep} />
            {keepMinor > countedMinor && <div className="text-danger small mb-1">Cannot be more than the cash counted.</div>}
            <p className="small text-muted">The rest ({peso(Math.max(0, countedMinor - keepMinor))}) goes to the owner. Write the hand-over on Money → Cash.</p>
            <div className="d-flex gap-2 mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setStep(2)}>Back</button>
              <button type="button" className="btn btn-success btn-lg flex-grow-1" disabled={(!matches && !reason) || keepMinor > countedMinor} onClick={() => setStep(4)}>Next: sign</button>
            </div>
          </div></div>
        ) : step === 4 ? (
          <div className="card"><div className="card-body">
            <h2 className="h5">5. Sign and close</h2>
            <p className="mb-2">Cash counted <strong>{peso(countedMinor)}</strong> ({diffWords(cashDiff)}) · GCash <strong>{peso(gcashMinor)}</strong> ({diffWords(gcashDiff)}){!matches && reason ? ` · ${reason}` : ""}</p>
            <p className="mb-2">After closing, {placeName} cannot sell again today. Only the owner can reopen the day.</p>
            <SignaturePad onSignature={setSig} />
            <div className="d-flex gap-2 mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={() => setStep(3)}>Back</button>
              <button type="button" className="btn btn-success btn-lg flex-grow-1" disabled={busy || !sig || offline} onClick={() => void close()}>{busy ? "Please wait…" : "Close day"}</button>
            </div>
          </div></div>
        ) : <p className="text-muted">Loading…</p>}
      </div>
    </div>
  );
}

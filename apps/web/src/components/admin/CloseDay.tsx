"use client";

// Close day (Z-read): three steps, no skipping ahead.
//   1 Check   everything on this tablet is sent; sales on hold; cash taken out today is written down
//   2 Count   ONE screen like a cashier's X-reading (the owner asked for it, 2026-11-20): a row of big
//             number keys on top, bills and coins with how many + the amount, and beside them the day's
//             sales, the cash that should be in the drawer and the difference, live as you count.
//             GCash from the app and the change fund for tomorrow are typed on the same screen.
//             Print count = the bills and coins on paper. Post = go and sign.
//   3 Sign    signature, Close day → the Z-read, Print

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "../../config";
import { adminHeaders } from "../../lib/admin";
import { flushQueue, heldSteps, QUEUE_EVENT, queuedSteps } from "../../lib/offlineQueue";
import { useOffline } from "../../lib/offlineCache";
import { kg, peso } from "../../lib/number-format";
import { printSlip } from "../../lib/slip-print";
import { toast } from "../../lib/toast";
import { DENOMINATIONS, dayText, handedOnly, ownerKept, payWord, timeText, VARIANCE_REASONS, zLabel, zSlip, type DayFigures } from "../../lib/day";
import SignaturePad from "./SignaturePad";
import Steps from "./Steps";

const STEPS = ["Check", "Count", "Sign"];
const FIRST: Field = `d${DENOMINATIONS[0]?.minor ?? 100_000}`;
const toMinor = (s: string) => Math.round(Number(s.replace(/,/g, "") || "0") * 100);
const errText = (d: { message?: string; errors?: string[] } | null, fallback: string) => d?.errors?.join(", ") || d?.message || fallback;
const diffWords = (m: number) => (m === 0 ? "Correct" : m < 0 ? `Short ${peso(-m)}` : `Over ${peso(m)}`);
const diffClass = (m: number) => (m === 0 ? "day-ok" : m < 0 ? "day-short" : "day-over");

/** The owner's own sales at this store this day: which ones, and whether the owner kept the cash. */
export function OwnerSales({ z }: { z: DayFigures }) {
  const list = z.ownerSales ?? [];
  return (
    <div className="owner-sales mt-3">
      <h3 className="h6 mb-1"><i className="bi bi-person-check me-1" aria-hidden="true"></i>Owner&apos;s sales here ({list.length})</h3>
      {list.map((o) => (
        <div key={o.orderNumber} className="d-flex justify-content-between gap-3 py-1 border-bottom">
          <span>{o.orderNumber} · {payWord(o.method)} · {timeText(o.at)}<br />
            <span className={o.ownerKeptMinor ? "day-over" : "text-muted"}>{o.ownerKeptMinor ? `Owner kept ${peso(o.ownerKeptMinor)} cash` : ["cash", "split"].includes(o.method.toLowerCase()) ? "Cash in the drawer" : "No cash"}</span></span>
          <strong className="text-end">{peso(o.totalMinor)}</strong>
        </div>
      ))}
    </div>
  );
}

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
      {z.perKilo && z.perKilo.grams > 0 && row(`Per kilo sold (${kg(z.perKilo.grams)})`, peso(z.perKilo.totalMinor))}
      {z.receipts.first && row("Receipts", z.receipts.first === z.receipts.last ? z.receipts.first : `${z.receipts.first} to ${z.receipts.last}`)}
      <h3 className="h6 mt-3">Cash drawer</h3>
      {row("Change fund", peso(z.cash.floatMinor))}
      {row("Cash in", peso(z.cash.inMinor))}
      {z.cash.givenBackMinor > 0 && row("Given back", `−${peso(z.cash.givenBackMinor)}`)}
      {z.cash.paidOutMinor > 0 && row("Expenses from the drawer", `−${peso(z.cash.paidOutMinor)}`)}
      {ownerKept(z) > 0 && row("Owner kept (own sales)", `−${peso(ownerKept(z))}`)}
      {handedOnly(z) > 0 && row("Handed to the owner", `−${peso(handedOnly(z))}`)}
      {row("Cash should be", peso(z.cash.shouldBeMinor), true)}
      {z.cash.countedMinor !== null && row("Cash counted", peso(z.cash.countedMinor), true)}
      {z.cash.differenceMinor !== null && <div className={`py-1 fw-bold ${diffClass(z.cash.differenceMinor)}`}>Cash: {diffWords(z.cash.differenceMinor)}</div>}
      <h3 className="h6 mt-3">GCash</h3>
      {row("GCash should be", peso(z.gcash.shouldBeMinor), true)}
      {z.gcash.countedMinor !== null && row("GCash counted", peso(z.gcash.countedMinor), true)}
      {z.gcash.differenceMinor !== null && <div className={`py-1 fw-bold ${diffClass(z.gcash.differenceMinor)}`}>GCash: {diffWords(z.gcash.differenceMinor)}</div>}
      {z.varianceReason && row("Reason", z.varianceReason)}
      {!!z.ownerSales?.length && <OwnerSales z={z} />}
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
  // The box the number keys type into, and whether the next digit replaces what is there.
  const [active, setActive] = useState<Field>(FIRST);
  const [fresh, setFresh] = useState(true);
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

  // ── The number keys ──
  const order: Field[] = useMemo(() => [...(byTotal ? ["total" as Field] : DENOMINATIONS.map((d) => `d${d.minor}` as Field)), "gcash", "keep"], [byTotal]);
  const pick = (f: Field) => { setActive(f); setFresh(true); };
  const money: Record<"total" | "gcash" | "keep", [string, (v: string) => void]> = { total: [cashTotal, setCashTotal], gcash: [gcash, setGcash], keep: [keep, setKeep] };
  const press = (k: string) => {
    if (k === "next") { const i = order.indexOf(active); pick(order[(i + 1) % order.length] ?? FIRST); return; }
    if (active.startsWith("d")) {
      const minor = Number(active.slice(1));
      const n = counts[minor] ?? 0;
      let v = n;
      if (k === "C") v = 0;
      else if (k === "⌫") v = Math.floor(n / 10);
      else if (/^\d$/.test(k)) v = (fresh ? 0 : n) * 10 + Number(k);
      else return;
      if (v > 9999) return;
      setCounts((c) => ({ ...c, [minor]: v }));
      setFresh(false);
      return;
    }
    const [val, set] = money[active as "total" | "gcash" | "keep"];
    const base = fresh ? "" : val;
    if (k === "C") set("");
    else if (k === "⌫") set(fresh ? "" : val.slice(0, -1));
    else if (k === ".") { if (!base.includes(".")) set((base || "0") + "."); }
    else if (/^\d$/.test(k)) {
      const dot = base.indexOf(".");
      if (dot >= 0 && base.length - dot > 2) return;   // centavos: two digits
      if (base.replace(".", "").length >= 8) return;
      set(base === "0" ? k : base + k);
    } else return;
    setFresh(false);
  };
  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => {
    if (step !== 1 || done) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;   // the note box types normally
      if (/^\d$/.test(e.key) || e.key === ".") pressRef.current(e.key);
      else if (e.key === "Backspace") pressRef.current("⌫");
      else if (e.key === "Enter") { e.preventDefault(); pressRef.current("next"); }
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, done]);

  const sendNow = async () => { setBusy(true); await flushQueue(); setBusy(false); setWaiting(queuedSteps().length); };

  /** Post: read the day again (a late sale changes "should be"), then go and sign. */
  const post = async () => {
    if (!fig) return;
    setBusy(true);
    const before = fig;
    const f = await load();
    setBusy(false);
    if (!f) return;
    if (f.cash.shouldBeMinor !== before.cash.shouldBeMinor || f.gcash.shouldBeMinor !== before.gcash.shouldBeMinor) {
      setError("A payment came in while you were counting. The amounts changed — check them, then press Post again.");
      return;
    }
    setStep(2);
  };

  const printCount = () => {
    if (!fig) return;
    const rows = byTotal
      ? [{ name: "Cash counted (total typed)", qty: peso(countedMinor) }]
      : DENOMINATIONS.filter((d) => (counts[d.minor] ?? 0) > 0).map((d) => ({ name: `${d.label} x ${counts[d.minor]}`, qty: peso(d.minor * (counts[d.minor] ?? 0)) }));
    printSlip({
      storeName, locationId, title: "CASH COUNT (not closed yet)", when: new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }),
      lines: [{ label: "Store", value: placeName }, { label: "Day", value: dayText(businessDate) }],
      rows: [
        ...rows,
        { name: "CASH COUNTED", qty: peso(countedMinor) },
        { name: "Cash should be", qty: peso(fig.cash.shouldBeMinor) },
        { name: "Cash", qty: diffWords(cashDiff) },
        { name: "GCash in the app", qty: peso(gcashMinor) },
        { name: "GCash should be", qty: peso(fig.gcash.shouldBeMinor) },
        { name: "GCash", qty: diffWords(gcashDiff) },
      ],
      footer: "Count only. The day is still open.",
    });
  };

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
      // The amounts changed meanwhile (a late sale): show the count screen again.
      if (res.status === 422 && /match|add up/i.test(errText(d, ""))) { await load(); setStep(1); }
      return;
    }
    setDone(d);
    toast(`${placeName}: day closed · ${zLabel(d.zNumber)}`);
  };

  const canLeaveCheck = waiting === 0 && !offline && !!fig && cashOutOk === true;
  const canPost = !!fig && !busy && !offline && (matches || !!reason) && keepMinor <= countedMinor;

  /** A box the number keys type into. */
  const box = (f: Field, shown: string, label: string, extra = "") => (
    <button type="button" className={`zc-box${active === f ? " is-active" : ""}${extra}`} aria-pressed={active === f} aria-label={`${label}: ${shown || "0"}. Tap, then use the number keys.`} onClick={() => pick(f)}>
      {shown || <span className="zc-zero">0</span>}
    </button>
  );
  const sumRow = (label: string, value: string, cls = "") => (
    <div className={`zc-sum-row ${cls}`}><span>{label}</span><span className="zc-amt">{value}</span></div>
  );
  const denomRow = (d: (typeof DENOMINATIONS)[number]) => {
    const n = counts[d.minor] ?? 0;
    return (
      <div key={d.minor} className="zc-denom">
        <span className={`zc-money zc-m${d.minor}`}>{d.label}</span>
        {box(`d${d.minor}`, n ? String(n) : "", `How many ${d.label}${d.coin ? " coins" : " bills"}`)}
        <span className="zc-line">{n ? peso(d.minor * n) : <span className="zc-zero">{peso(0)}</span>}</span>
      </div>
    );
  };
  const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", "⌫", "C"];
  const dotOk = !active.startsWith("d");

  return (
    <div className="close-day position-fixed top-0 start-0 w-100 h-100 bg-body overflow-auto rice-ui" role="dialog" aria-modal="true" aria-labelledby="cd-title" style={{ zIndex: 1075 }}>
      <div className={`close-day-body py-3 px-3 mx-auto${step === 1 && !done ? " is-count" : ""}`}>
        <div className="d-flex align-items-center gap-2 mb-2">
          <h1 id="cd-title" className="h4 mb-0 me-auto"><i className="bi bi-lock me-2" aria-hidden="true"></i>Close day · {placeName} <span className="fw-normal text-muted fs-6 text-nowrap">{dayText(businessDate)}</span></h1>
          {!done && <button type="button" className="btn btn-outline-secondary btn-lg" onClick={onCancel}>Back to POS</button>}
        </div>
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
            <button type="button" className="btn btn-success btn-lg w-100 mt-2" disabled={!canLeaveCheck} onClick={() => setStep(1)}>Next: count the money</button>
          </div></div>
        ) : step === 1 && fig ? (
          <div className="zc">
            <div className="zc-keys" role="group" aria-label="Number keys">
              {KEYS.map((k) => (
                <button key={k} type="button" className={`zc-key${k === "C" ? " zc-key-c" : ""}`} disabled={k === "." && !dotOk}
                  aria-label={k === "⌫" ? "Erase one digit" : k === "C" ? "Clear this box" : k === "." ? "Point" : k} onClick={() => press(k)}>{k}</button>
              ))}
              <button type="button" className="zc-key zc-key-next" aria-label="Next box" onClick={() => press("next")}>Next <i className="bi bi-arrow-down-short" aria-hidden="true"></i></button>
            </div>

            <div className="d-flex flex-wrap align-items-center gap-2 my-2">
              <span className="me-auto">Tap a box, then press the numbers. Count everything in the drawer, the change fund too.</span>
              <div className="btn-group" role="group" aria-label="How to count">
                <button type="button" className={`btn ${!byTotal ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={!byTotal} onClick={() => { setByTotal(false); pick(FIRST); }}>Bill by bill</button>
                <button type="button" className={`btn ${byTotal ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={byTotal} onClick={() => { setByTotal(true); pick("total"); }}>Type the total</button>
              </div>
            </div>

            <div className={`zc-grid${byTotal ? " by-total" : ""}`}>
              {byTotal ? (
                <section className="zc-col zc-bills" aria-label="Cash counted">
                  <h2 className="zc-h">Cash in the drawer</h2>
                  <div className="zc-denom zc-denom-total"><span className="zc-money zc-mtotal">Total</span>{box("total", cashTotal ? `₱${cashTotal}` : "", "Cash counted, total")}</div>
                    <div className="zc-gcash">
                      <h3 className="zc-h">GCash</h3>
                      {sumRow("GCash should be", peso(fig.gcash.shouldBeMinor))}
                      <div className="zc-sum-row zc-sum-box"><span>In the GCash app today</span>{box("gcash", gcash ? `₱${gcash}` : "", "GCash in the app today")}</div>
                      <div className={`zc-variance ${diffClass(gcashDiff)}`} aria-live="polite"><span>GCash</span><strong>{diffWords(gcashDiff)}</strong></div>
                    </div>
                </section>
              ) : (
                <>
                  <section className="zc-col zc-bills" aria-label="Bills">
                    <h2 className="zc-h">Bills</h2>
                    {DENOMINATIONS.filter((d) => !d.coin).map(denomRow)}
                  </section>
                  <section className="zc-col zc-coins" aria-label="Coins">
                    <h2 className="zc-h">Coins</h2>
                    {DENOMINATIONS.filter((d) => d.coin).map(denomRow)}
                    <div className="zc-count-total"><span>Cash count</span><strong>{peso(countedMinor)}</strong></div>
                    <div className="zc-gcash">
                      <h3 className="zc-h">GCash</h3>
                      {sumRow("GCash should be", peso(fig.gcash.shouldBeMinor))}
                      <div className="zc-sum-row zc-sum-box"><span>In the GCash app today</span>{box("gcash", gcash ? `₱${gcash}` : "", "GCash in the app today")}</div>
                      <div className={`zc-variance ${diffClass(gcashDiff)}`} aria-live="polite"><span>GCash</span><strong>{diffWords(gcashDiff)}</strong></div>
                    </div>
                  </section>
                </>
              )}

              <section className="zc-col zc-sum" aria-label="Today's figures">
                <h2 className="zc-h">Today · {fig.sales.count} {fig.sales.count === 1 ? "sale" : "sales"}</h2>
                {sumRow("Net sales", peso(fig.sales.netMinor), "fw-bold")}
                {fig.sales.takenBackCount > 0 && sumRow(`Taken back (${fig.sales.takenBackCount})`, `−${peso(fig.sales.takenBackMinor)}`)}
                {sumRow("Credit (utang)", peso(fig.sales.creditMinor))}
                {sumRow("GCash sales", peso(fig.sales.gcashMinor))}
                {fig.sales.otherMinor !== 0 && sumRow("Maya / bank", peso(fig.sales.otherMinor))}
                {sumRow("Cash sales", peso(fig.sales.cashMinor), "fw-bold")}
                {fig.creditCollectedMinor > 0 && sumRow("Credit collected", peso(fig.creditCollectedMinor))}

                <h3 className="zc-h zc-h-sub">Cash drawer</h3>
                {sumRow("Change fund (opening)", peso(fig.cash.floatMinor))}
                {sumRow("Cash in", peso(fig.cash.inMinor))}
                {fig.cash.givenBackMinor > 0 && sumRow("Given back", `−${peso(fig.cash.givenBackMinor)}`)}
                {fig.cash.paidOutMinor > 0 && sumRow("Expenses", `−${peso(fig.cash.paidOutMinor)}`)}
                {ownerKept(fig) > 0 && sumRow("Owner kept (own sales)", `−${peso(ownerKept(fig))}`)}
                {handedOnly(fig) > 0 && sumRow("To the owner", `−${peso(handedOnly(fig))}`)}
                {sumRow("Cash should be", peso(fig.cash.shouldBeMinor), "fw-bold zc-rule")}
                {sumRow("Cash counted", peso(countedMinor), "fw-bold")}
                <div className={`zc-variance ${diffClass(cashDiff)}`} aria-live="polite"><span>Cash</span><strong>{diffWords(cashDiff)}</strong></div>
                {!!fig.ownerSales?.length && <OwnerSales z={fig} />}

              </section>
            </div>

            {!matches && (
              <div className="zc-why mt-3">
                <p className="fw-semibold mb-2">It does not match. Count again, or choose why:</p>
                <div className="d-flex flex-wrap gap-2 mb-2" role="group" aria-label="Why it does not match">
                  {VARIANCE_REASONS.map((r) => <button key={r} type="button" className={`btn ${reason === r ? "btn-dark" : "btn-outline-dark"}`} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
                </div>
                <input className="form-control form-control-lg" aria-label="Note (optional)" placeholder="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
              </div>
            )}

            <div className="zc-keep mt-3">
              <span className="fw-semibold">Change fund to leave for tomorrow</span>
              {box("keep", keep ? `₱${keep}` : "", "Change fund to leave for tomorrow")}
              <span className="text-muted">The rest, {peso(Math.max(0, countedMinor - keepMinor))}, goes to the owner.</span>
              {keepMinor > countedMinor && <span className="text-danger fw-semibold w-100">Cannot be more than the cash counted.</span>}
            </div>

            <div className="zc-actions">
              <button type="button" className="btn btn-outline-secondary btn-lg" onClick={() => setStep(0)}>Back</button>
              <button type="button" className="btn btn-outline-primary btn-lg" onClick={printCount}><i className="bi bi-printer me-1" aria-hidden="true"></i>Print count</button>
              <button type="button" className="btn btn-success btn-lg zc-post" disabled={!canPost} onClick={() => void post()}>{busy ? "Please wait…" : "Post"}</button>
            </div>
            {!matches && !reason && <p className="text-muted text-end mb-0 mt-1">Choose why it does not match to Post.</p>}
          </div>
        ) : step === 2 ? (
          <div className="card"><div className="card-body">
            <h2 className="h5">3. Sign and close</h2>
            <p className="mb-2">Cash counted <strong>{peso(countedMinor)}</strong> ({diffWords(cashDiff)}) · GCash <strong>{peso(gcashMinor)}</strong> ({diffWords(gcashDiff)}){!matches && reason ? ` · ${reason}` : ""}</p>
            <p className="mb-2">After closing, {placeName} cannot sell again today. Only the owner can reopen the day.</p>
            <SignaturePad onSignature={setSig} />
            <div className="d-flex gap-2 mt-3">
              <button type="button" className="btn btn-outline-secondary btn-lg" disabled={busy} onClick={() => setStep(1)}>Back</button>
              <button type="button" className="btn btn-success btn-lg flex-grow-1" disabled={busy || !sig || offline} onClick={() => void close()}>{busy ? "Please wait…" : "Close day"}</button>
            </div>
          </div></div>
        ) : <p className="text-muted">Loading…</p>}
      </div>
    </div>
  );
}

type Field = `d${number}` | "total" | "gcash" | "keep";

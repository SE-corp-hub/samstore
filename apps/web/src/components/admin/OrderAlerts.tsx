"use client";

// New-order alerts on every screen: a card at the top with who ordered, from which page and how much,
// a short chime, and "Open order". It stays until someone taps it or closes it, so an order that came in
// while the owner was at the shelf is still there when they come back. Changes made elsewhere (the courier
// marked it delivered, the hub's customer cancelled…) show as a small note that goes away by itself.
// The cards float over the screen (position: fixed) and never push the POS / Pre-order layout.

import { useEffect, useRef, useState } from "react";
import { onOrderChanges, startOrderPulse, type PulseOrder } from "../../lib/order-pulse";
import { peso } from "../../lib/number-format";

const CHANNEL: Record<string, string> = { messenger: "Messenger", order_form: "Order form", comment: "Comment", live: "Live", agent: "Agent", counter: "Counter" };
const STATUS: Record<string, string> = {
  RECEIVED: "waiting to be received", CONFIRMED: "received", PREPARING: "being prepared", READY: "ready",
  OUT_FOR_DELIVERY: "out for delivery", DELIVERED: "delivered", ON_HOLD: "on hold", COMPLETED: "completed",
  CANCELLED: "cancelled", FAILED_DELIVERY: "delivery failed",
};
const SOUND_KEY = "sam.orderSound";
const MAX_CARDS = 3;
const FOLD_AFTER_MS = 20_000;

/** Where the order came from, in words: "Samrice · Messenger", "Shop link", "Sales agent". */
export function orderFrom(o: Pick<PulseOrder, "source" | "sourcePage" | "sourceChannel">): string {
  if (o.source === "hub") return [o.sourcePage, CHANNEL[o.sourceChannel ?? ""]].filter(Boolean).join(" · ") || "SE Corp Hub";
  if (o.source === "agent") return "Sales agent";
  if (o.source === "online") return "Shop link";
  return o.source === "PRE_ORDER" ? "Pre-order" : "Counter";
}

/** Two short rising notes (WebAudio, no sound file). Browsers allow it only after the first tap on the page. */
let audio: AudioContext | null = null;
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === "suspended") void audio.resume();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.35, t + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.3);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + i * 0.18);
      osc.stop(t + i * 0.18 + 0.32);
    }
  } catch { /* no sound on this device: the card still shows */ }
}

export default function OrderAlerts({ onOpen }: { onOpen: (orderId: string) => void }) {
  const [cards, setCards] = useState<PulseOrder[]>([]);
  const [notes, setNotes] = useState<{ key: string; text: string }[]>([]);
  const [soundOn, setSoundOn] = useState(true);
  // The full cards show for a while, then fold into one small "2 new orders" button at the top, so they never
  // sit on top of Receive, Pay or the sale total for long. Tapping it opens the cards again.
  const [expanded, setExpanded] = useState(false);
  const foldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFor = (ms: number | null) => {
    setExpanded(true);
    if (foldTimer.current) clearTimeout(foldTimer.current);
    foldTimer.current = ms ? setTimeout(() => setExpanded(false), ms) : null;
  };
  const baseTitle = useRef("");

  useEffect(() => {
    try { setSoundOn(localStorage.getItem(SOUND_KEY) !== "off"); } catch { /* default on */ }
    // Unlock sound on the first tap anywhere (browsers block audio until then).
    const unlock = () => { try { audio ??= new AudioContext(); void audio.resume(); } catch { /* ignore */ } };
    window.addEventListener("pointerdown", unlock, { once: true });
    const stop = startOrderPulse();
    return () => { stop(); window.removeEventListener("pointerdown", unlock); };
  }, []);

  useEffect(() => onOrderChanges(({ orders, isNew }) => {
    const fresh = orders.filter(isNew);
    if (fresh.length > 0) {
      setCards((cur) => [...fresh.filter((o) => !cur.some((c) => c.id === o.id)).reverse(), ...cur]);
      let on = true;
      try { on = localStorage.getItem(SOUND_KEY) !== "off"; } catch { /* default on */ }
      if (on) chime();
      showFor(FOLD_AFTER_MS);
    }
    // Changed elsewhere (not new): a short note, only for orders that came from outside the counter.
    const changed = orders.filter((o) => !isNew(o) && o.source !== "pos" && o.source !== "PRE_ORDER");
    if (changed.length > 0) {
      const add = changed.slice(-2).map((o) => ({ key: `${o.id}:${o.updatedAt}`, text: `${o.orderNumber} (${o.customerName}) is now ${STATUS[o.status] ?? o.status.toLowerCase()}` }));
      setNotes((cur) => [...cur, ...add].slice(-3));
      for (const n of add) setTimeout(() => setNotes((cur) => cur.filter((x) => x.key !== n.key)), 8_000);
    }
  }), []);

  // "(2) …" in the tab title while new orders wait to be seen.
  useEffect(() => {
    if (!baseTitle.current) baseTitle.current = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = cards.length > 0 ? `(${cards.length}) ${baseTitle.current}` : baseTitle.current;
  }, [cards.length]);

  const close = (id: string) => setCards((cur) => cur.filter((c) => c.id !== id));
  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    try { localStorage.setItem(SOUND_KEY, next ? "on" : "off"); } catch { /* ignore */ }
    if (next) chime();
  };

  useEffect(() => () => { if (foldTimer.current) clearTimeout(foldTimer.current); }, []);

  if (cards.length === 0 && notes.length === 0) return null;
  if (!expanded && cards.length > 0) {
    return (
      <div className="order-alerts is-folded" aria-live="polite">
        <button type="button" className="btn order-alert-pill" onClick={() => showFor(null)} aria-label={`${cards.length} new order${cards.length === 1 ? "" : "s"}. Show them`}>
          <i className="bi bi-bell-fill me-2" aria-hidden="true"></i>{cards.length} new order{cards.length === 1 ? "" : "s"}
        </button>
        {notes.map((n) => (
          <div key={n.key} className="order-note" role="status"><i className="bi bi-info-circle me-1" aria-hidden="true"></i>{n.text}</div>
        ))}
      </div>
    );
  }
  const shown = cards.slice(0, MAX_CARDS);
  const more = cards.length - shown.length;
  return (
    <div className="order-alerts" aria-live="polite">
      {shown.map((o) => (
        <section key={o.id} className="order-alert" role="alert" aria-label={`New order ${o.orderNumber}`}>
          <div className="d-flex align-items-start gap-2">
            <i className="bi bi-bell-fill order-alert-icon" aria-hidden="true"></i>
            <div className="flex-grow-1 min-w-0">
              <div className="fw-bold">New order · {o.orderNumber}</div>
              <div className="text-truncate">{o.customerName}</div>
              <div className="order-alert-meta">{orderFrom(o)} · {o.deliveryType === "pickup" ? "Pickup" : "Delivery"}</div>
            </div>
            <div className="fs-5 fw-bold num text-nowrap">{peso(o.totalMinor)}</div>
          </div>
          <div className="d-flex gap-2 mt-2">
            <button type="button" className="btn btn-success fw-bold flex-grow-1" onClick={() => { close(o.id); onOpen(o.id); }}>
              <i className="bi bi-receipt me-1" aria-hidden="true"></i>Open order
            </button>
            <button type="button" className="btn btn-outline-dark" onClick={() => close(o.id)} aria-label={`Close the alert for ${o.orderNumber}`}>
              <i className="bi bi-x-lg" aria-hidden="true"></i>
            </button>
          </div>
        </section>
      ))}
      {cards.length > 0 && (
        <div className="d-flex align-items-center gap-2 order-alert-foot">
          {more > 0 && <span className="fw-semibold">+{more} more new order{more === 1 ? "" : "s"}</span>}
          {cards.length > 1 && <button type="button" className="btn btn-link px-1" onClick={() => setCards([])}>Close all</button>}
          <button type="button" className="btn btn-link px-1 ms-auto" onClick={toggleSound} aria-pressed={soundOn}>
            <i className={`bi ${soundOn ? "bi-volume-up" : "bi-volume-mute"} me-1`} aria-hidden="true"></i>{soundOn ? "Sound on" : "Sound off"}
          </button>
          <button type="button" className="btn btn-link px-1" onClick={() => setExpanded(false)}>Hide</button>
        </div>
      )}
      {notes.map((n) => (
        <div key={n.key} className="order-note" role="status"><i className="bi bi-info-circle me-1" aria-hidden="true"></i>{n.text}</div>
      ))}
    </div>
  );
}

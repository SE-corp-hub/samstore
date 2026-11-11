"use client";

// Live order updates without refreshing the app.
//
// While the screen is on, the tablet asks GET /admin/orders/pulse?since=… every 10 seconds: one tiny answer
// with the orders placed or changed since the last ask. Listeners get only what changed SOMEWHERE ELSE
// (SE Corp Hub, the shop link, a sales agent, the courier, another device): what this tablet just did itself
// is marked with markOwnOrderChange() and left out, so nobody is told about their own tap.
//
// Polling, not a push channel, on purpose: the beta API sleeps on free Render and sits behind the web's
// /backend proxy, and GBox Chrome drops long-lived connections; a short ask every 10 s survives all three.
// It stops while the screen is off or the app is in the background, and outside store hours (6 AM–5 PM, the
// hours the server is kept awake) unless someone touched the screen in the last 15 minutes, so the free
// server is not kept awake all night by a tablet left on the counter.

import { API_URL } from "../config";
import { adminHeaders, getAdminStoreId, getAdminToken } from "./admin";
import { connectionState } from "./offlineCache";

/** "Open order" on an alert: the Orders screen opens this order (event if it is on screen, key if it mounts next). */
export const OPEN_ORDER_EVENT = "sam:open-order";
export const OPEN_ORDER_KEY = "sam.openOrder";

export interface PulseOrder {
  id: string;
  orderNumber: string;
  status: string;
  source: string;
  sourceChannel?: string | null;
  sourcePage?: string | null;
  externalRef?: string | null;
  customerName: string;
  totalMinor: number;
  deliveryType?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One batch of changes made elsewhere. `isNew` says which orders arrived since the app started watching. */
export interface OrderChanges { orders: PulseOrder[]; isNew: (o: PulseOrder) => boolean }

const EVERY_MS = 10_000;
const OWN_FOR_MS = 45_000;
const AWAKE_FROM = 6;
const AWAKE_TO = 17;
const TOUCHED_FOR_MS = 15 * 60_000;
const SINCE_KEY = (storeId: string) => `sam.orderPulse.${storeId}`;

const own = new Map<string, number>();
/** This tablet just changed the order: its next pulse is not news. */
export function markOwnOrderChange(orderId: string): void {
  own.set(orderId, Date.now() + OWN_FOR_MS);
}
function isOwn(orderId: string): boolean {
  const until = own.get(orderId);
  if (until === undefined) return false;
  if (until < Date.now()) { own.delete(orderId); return false; }
  return true;
}

type Listener = (c: OrderChanges) => void;
const listeners = new Set<Listener>();
/** Called with every batch of orders placed or changed elsewhere. Returns the unsubscribe. */
export function onOrderChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Orders placed on the counter itself are not news to the counter: only these sources ring as "new order". */
export const isRemoteSource = (source: string) => source !== "pos" && source !== "PRE_ORDER";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastTouch = 0;
let startedAt = "";
const announced = new Set<string>();

const readSince = (storeId: string) => { try { return localStorage.getItem(SINCE_KEY(storeId)); } catch { return null; } };
const writeSince = (storeId: string, at: string) => { try { localStorage.setItem(SINCE_KEY(storeId), at); } catch { /* private window: keep it in memory only */ } };
let memSince: Record<string, string> = {};

function awake(now = new Date()): boolean {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
  const h = now.getHours();
  return (h >= AWAKE_FROM && h < AWAKE_TO) || Date.now() - lastTouch < TOUCHED_FOR_MS;
}

async function beat(): Promise<void> {
  const storeId = getAdminStoreId() ?? "";
  if (!getAdminToken() || !awake() || connectionState() !== "online") return;
  let since = memSince[storeId] ?? readSince(storeId);
  // A saved point older than half a day is stale news: start fresh instead of ringing for yesterday.
  if (since && Date.now() - Date.parse(since) > 12 * 3_600_000) since = null;
  const res = await fetch(`${API_URL}/admin/orders/pulse${since ? `?since=${encodeURIComponent(since)}` : ""}`, {
    headers: adminHeaders(),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return; // asleep, signed out or busy: the next beat tries again
  const d = (await res.json().catch(() => null)) as { at?: string | null; orders?: PulseOrder[] } | null;
  if (!d?.at) return;
  if (!startedAt) startedAt = since ?? d.at;
  memSince = { ...memSince, [storeId]: d.at };
  writeSince(storeId, d.at);
  const elsewhere = (d.orders ?? []).filter((o) => !isOwn(o.id));
  if (elsewhere.length === 0) return;
  const isNew = (o: PulseOrder) => o.createdAt > startedAt && !announced.has(o.id) && isRemoteSource(o.source);
  const batch: OrderChanges = { orders: elsewhere, isNew };
  for (const fn of [...listeners]) {
    try { fn(batch); } catch { /* one listener's problem never stops the others */ }
  }
  elsewhere.forEach((o) => announced.add(o.id));
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void beat().catch(() => { /* network blip: try again next beat */ }).finally(() => { if (running) schedule(EVERY_MS); });
  }, ms);
}

const touched = () => { lastTouch = Date.now(); };
const onVisible = () => { if (document.visibilityState === "visible" && running) schedule(300); };

/** Start watching (once per app). Returns the stop function. */
export function startOrderPulse(): () => void {
  if (running || typeof window === "undefined") return () => {};
  running = true;
  window.addEventListener("pointerdown", touched, { passive: true });
  window.addEventListener("keydown", touched);
  document.addEventListener("visibilitychange", onVisible);
  schedule(1_500);
  return () => {
    running = false;
    if (timer) clearTimeout(timer);
    window.removeEventListener("pointerdown", touched);
    window.removeEventListener("keydown", touched);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Ask now (e.g. right after the app comes back online), instead of waiting for the next beat. */
export function pulseNow(): void {
  if (running) schedule(0);
}

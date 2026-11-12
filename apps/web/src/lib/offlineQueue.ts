// Rice Ops M10 — weak signal. A signed step is sent with its own Idempotency-Key. If the
// phone has no signal, the step waits on the phone ("Waiting to send") and is sent
// when the signal returns (and every 20 s). The server answers the same key once, so a
// step that already reached it before the signal dropped never happens twice.
// Kept in this browser only (localStorage). A step stays queued while the login has expired or
// the server is down (lib/retryable.ts); only a clear refusal is listed under "Not sent".

import { API_URL } from "../config";
import { adminHeaders, getAdminUserId, getAuthItem } from "./admin";
import { newSaleKey } from "./saleKey";
import { keepInQueue } from "./retryable";
import { notFromApi } from "./wake-fetch";
import { isOffline, markOnline, OFFLINE_EVENT, watchConnection } from "./offlineCache";

const QUEUE = "rice-offline-queue-v1";
const FAILED = "rice-offline-failed-v1";
const EVENT = "rice-queue";

export interface QueuedStep {
  id: string; path: string; body: unknown; label: string; createdAt: number; attempts: number;
  /** What the screen shows while it waits (never sent). */
  view?: unknown;
  /**
   * Per-store build, step 8: the login that made this step, and its name then. A step is only ever
   * sent under its maker's own login, so a sale saved offline by one seller is never booked to the
   * next person (or the next store) who signs in on the same tablet. Steps saved before this have none.
   */
  by?: string;
  byName?: string;
}
export interface FailedStep { id: string; label: string; message: string; at: number }
export type StepResult = { status: "sent"; ok: boolean; data: (Record<string, unknown> & { message?: string; errors?: string[] }) | null } | { status: "queued" };

function read<T>(key: string): T[] {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
function write<T>(key: string, items: T[]): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
    return true;
  } catch {
    return false; // storage full or blocked: the caller tells the person to retry
  } finally {
    try { window.dispatchEvent(new Event(EVENT)); } catch { /* not in a browser */ }
  }
}

const allSteps = () => read<QueuedStep>(QUEUE);
const isMine = (s: QueuedStep, me: string) => !s.by || s.by === me;
/** What the signed-in login has waiting (and steps saved before makers were recorded). */
export const queuedSteps = () => { const me = getAdminUserId(); return allSteps().filter((s) => isMine(s, me)); };
/** Steps another login made on this tablet: they wait until that login signs in here again. */
export const heldSteps = () => { const me = getAdminUserId(); return allSteps().filter((s) => !isMine(s, me)); };
export const failedSteps = () => read<FailedStep>(FAILED);
export const clearFailed = () => write<FailedStep>(FAILED, []);
export const QUEUE_EVENT = EVENT;

/** How long a step waits for the server before it is kept on the tablet instead (a sleeping server, weak signal). */
export const SEND_WAIT_MS = 15_000;

async function post(path: string, body: unknown, key: string, waitMs?: number) {
  const ctl = new AbortController();
  const timer = waitMs ? setTimeout(() => ctl.abort(), waitMs) : null;
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...adminHeaders() },
    body: JSON.stringify(body),
    signal: ctl.signal,
  }).finally(() => { if (timer) clearTimeout(timer); });
  return { ok: res.ok, status: res.status, reachedApi: !notFromApi(res), data: (await res.json().catch(() => null)) as (Record<string, unknown> & { message?: string; errors?: string[] }) | null };
}

/**
 * Send a signed step now; with no signal it waits on the phone and goes later. While other steps
 * are already waiting it joins the end of the line, so they reach the server in the order made.
 * A server that has not answered within SEND_WAIT_MS (asleep, weak signal) counts as no signal,
 * and while the screens already work from the saved copy the step is kept at once (no wait at the counter).
 */
export async function sendStep(path: string, body: unknown, label: string, view?: unknown): Promise<StepResult> {
  const id = newSaleKey();
  const noSignal = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!isOffline() && queuedSteps().length === 0) {
    try {
      const r = await post(path, body, id, SEND_WAIT_MS);
      // A sleeping or unreachable server (Render waking up) is the same as no signal.
      if (r.reachedApi) return { status: "sent", ok: r.ok, data: r.data };
    } catch {
      /* no signal mid-send: queue it with the SAME key — if it did arrive, the server answers once */
    }
  }
  const items = allSteps();
  const by = getAdminUserId();
  const byName = getAuthItem("samstore.admin.email");
  items.push({ id, path, body, label, createdAt: Date.now(), attempts: 0, ...(view === undefined ? {} : { view }), ...(by ? { by, ...(byName ? { byName } : {}) } : {}) });
  if (!write(QUEUE, items)) return { status: "sent", ok: false, data: { message: "No signal and the phone is full — try again later" } };
  if (!noSignal) void flushQueue();
  return { status: "queued" };
}

let flushing = false;

/** Send what the signed-in login has waiting, oldest first. Stops at the first step that still has no signal. Another login's steps stay. */
export async function flushQueue(): Promise<{ sent: number; failed: number }> {
  if (flushing) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0;
  let failed = 0;
  try {
    for (;;) {
      const [next] = queuedSteps();
      if (!next) break;
      let r: Awaited<ReturnType<typeof post>>;
      try {
        r = await post(next.path, next.body, next.id);
      } catch {
        write(QUEUE, allSteps().map((s) => (s.id === next.id ? { ...s, attempts: s.attempts + 1 } : s)));
        break;
      }
      if (!r.reachedApi) break; // the server is asleep or unreachable: the same as no signal, however long it takes
      if (r.ok) markOnline();
      if (r.status === 409 && /Pinoproseso|process/i.test(String(r.data?.message ?? ""))) break; // still running server-side — try again later
      if (!r.ok && keepInQueue(r.status, next.attempts)) {
        // The login ran out or the server was busy: the sale stays on the phone and goes later.
        write(QUEUE, allSteps().map((s) => (s.id === next.id ? { ...s, attempts: s.attempts + 1 } : s)));
        break;
      }
      write(QUEUE, allSteps().filter((s) => s.id !== next.id));
      if (r.ok) sent++;
      else {
        failed++;
        write(FAILED, [...failedSteps(), { id: next.id, label: next.label, message: r.data?.errors?.join(", ") ?? r.data?.message ?? `HTTP ${r.status}`, at: Date.now() }].slice(-20));
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, failed };
}

let started = false;

/** Start sending queued steps when the signal returns, and every 20 s. */
export function startQueue(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("online", () => void flushQueue());
  // The real connection check came back (GBox may never fire "online"): send what is waiting.
  let wasOffline = isOffline();
  window.addEventListener(OFFLINE_EVENT, () => { const now = isOffline(); if (wasOffline && !now && queuedSteps().length) void flushQueue(); wasOffline = now; });
  watchConnection();
  setInterval(() => { if (queuedSteps().length) void flushQueue(); }, 20_000);
  void flushQueue();
}

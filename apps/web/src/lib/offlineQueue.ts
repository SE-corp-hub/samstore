// Rice Ops M10 — weak signal. A signed step is sent with its own Idempotency-Key. If the
// phone has no signal, the step waits on the phone ("Waiting to send") and is sent
// when the signal returns (and every 20 s). The server answers the same key once, so a
// step that already reached it before the signal dropped never happens twice.
// Kept in this browser only (localStorage). A step stays queued while the login has expired or
// the server is down (lib/retryable.ts); only a clear refusal is listed under "Not sent".

import { API_URL } from "../config";
import { adminHeaders } from "./admin";
import { newSaleKey } from "./saleKey";
import { keepInQueue } from "./retryable";

const QUEUE = "rice-offline-queue-v1";
const FAILED = "rice-offline-failed-v1";
const EVENT = "rice-queue";

export interface QueuedStep { id: string; path: string; body: unknown; label: string; createdAt: number; attempts: number }
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

export const queuedSteps = () => read<QueuedStep>(QUEUE);
export const failedSteps = () => read<FailedStep>(FAILED);
export const clearFailed = () => write<FailedStep>(FAILED, []);
export const QUEUE_EVENT = EVENT;

async function post(path: string, body: unknown, key: string) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...adminHeaders() },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => null)) as (Record<string, unknown> & { message?: string; errors?: string[] }) | null };
}

/** Send a signed step now; with no signal it waits on the phone and goes later. */
export async function sendStep(path: string, body: unknown, label: string): Promise<StepResult> {
  const id = newSaleKey();
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!offline) {
    try {
      const r = await post(path, body, id);
      return { status: "sent", ok: r.ok, data: r.data };
    } catch {
      /* no signal mid-send: queue it with the SAME key — if it did arrive, the server answers once */
    }
  }
  const items = queuedSteps();
  items.push({ id, path, body, label, createdAt: Date.now(), attempts: 0 });
  if (!write(QUEUE, items)) return { status: "sent", ok: false, data: { message: "No signal and the phone is full — try again later" } };
  return { status: "queued" };
}

let flushing = false;

/** Send what is waiting, oldest first. Stops at the first step that still has no signal. */
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
        write(QUEUE, queuedSteps().map((s) => (s.id === next.id ? { ...s, attempts: s.attempts + 1 } : s)));
        break;
      }
      if (r.status === 409 && /Pinoproseso|process/i.test(String(r.data?.message ?? ""))) break; // still running server-side — try again later
      if (!r.ok && keepInQueue(r.status, next.attempts)) {
        // The login ran out or the server was busy: the sale stays on the phone and goes later.
        write(QUEUE, queuedSteps().map((s) => (s.id === next.id ? { ...s, attempts: s.attempts + 1 } : s)));
        break;
      }
      write(QUEUE, queuedSteps().filter((s) => s.id !== next.id));
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
  setInterval(() => { if (queuedSteps().length) void flushQueue(); }, 20_000);
  void flushQueue();
}

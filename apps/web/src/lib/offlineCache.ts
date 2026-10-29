// Offline in the store: the screens a sale needs (products and prices, customers, the store,
// pre-orders) keep their last good answer on this tablet. With no internet, or a server that
// does not answer in time, the screen opens from that copy, and the sales made meanwhile wait
// in lib/offlineQueue.ts until the internet is back.
// Kept in this browser only (localStorage), one copy per store and per address; logging out forgets them.

import { API_URL } from "../config";
import { adminHeaders, getAdminStoreId, handleUnauthorized, SAVED_COPY_PREFIX as PREFIX } from "./admin";
import { notFromApi } from "./wake-fetch";

export const OFFLINE_EVENT = "rice-offline";
/** How long to wait for the server before opening the saved copy instead. */
export const CACHE_WAIT_MS = 8_000;
/** The same, once the screens already work from the saved copy. */
export const OFFLINE_WAIT_MS = 2_000;

let usingSaved = false;

function setUsingSaved(v: boolean) {
  if (usingSaved === v) return;
  usingSaved = v;
  try { window.dispatchEvent(new Event(OFFLINE_EVENT)); } catch { /* not in a browser */ }
}

/** The server answered (a queued sale went through): screens are live again. */
export const markOnline = () => setUsingSaved(false);

/** True with no internet, or while screens show the saved copy because the server did not answer. */
export function isOffline(): boolean {
  return (typeof navigator !== "undefined" && navigator.onLine === false) || usingSaved;
}

/** Most answers belong to one store; the account's own store list does not. */
type Scope = { perStore?: boolean };
const keyFor = (path: string, { perStore = true }: Scope = {}) => `${PREFIX}${perStore ? getAdminStoreId() ?? "" : "account"}:${path}`;

/** The saved copy of an address, or null. */
export function savedCopy<T = unknown>(path: string, scope?: Scope): T | null {
  try {
    const raw = window.localStorage.getItem(keyFor(path, scope));
    return raw ? ((JSON.parse(raw) as { data: T }).data ?? null) : null;
  } catch {
    return null;
  }
}

export function saveCopy(path: string, data: unknown, scope?: Scope) {
  try { window.localStorage.setItem(keyFor(path, scope), JSON.stringify({ data, at: Date.now() })); } catch { /* storage full: the screen still works online */ }
}

/**
 * GET an admin address. A good answer is saved and returned. With no internet, a server that
 * is down or asleep, or no answer within `waitMs`, the saved copy is returned (null if none).
 * A clear "no" from the server (403, 404 …) returns null, never an old copy.
 */
export async function cachedGet<T = unknown>(path: string, { headers, waitMs = CACHE_WAIT_MS }: { headers?: Record<string, string>; waitMs?: number } = {}): Promise<T | null> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    const ctl = new AbortController();
    // Already working from the saved copy: ask briefly, so each screen still opens fast.
    const timer = setTimeout(() => ctl.abort(), usingSaved ? Math.min(waitMs, OFFLINE_WAIT_MS) : waitMs);
    try {
      const res = await fetch(`${API_URL}${path}`, { headers: headers ?? adminHeaders(), signal: ctl.signal });
      if (handleUnauthorized(res)) return null;
      if (res.ok) {
        const data = (await res.json()) as T;
        saveCopy(path, data);
        setUsingSaved(false);
        return data;
      }
      if (!notFromApi(res) && res.status < 500) return null;
    } catch {
      /* no signal, too slow, or not JSON: use the saved copy */
    } finally {
      clearTimeout(timer);
    }
  }
  const kept = savedCopy<T>(path);
  if (kept !== null) setUsingSaved(true);
  return kept;
}

/** The reference printed on a receipt for a sale still waiting on this tablet. */
export function offlineRef(key: string): string {
  return `OFFLINE-${key.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase()}`;
}

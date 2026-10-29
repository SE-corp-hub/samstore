// Offline in the store: the screens a sale needs (products and prices, customers, the store,
// pre-orders) keep their last good answer on this tablet. With no internet, or a server that
// does not answer in time, the screen opens from that copy, and the sales made meanwhile wait
// in lib/offlineQueue.ts until the internet is back.
// Kept in this browser only (localStorage), one copy per store and per address; logging out forgets them.

import { useEffect, useState } from "react";
import { API_URL } from "../config";
import { adminHeaders, getAdminStoreId, handleUnauthorized, SAVED_COPY_PREFIX as PREFIX } from "./admin";
import { notFromApi } from "./wake-fetch";

export const OFFLINE_EVENT = "rice-offline";
/** How long to wait for the server before opening the saved copy instead. */
export const CACHE_WAIT_MS = 8_000;
/** The same, once the screens already work from the saved copy. */
export const OFFLINE_WAIT_MS = 2_000;

let usingSaved = false;
/** The last real check (see watchConnection) could not reach this app's own web server. */
let netDown = false;

const changed = () => { try { window.dispatchEvent(new Event(OFFLINE_EVENT)); } catch { /* not in a browser */ } };

function setUsingSaved(v: boolean) {
  if (usingSaved === v) return;
  usingSaved = v;
  changed();
}

/** How often the tablet checks for real that it can reach the internet. */
export const CHECK_EVERY_MS = 5_000;
const CHECK_WAIT_MS = 4_000;

/**
 * Ask this app's own web server for a tiny file. Chrome inside GBox can keep saying "online"
 * (navigator.onLine) with the Wi-Fi off, so only a real answer counts as online.
 */
export async function checkConnection(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHECK_WAIT_MS);
  let ok = false;
  try {
    const res = await fetch(`/manifest.webmanifest?ping=${Date.now()}`, { method: "HEAD", cache: "no-store", signal: ctl.signal });
    ok = res.ok || res.status === 405;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  if (netDown === ok) {
    netDown = !ok;
    if (ok) usingSaved = false; // back online: screens ask the server again (it says if it is still asleep)
    changed();
  }
  return ok;
}

let watching = false;

/** Keep checking every few seconds and at once when the phone says the network changed. */
export function watchConnection(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const check = () => void checkConnection();
  window.addEventListener("online", check);
  window.addEventListener("offline", () => { if (!netDown) { netDown = true; changed(); } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  setInterval(() => { if (document.visibilityState !== "hidden") check(); }, CHECK_EVERY_MS);
  check();
}

/** The server answered (a queued sale went through): screens are live again. */
export const markOnline = () => setUsingSaved(false);

/** Re-renders when the tablet goes offline or comes back. */
export function useOffline(): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const refresh = () => setOffline(isOffline());
    const events = [OFFLINE_EVENT, "online", "offline"];
    refresh();
    for (const e of events) window.addEventListener(e, refresh);
    return () => { for (const e of events) window.removeEventListener(e, refresh); };
  }, []);
  return offline;
}

/** True with no internet, or while screens show the saved copy because the server did not answer. */
export function isOffline(): boolean {
  return (typeof navigator !== "undefined" && navigator.onLine === false) || netDown || usingSaved;
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
  if ((typeof navigator === "undefined" || navigator.onLine !== false) && !netDown) {
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

// PIN lock (2026-11-07): the owner picks screens that ask for the lock PIN before they open, one
// list for when the owner is signed in and one for staff (manager, staff and sales agents).
// The tablet checks the PIN itself against a salted PBKDF2 hash saved with the settings, so the
// lock works with no internet. It is a lock for a shared tablet, not a security wall: what each
// role may do is still decided by the server.

import { useEffect, useState } from "react";
import { cachedGet, savedCopy } from "./offlineCache";
import { isOwnerRole } from "./admin";

export const LOCK_PATH = "/admin/feature-lock";
/** How long the locked screens stay open after the right PIN. */
export const UNLOCK_MINUTES = 10;
/** Wrong tries in a row before the pad waits. */
export const MAX_TRIES = 5;
export const WAIT_SECONDS = 60;

export interface FeatureLock {
  on: boolean;
  salt?: string;
  hash?: string;
  iterations?: number;
  owner: string[];
  staff: string[];
}

/** Suggested screens to lock when the owner first turns the lock on. */
export const SUGGESTED = {
  // The owner's tablet is often left signed in at the counter: money and setup screens.
  // The owner asked (2026-11-07) for Reports, Credit and the other screens where someone could change things.
  owner: ["utangrice", "reports", "storereport", "overview", "settings", "team", "products", "payable", "expenses", "customers"],
  // Staff keep selling, pre-orders, resack and stock in; credit, prices, money and reports need the owner.
  staff: ["utangrice", "reports", "storereport", "overview", "ulat", "products", "expenses", "customers"],
};

/** Which list applies to a role: the owner's own list, or the staff list for everyone else. */
export const lockListFor = (role: string): "owner" | "staff" => (isOwnerRole(role) ? "owner" : "staff");

/** Screens opened by two ids (the bottom bar's "utang" is the menu's "utangrice"). */
const SAME_SCREEN: Record<string, string> = { utang: "utangrice" };

export function isScreenLocked(lock: FeatureLock | null, role: string, screen: string): boolean {
  if (!lock?.on || !lock.hash) return false;
  const id = SAME_SCREEN[screen] ?? screen;
  return lock[lockListFor(role)].includes(id);
}

// ───────── unlocked for a while (memory only: a reload, Switch user or Log out locks again) ─────────
let openUntil = 0;
const EVENT = "rice-lock-change";
const changed = () => { try { window.dispatchEvent(new Event(EVENT)); } catch { /* not in a browser */ } };

export const unlockedNow = () => Date.now() < openUntil;
export const unlockedUntil = () => openUntil;
export function unlockForAWhile() { openUntil = Date.now() + UNLOCK_MINUTES * 60_000; changed(); }
export function lockAgain() { openUntil = 0; changed(); }

/** The lock settings (saved copy first, so it works offline) and whether the screens are open now. */
export function useFeatureLock(storeKey: string | null): { lock: FeatureLock | null; open: boolean; reload: () => void } {
  const [lock, setLock] = useState<FeatureLock | null>(() => (typeof window === "undefined" ? null : savedCopy<FeatureLock>(LOCK_PATH)));
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLock(savedCopy<FeatureLock>(LOCK_PATH));
    void cachedGet<FeatureLock>(LOCK_PATH).then((d) => { if (alive && d) setLock(d); });
    return () => { alive = false; };
  }, [storeKey, tick]);
  useEffect(() => {
    const refresh = () => setOpen(unlockedNow());
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener(LOCK_SAVED, reloadAll);
    // Close again when the time is up, without waiting for a tap.
    const timer = setInterval(refresh, 15_000);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener(LOCK_SAVED, reloadAll); clearInterval(timer); };
    function reloadAll() { setTick((t) => t + 1); }
  }, []);
  return { lock, open, reload: () => setTick((t) => t + 1) };
}

/** Settings → PIN lock saved: every screen reads the new lock. */
export const LOCK_SAVED = "rice-lock-saved";
export const announceLockSaved = () => { try { window.dispatchEvent(new Event(LOCK_SAVED)); } catch { /* ignore */ } };

// ───────── checking the PIN on the tablet ─────────
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PBKDF2-SHA256, the same as the server (apps/api domain/feature-lock.ts). */
export async function pinMatches(lock: FeatureLock, pin: string): Promise<boolean> {
  if (!lock.salt || !lock.hash || !lock.iterations || !/^\d{4}$/.test(pin)) return false;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  const key = await subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(lock.salt) as BufferSource, iterations: lock.iterations }, key, 256));
  const want = fromBase64(lock.hash);
  if (bits.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= (bits[i] ?? 0) ^ (want[i] ?? 0);
  return diff === 0;
}

// Wrong tries are counted on this tablet (kept across reloads).
const TRIES_KEY = "sam.lockTries";
type Tries = { n: number; waitUntil: number };
export function readTries(): Tries {
  try { const t = JSON.parse(localStorage.getItem(TRIES_KEY) ?? "") as Tries; if (typeof t?.n === "number") return t; } catch { /* none */ }
  return { n: 0, waitUntil: 0 };
}
export function writeTries(t: Tries) { try { localStorage.setItem(TRIES_KEY, JSON.stringify(t)); } catch { /* ignore */ } }

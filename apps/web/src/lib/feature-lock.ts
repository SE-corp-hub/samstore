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
  /** Each store's own lock (2026-11-20), by location id. A login tied to one store gets only its own. */
  locations?: Record<string, StoreLock>;
  /** The stores this login may set a lock for (Settings → PIN lock), with their names. */
  places?: { id: string; name: string }[];
}

/** One store's own lock: its PIN (as a hash) and the screens that ask for it at that store. */
export interface StoreLock {
  salt: string;
  hash: string;
  iterations: number;
  screens: string[];
  updatedAt?: string;
}

/** Suggested screens to lock when the owner first turns the lock on. */
export const SUGGESTED = {
  // The owner's tablet is often left signed in at the counter: money and setup screens.
  // The owner asked (2026-11-07) for Reports, Credit and the other screens where someone could change things.
  owner: ["utangrice", "reports", "storereport", "overview", "settings", "team", "products", "payable", "expenses", "customers"],
  // Staff keep selling, pre-orders, resack and stock in; credit, prices, money and reports need the owner.
  staff: ["utangrice", "reports", "storereport", "overview", "ulat", "products", "expenses", "customers"],
  // A store's own lock: credit, the store's money and prices, and its own lock settings.
  store: ["utangrice", "storereport", "ulat", "products", "expenses", "customers", "storeprices", "storelock"],
};

/** Which list applies to a role: the owner's own list, or the staff list for everyone else. */
export const lockListFor = (role: string): "owner" | "staff" => (isOwnerRole(role) ? "owner" : "staff");

/** Screens opened by two ids (the bottom bar's "utang" is the menu's "utangrice"). */
// Profit is part of the store reports: locking Store report locks Profit too.
const SAME_SCREEN: Record<string, string> = { utang: "utangrice", profit: "storereport" };

/** The owner's lock: is this screen on the owner's list for this role? */
function ownerLocks(lock: FeatureLock | null, role: string, id: string): boolean {
  return !!lock?.on && !!lock.hash && (lock[lockListFor(role)] ?? []).includes(id);
}

/** The lock of the store this login belongs to (none for the owner or a manager). */
export function storeLockOf(lock: FeatureLock | null, home: string | null): StoreLock | null {
  if (!lock || !home) return null;
  const l = lock.locations?.[home];
  return l?.hash ? l : null;
}

/**
 * Who locked this screen for this login: "owner" (the owner's lock, opened only by the owner's lock
 * PIN) or "store" (the login's own store lock, opened by that store's PIN or the owner's), or null.
 */
export function whoLocks(lock: FeatureLock | null, role: string, screen: string, home: string | null): "owner" | "store" | null {
  const id = SAME_SCREEN[screen] ?? screen;
  if (ownerLocks(lock, role, id)) return "owner";
  if (storeLockOf(lock, home)?.screens.includes(id)) return "store";
  return null;
}

export function isScreenLocked(lock: FeatureLock | null, role: string, screen: string, home: string | null = null): boolean {
  return whoLocks(lock, role, screen, home) !== null;
}

/** Locked and not opened yet: the PIN pad shows instead of the screen. */
export function isScreenClosed(lock: FeatureLock | null, role: string, screen: string, home: string | null, open: OpenState): boolean {
  const who = whoLocks(lock, role, screen, home);
  if (!who || open.all) return false;
  return who === "owner" || !open.store;
}

/** Does any screen ask for a PIN for this login? (Shows the Lock button while open.) */
export function anyLockFor(lock: FeatureLock | null, role: string, home: string | null): boolean {
  return (!!lock?.on && (lock[lockListFor(role)]?.length ?? 0) > 0) || (storeLockOf(lock, home)?.screens.length ?? 0) > 0;
}

// ───────── unlocked for a while (memory only: a reload, Switch user or Log out locks again) ─────────
// The owner's lock PIN opens every locked screen; a store PIN opens only that store's own locked screens.
export interface OpenState { all: boolean; store: boolean }
let openUntil = 0;
let storeOpenUntil = 0;
const EVENT = "rice-lock-change";
const changed = () => { try { window.dispatchEvent(new Event(EVENT)); } catch { /* not in a browser */ } };

export const unlockedNow = () => Date.now() < openUntil;
export const unlockedUntil = () => openUntil;
const openNow = (): OpenState => ({ all: Date.now() < openUntil, store: Date.now() < openUntil || Date.now() < storeOpenUntil });
export function unlockForAWhile(scope: "all" | "store" = "all") {
  const until = Date.now() + UNLOCK_MINUTES * 60_000;
  if (scope === "all") openUntil = until; else storeOpenUntil = until;
  changed();
}
export function lockAgain() { openUntil = 0; storeOpenUntil = 0; changed(); }

/** The lock settings (saved copy first, so it works offline) and whether the screens are open now. */
export function useFeatureLock(storeKey: string | null): { lock: FeatureLock | null; open: OpenState; reload: () => void } {
  const [lock, setLock] = useState<FeatureLock | null>(() => (typeof window === "undefined" ? null : savedCopy<FeatureLock>(LOCK_PATH)));
  const [open, setOpen] = useState<OpenState>({ all: false, store: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLock(savedCopy<FeatureLock>(LOCK_PATH));
    void cachedGet<FeatureLock>(LOCK_PATH).then((d) => { if (alive && d) setLock(d); });
    return () => { alive = false; };
  }, [storeKey, tick]);
  useEffect(() => {
    const refresh = () => setOpen((o) => { const n = openNow(); return n.all === o.all && n.store === o.store ? o : n; });
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
export async function pinMatches(lock: { salt?: string; hash?: string; iterations?: number }, pin: string): Promise<boolean> {
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

// PIN lock (2026-11-07): the owner picks screens that ask for a lock PIN before they open,
// one list for when the owner is signed in and one for staff (manager, staff, sales agent).
// The tablet must check the PIN with no internet, so the PIN is kept as a salted PBKDF2-SHA256
// hash that the tablet can check itself (Web Crypto). That makes it a lock for a shared tablet,
// not a security wall: what each role may do is still decided by the server.
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const LOCK_ITERATIONS = 100_000;

export interface FeatureLock {
  salt: string; // base64
  hash: string; // base64, 32 bytes
  iterations: number;
  owner: string[];
  staff: string[];
  updatedAt: string;
}

export function hashLockPin(pin: string, salt: string, iterations = LOCK_ITERATIONS): string {
  return pbkdf2Sync(pin, Buffer.from(salt, "base64"), iterations, 32, "sha256").toString("base64");
}

export function newLockSecret(pin: string): Pick<FeatureLock, "salt" | "hash" | "iterations"> {
  const salt = randomBytes(16).toString("base64");
  return { salt, hash: hashLockPin(pin, salt), iterations: LOCK_ITERATIONS };
}

export function lockPinMatches(lock: Pick<FeatureLock, "salt" | "hash" | "iterations">, pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return false;
  const a = Buffer.from(hashLockPin(pin, lock.salt, lock.iterations), "base64");
  const b = Buffer.from(lock.hash, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Screen ids are short lowercase words (see apps/web lib/admin.ts NAV_GROUPS); anything else is dropped. */
export function cleanScreenIds(v: unknown): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) if (typeof x === "string" && /^[a-z]{2,30}$/.test(x)) out.add(x);
  return [...out].slice(0, 60);
}

/** Read the stored JSON; anything malformed counts as "no lock". */
export function readFeatureLock(raw: unknown): FeatureLock | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.salt !== "string" || typeof r.hash !== "string" || typeof r.iterations !== "number") return null;
  return {
    salt: r.salt, hash: r.hash, iterations: r.iterations,
    owner: cleanScreenIds(r.owner) ?? [], staff: cleanScreenIds(r.staff) ?? [],
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}

// ───────── each store's own PIN lock (2026-11-20) ─────────
// The owner asked that a manager can set the PIN lock per location. Each store (location) can have
// its own lock PIN and its own list of screens. That list applies to every login whose home store
// it is (the store head and the counter staff). The owner's lock above still applies on top, and the
// owner's lock PIN opens a store's locked screens too. Who may set a store's lock: the owner, a
// manager (any store), and the head of that store (its own store only).

export interface LocationLock {
  salt: string;
  hash: string;
  iterations: number;
  screens: string[];
  updatedAt: string;
}

/** Location ids are cuids (letters and digits); anything else is dropped. */
const LOCATION_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** The stores' own locks from the stored JSON (`featureLock.locations`); broken entries are dropped. */
export function readLocationLocks(raw: unknown): Record<string, LocationLock> {
  const out: Record<string, LocationLock> = {};
  if (!raw || typeof raw !== "object") return out;
  const locs = (raw as Record<string, unknown>).locations;
  if (!locs || typeof locs !== "object") return out;
  for (const [id, v] of Object.entries(locs as Record<string, unknown>)) {
    if (!LOCATION_ID.test(id) || !v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.salt !== "string" || typeof r.hash !== "string" || typeof r.iterations !== "number") continue;
    out[id] = { salt: r.salt, hash: r.hash, iterations: r.iterations, screens: cleanScreenIds(r.screens) ?? [], updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "" };
  }
  return out;
}

/** The whole stored JSON: the owner's lock (or none) plus the stores' own locks. */
export function writeFeatureLock(owner: FeatureLock | null, locations: Record<string, LocationLock>): Record<string, unknown> | null {
  const hasLocs = Object.keys(locations).length > 0;
  if (!owner && !hasLocs) return null;
  return { ...(owner ?? {}), ...(hasLocs ? { locations } : {}) };
}

export interface LockActor { role: string; homeLocationId: string | null; isHead?: boolean }

/** May this login set the PIN lock of this store? Owner and manager: any store. Store head: its own store. */
export function canSetLocationLock(actor: LockActor, locationId: string): boolean {
  if (["OWNER", "STORE_OWNER", "PLATFORM_ADMIN", "MANAGER"].includes(actor.role)) return true;
  return !!actor.isHead && !!actor.homeLocationId && actor.homeLocationId === locationId;
}

/** Does this login sit behind one store (so it only needs that store's lock)? */
export const isOneStoreLogin = (actor: LockActor): boolean =>
  !["OWNER", "STORE_OWNER", "PLATFORM_ADMIN", "MANAGER"].includes(actor.role) && !!actor.homeLocationId;

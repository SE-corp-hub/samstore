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

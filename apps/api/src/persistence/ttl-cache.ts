// Tiny TTL cache for read-mostly admin reads — backed by managed Redis (R3)
// when REDIS_URL is configured, with an in-process Map fallback otherwise.
// Why: the app's Postgres is a remote managed instance (Supabase pooler) — every
// query costs ~100–300 ms of network RTT, so panels stacking several queries
// (products + stock, settings, customers, ledger list) take 1–2 s to load.
// Read-mostly catalog data is cached briefly (TTL 10–60 s) and invalidated on
// writes. NEVER wrap money-mutating reads (order lists, holds, balancing) —
// those stay uncached for correctness.
//
// Keys are store-scoped (tenancy: store A can never read store B's cache).
//
// ASYNC contract: call sites are async controllers/services, so every call is
// awaited (`await cacheGet(...)`). The Redis round-trip is ~5–20 ms locally /
// ~30–80 ms over the wire; when the store is empty the fallback Map is instant.

import { redisClient, resetRedisForTest } from "./redis.js";

const DEFAULT_TTL_MS = 10_000;

export { resetRedisForTest };

/** Reads a cached value; undefined on miss or expiry. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  return (await redisClient().get<T>(key)) ?? undefined;
}

/** Caches `value` under `key` for `ttlMs` (default 10s). Registers the key for prefix busting. */
export async function cacheSet(key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
  const r = redisClient();
  await r.set(key, value, ttlMs);
  const prefix = key.split(":")[0];
  const registryKey = `__reg:${prefix}`;
  const members = (await r.get<string[]>(registryKey)) ?? [];
  if (!members.includes(key)) {
    members.push(key);
    await r.set(registryKey, members, ttlMs * 4);
  }
}

/**
 * Removes every cached entry for a namespace (e.g. "products", "customers").
 * Call sites may pass either the namespace or a full cacheKey; both forms resolve
 * to the same registry so store-scoped cached reads cannot outlive their writes.
 * Redis has no prefix-DEL, so a small registry set tracks the keys per prefix.
 */
export async function cacheBust(keyOrNamespace: string): Promise<void> {
  const r = redisClient();
  const prefix = keyOrNamespace.split(":")[0] ?? keyOrNamespace;
  const registryKey = `__reg:${prefix}`;
  const members = (await r.get<string[]>(registryKey)) ?? [];
  if (members.length > 0) {
    await r.del([...members, registryKey]);
  }
}

/** Builds a namespaced key: `${part[0]}:${part[1]}:...` — always start with the entry kind. */
export function cacheKey(...parts: string[]): string {
  return parts.join(":");
}

// Rate limiter for the PUBLIC/auth surface (Module 2) — backed by managed Redis
// (R3) when REDIS_URL is configured, in-process sliding window Map otherwise.
// A per-key counter with TTL (fixed window), store-scoped where a store is known,
// keyed by IP otherwise. Protects registration, login, checkout, cart mutation,
// public store lookup, and claim endpoints from brute-force / abuse.
//
// With Redis, the window is shared across every API instance (atomic INCR + EXPIRE).
// The in-process fallback is per-process and kept ONLY for envs without REDIS_URL.
// Intentionally NOT applied to the admin surface (staff dashboards) beyond auth.

import { redisClient, resetRedisForTest } from "../persistence/redis.js";

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  windowMs: number;
  /** Optional key prefix so different route groups get independent budgets. */
  prefix: string;
}

export { resetRedisForTest };

/**
 * Returns true when the request is allowed, false when it exceeds the budget.
 */
export async function rateLimitOk(key: string, opts: RateLimitOptions): Promise<boolean> {
  const fullKey = `rl:${opts.prefix}:${key}`;
  const count = await redisClient().incr(fullKey, opts.windowMs);
  return count <= opts.limit;
}

/** Build a request key from IP + (when present) store slug/token. */
export function clientKey(ip: string | undefined, extra?: string): string {
  const base = ip ?? "unknown";
  return extra ? `${base}:${extra}` : base;
}
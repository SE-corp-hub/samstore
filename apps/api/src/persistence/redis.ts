// Optional managed-Redis layer (R3): when REDIS_URL (Upstash rediss:// URL) is set
// the TTL cache and rate limiter run against real Redis; when it is absent or
// unreachable everything transparently falls back to the same in-process maps,
// so dev/test/lab environments never change behaviour.
//
// SECURITY: the URL + token live ONLY in the operator's .env (gitignored). This
// module never logs it and never accepts it from request input.

import { Redis } from "@upstash/redis";

export interface RedisLike {
  set(key: string, value: unknown, ttlMs?: number): Promise<unknown>;
  get<T = unknown>(key: string): Promise<T | null>;
  del(keys: string[]): Promise<number>;
  incr(key: string, ttlMs?: number): Promise<number>;
  ping(): Promise<string | null>;
}

// ── In-process fallback (used when REDIS_URL is empty or the call fails) ──────

class InProcessStore implements RedisLike {
  private readonly map = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  async set(key: string, value: unknown, ttlMs: number | undefined): Promise<unknown> {
    this.map.set(key, { value, expiresAt: Date.now() + (ttlMs ?? 0) });
    return "OK";
  }
  async get<T = unknown>(key: string): Promise<T | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt > 0 && Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return hit.value as T;
  }
  async del(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) n += this.map.delete(k) ? 1 : 0;
    return n;
  }
  async incr(key: string, ttlMs: number | undefined): Promise<number> {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || now >= c.resetAt) {
      this.counters.set(key, { count: 1, resetAt: now + (ttlMs ?? 0) });
      return 1;
    }
    c.count += 1;
    return c.count;
  }
  async ping(): Promise<string | null> {
    return "PONG";
  }
}

// ── Factory: real Redis when configured, in-process map otherwise ────────────

let client: RedisLike | null = null;
let initAttempted = false;
let usingRealRedis = false;

function parseRedisUrl(raw: string): { url: string; token: string } | null {
  // Upstash rediss:// URL:  rediss://default:<TOKEN>@<region>.upstash.io:443
  const m = raw.match(/^rediss?:\/\/default:([^@]+)@(.+)$/) ?? raw.match(/^rediss?:\/\/([^@]+)@(.+)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { url: `https://${m[2]}`, token: m[1] };
}

function buildClient(): RedisLike {
  const raw = process.env.REDIS_URL?.trim();
  if (!raw) return new InProcessStore();
  const parsed = parseRedisUrl(raw);
  if (!parsed) {
    console.error("[sam-store] REDIS_URL format not recognised (expected rediss://default:<TOKEN>@host:443) — using in-process fallback");
    return new InProcessStore();
  }
  try {
    const r = new Redis({ url: parsed.url, token: parsed.token });
    void r.ping().catch(() => {});
    usingRealRedis = true;
    return {
      set: (k, v, ttl) => r.set(k, v, ttl ? { ex: Math.max(1, Math.round(ttl / 1000)) } : undefined),
      get: async (k) => r.get(k),
      del: async (keys) => (keys.length ? await r.del(...keys) : 0),
      incr: async (k, ttl) => {
        const n = await r.incr(k);
        if (ttl) void r.expire(k, Math.max(1, Math.round(ttl / 1000))).catch(() => {});
        return n;
      },
      ping: async () => r.ping(),
    };
  } catch (_e) {
    console.error("[sam-store] Could not initialise Redis client — using in-process fallback");
    return new InProcessStore();
  }
}

/** Shared client. Call once at bootstrap to pre-warm (optional). */
export function redisClient(): RedisLike {
  if (!initAttempted) {
    initAttempted = true;
    client = buildClient();
  }
  return client as RedisLike;
}

export function isRedisConfigured(): boolean {
  redisClient();
  return usingRealRedis;
}

/** Test hook: forces the in-process store (so tests never touch real Redis). */
export function resetRedisForTest(): void {
  initAttempted = false;
  client = null;
  usingRealRedis = false;
}
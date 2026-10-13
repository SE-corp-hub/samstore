// Short-TTL cache for the per-request membership lookup.
//
// Why: every authenticated request paid this query twice — once in JwtAuthGuard
// (suspended-store check) and again in resolveTenant (active-membership resolution) —
// and each round-trip to the managed pooler costs ~300 ms. One cache entry per user
// serves both, cutting ~1–2 round-trips from every admin call.
//
// Staleness: 10 s, operator-approved. A membership deactivated or suspended on another
// replica may keep working for up to 10 s; every membership/store write path busts the
// cache anyway, so the window is only hit when the write happens in another process.
// Do not raise the TTL: these rows are authorization input.

import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheGet, cacheKey, cacheSet } from "../persistence/ttl-cache.js";

export interface CachedMembership {
  storeId: string;
  role: string;
  storeStatus: string;
}

const PREFIX = "memberships";
const TTL_MS = 10_000;

/** Active memberships for a user, with their store's status — cached for 10 s. */
export async function getMemberships(userId: string): Promise<CachedMembership[]> {
  const key = cacheKey(PREFIX, userId);
  const hit = await cacheGet<CachedMembership[]>(key);
  if (hit) return hit;

  const rows = await prisma.userStore.findMany({
    where: { userId, status: "ACTIVE" },
    select: { storeId: true, role: true, store: { select: { status: true } } },
  });
  const value: CachedMembership[] = rows.map((m) => ({ storeId: m.storeId, role: m.role, storeStatus: m.store.status }));
  await cacheSet(key, value, TTL_MS);
  return value;
}

/**
 * Drop cached memberships. Called from every write that changes a membership or a
 * store's status. The cache is keyed by user, so a store-level change clears the whole
 * namespace — writes are rare and the next read re-populates in one query.
 */
export async function bustMemberships(): Promise<void> {
  await cacheBust(PREFIX);
}

/** Convenience for tests and callers that think in stores. */
export const bustMembershipsForStore = bustMemberships;

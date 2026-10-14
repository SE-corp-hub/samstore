// Rice Ops M2 — token version: bumping User.tokenVersion signs that person out on
// every phone (a new PIN set by the owner, a lost phone). Tokens carry `tv`; the
// guard compares it with the stored value, cached 10 s like memberships (same
// staleness contract, see membership-cache.ts). Tokens issued before M2 have no
// `tv` and count as version 0.

import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheGet, cacheKey, cacheSet } from "../persistence/ttl-cache.js";

const PREFIX = "tokenver";
const TTL_MS = 10_000;

export async function getTokenVersion(userId: string): Promise<number | null> {
  const key = cacheKey(PREFIX, userId);
  const hit = await cacheGet<{ v: number | null }>(key);
  if (hit) return hit.v;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } });
  const v = u ? u.tokenVersion : null;
  await cacheSet(key, { v }, TTL_MS);
  return v;
}

export async function bustTokenVersion(_userId?: string): Promise<void> {
  await cacheBust(PREFIX);
}

/**
 * True when the token's version is current. An unknown user (null) is left to the
 * existing checks — the guard behaved that way before M2 and tests sign synthetic ids.
 */
export function tokenVersionCurrent(tokenTv: number | undefined, stored: number | null): boolean {
  if (stored === null) return true;
  return (tokenTv ?? 0) === stored;
}

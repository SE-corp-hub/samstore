// Per-store build, step 2 — where a store may take rice from.
//
// Every place can carry an ordered list (`Warehouse.sourceLocationIds`): its own shelf first, then
// the other places it may take rice from, in order. Bogs and Lucy: Bahay Tindahan, then Bodega.
// Bahay Tindahan: Bodega. Lipa: its own shelf only.
//
//   * No list saved yet → no rule: any shelf may be used, as before this step.
//   * A saved list always starts with the place itself, so "own shelf only" is a list of one.
//   * A place on the list that was switched off (or deleted) is skipped.

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** The saved list, cleaned: the place itself first, no repeats. Empty in = empty out (no rule). */
export function normalizeSources(selfId: string, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return [selfId, ...new Set(ids.filter((id) => id && id !== selfId))];
}

/**
 * The shelves `locationId` may sell from, in order (itself first), or null when it has no rule yet.
 * Shelves that are switched off are left out.
 */
export async function shelvesFor(db: Db, storeId: string, locationId: string | null | undefined): Promise<string[] | null> {
  if (!locationId) return null;
  const loc = await db.warehouse.findFirst({ where: { id: locationId, storeId }, select: { sourceLocationIds: true } });
  if (!loc || loc.sourceLocationIds.length === 0) return null;
  const list = normalizeSources(locationId, loc.sourceLocationIds);
  const active = new Set((await db.warehouse.findMany({ where: { storeId, id: { in: list }, isActive: true }, select: { id: true } })).map((w) => w.id));
  return list.filter((id) => id === locationId || active.has(id));
}

/** A Facebook Page link as the owner may type or paste it, cleaned; null for empty; throws on anything else. */
export function cleanFacebookPageUrl(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new Error("That Facebook Page link does not look right. Copy it from the Page, like facebook.com/yourpage");
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|web|business)\./, "");
  if (host !== "facebook.com" && host !== "fb.com" && host !== "fb.me") throw new Error("The Page link must be a facebook.com link");
  if (url.pathname.replace(/\/+$/, "") === "") throw new Error("Paste the link of the Page itself, like facebook.com/yourpage");
  // Keep only what names the Page: the path, and the id of a profile.php link.
  const id = url.searchParams.get("id");
  const clean = `https://www.facebook.com${url.pathname.replace(/\/+$/, "")}${url.pathname.startsWith("/profile.php") && id ? `?id=${encodeURIComponent(id)}` : ""}`;
  if (clean.length > 200) throw new Error("That Facebook Page link is too long");
  return clean;
}

/**
 * What can still be sold of each product by `locationId` (the main store when null): the free stock on
 * the shelves its rule allows. Null when that store has no rule yet (the caller keeps its old count).
 */
export async function freeOnShelves(db: Db, storeId: string, locationId: string | null | undefined): Promise<Map<string, number> | null> {
  const at = locationId ?? (await db.warehouse.findFirst({ where: { storeId, isDefault: true, isActive: true }, select: { id: true } }))?.id ?? null;
  const shelves = await shelvesFor(db, storeId, at);
  if (!shelves) return null;
  const levels = await db.stockLevel.findMany({ where: { storeId, warehouseId: { in: shelves } }, select: { productId: true, quantityOnHand: true, quantityReserved: true } });
  const free = new Map<string, number>();
  for (const l of levels) free.set(l.productId, (free.get(l.productId) ?? 0) + Math.max(0, l.quantityOnHand - l.quantityReserved));
  return free;
}

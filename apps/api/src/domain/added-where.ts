// 2026-11-21 (owner's ask: a new customer or item made in POS or Pre-order should show the store it was made at).
// Every place that makes a customer (StoreCustomer) or an item (Product) passes one `AddedWhere`; the row keeps
// the store (Warehouse.id), who made it, and the screen. A row made before this has none of it ("Unknown").
import { prisma } from "../persistence/prisma-repositories.js";
import { locationRefusal, type Actor } from "../people/people.service.js";

/** The screen a customer or an item was made on. Stored as text so an old app version can never break a save. */
export const ADDED_VIA = ["POS", "PREORDER", "STOCK_IN", "CREDIT", "CUSTOMERS", "PRODUCTS", "AGENT", "IMPORT", "ONLINE", "KILO", "COUNTER"] as const;
export type AddedVia = (typeof ADDED_VIA)[number];

export interface AddedWhere {
  /** The store (Warehouse.id) it was made at; null = not at a store (e.g. the owner on the Customers screen). */
  locationId: string | null;
  userId: string | null;
  via: AddedVia;
}

/** The columns for a new StoreCustomer. */
export const customerAdded = (w: AddedWhere | null | undefined) =>
  w ? { addedAtId: w.locationId, addedById: w.userId, addedVia: w.via } : {};

/** The columns for a new Product (who made it is Product.createdById). */
export const productAdded = (w: AddedWhere | null | undefined) =>
  w ? { addedAtId: w.locationId, addedVia: w.via, ...(w.userId ? { createdById: w.userId } : {}) } : {};

/**
 * The store a screen says it is at, checked: one of this business's stores that this login may work at.
 * Anything else (missing, another business's, not allowed) falls back to the login's own store, never to the
 * main store: a wrong store is worse than "not known".
 */
export async function addedAtStore(storeId: string, actor: Actor, locationId: string | null | undefined): Promise<string | null> {
  if (locationId && !locationRefusal(actor, locationId)) {
    const ok = await prisma.warehouse.findFirst({ where: { id: locationId, storeId }, select: { id: true } });
    if (ok) return ok.id;
  }
  return actor.homeLocationId ?? null;
}

/** The counter screens that may make a "New item" (POST /admin/benta/manual-item); anything else counts as POS. */
export const counterItemVia = (v: unknown): AddedVia => (v === "PREORDER" || v === "STOCK_IN" ? v : "POS");

/** What a list shows about where a row was made. Empty `via` = made before 2026-11-21 ("Unknown"). */
export interface AddedTag {
  /** The store it was made at, or null when not at a store / not known. */
  addedAt: { id: string; name: string } | null;
  addedVia: string | null;
  /** The person's name (or their login's label), or null. */
  addedBy: string | null;
}

/**
 * The names behind many rows' `addedAtId` + who made them, read in two queries. Returns a function that gives one
 * row's tag. A store or person that no longer exists shows no name rather than an id.
 */
export async function addedTagReader(storeId: string, rows: { addedAtId?: string | null; addedById?: string | null }[]): Promise<(r: { addedAtId?: string | null; addedById?: string | null; addedVia?: string | null }) => AddedTag> {
  const placeIds = [...new Set(rows.map((r) => r.addedAtId).filter((x): x is string => !!x))];
  const userIds = [...new Set(rows.map((r) => r.addedById).filter((x): x is string => !!x))];
  const [places, users] = await Promise.all([
    placeIds.length ? prisma.warehouse.findMany({ where: { storeId, id: { in: placeIds } }, select: { id: true, name: true } }) : [],
    userIds.length ? prisma.userStore.findMany({ where: { storeId, userId: { in: userIds } }, select: { userId: true, readyLabel: true, user: { select: { name: true } } } }) : [],
  ]);
  const placeName = new Map(places.map((p) => [p.id, p.name]));
  const userName = new Map(users.map((u) => [u.userId, u.user?.name?.trim() || u.readyLabel?.trim() || null]));
  return (r) => ({
    addedAt: r.addedAtId && placeName.has(r.addedAtId) ? { id: r.addedAtId, name: placeName.get(r.addedAtId)! } : null,
    addedVia: r.addedVia ?? null,
    addedBy: r.addedById ? userName.get(r.addedById) ?? null : null,
  });
}

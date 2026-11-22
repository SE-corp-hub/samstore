// The wall — a login tied to one store reads and changes only that store.
// Per-store build, step 6.
//
// Who is behind the wall: every login but the owner (2026-11-22, owner's ask: "every feature
// filtered by the location of the login"). A manager or counter login is walled to its home store; a
// manager or counter login with NO home store is walled to no store at all (it sees no store's orders
// until the owner chooses its store in Team). Only the owner (and the platform) sees everything.
//
// Counter logins (not the owner or a manager) are also refused every "owner-only" rule below; a
// walled manager is refused the ones not marked `managerMay` (the whole business's numbers, supplier
// money, business-wide settings).
//
// How it works: the wall interceptor (wall.interceptor.ts) works the wall out once per request and
// runs the request inside it. Code that lists orders adds `orderWall()` to its filter; outside a
// request (jobs, tests) there is no wall and the filter is empty.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { ALL_LOCATION_ROLES, STORE_BOUND_ROLES } from "../domain/people.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { loadActor } from "../people/people.service.js";
import { mainLocationId, ordersOfStore } from "../reports/sales-book.js";

export interface Wall {
  /** The one store this login may read. */
  locationId: string;
  mainId: string | null;
  /** Orders of that store (for the main store: also the old orders that name no store). */
  orders: Prisma.OrderWhereInput;
}

const als = new AsyncLocalStorage<Wall | null>();

/** The wall of the request that is running, or null (owner, an agent with no store, or not in a request). */
export const currentWall = (): Wall | null => als.getStore() ?? null;
/** Run `fn` behind a wall (the interceptor and the tests use this). */
export const runWithWall = <T>(wall: Wall | null, fn: () => T): T => als.run(wall, fn);
/** Add to an order filter as `AND: [orderWall()]`. Empty when there is no wall. */
export const orderWall = (): Prisma.OrderWhereInput => currentWall()?.orders ?? {};
/** For cache keys: two logins behind different walls must never share a saved answer. */
export const wallKey = (): string => currentWall()?.locationId ?? "";

const mainCache = new Map<string, { id: string | null; at: number }>();
async function mainOf(storeId: string): Promise<string | null> {
  const hit = mainCache.get(storeId);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const id = await mainLocationId(prisma, storeId);
  mainCache.set(storeId, { id, at: Date.now() });
  return id;
}

export function wallAt(locationId: string, mainId: string | null): Wall {
  return { locationId, mainId, orders: ordersOfStore(locationId, mainId) };
}

/** A location id no store has: the wall of a manager or counter login that has no store yet. */
export const NO_STORE_WALL = "__no_store__";

/** The wall for a login in a business, or null when it sees everything (the owner, or an agent/delivery login with no store). */
export async function wallFor(storeId: string, userId: string, role: string): Promise<Wall | null> {
  if ((ALL_LOCATION_ROLES as readonly string[]).includes(role)) return null;
  const actor = await loadActor(storeId, userId, role);
  if ((ALL_LOCATION_ROLES as readonly string[]).includes(actor.role)) return null;
  if (!actor.homeLocationId) {
    if (!(STORE_BOUND_ROLES as readonly string[]).includes(actor.role)) return null;
    // A manager or counter login with no store yet sees no store, unless the business has no stores set up at all.
    const places = await prisma.warehouse.count({ where: { storeId, isActive: true } });
    return places > 0 ? { locationId: NO_STORE_WALL, mainId: null, orders: { id: NO_STORE_WALL } } : null;
  }
  return wallAt(actor.homeLocationId, await mainOf(storeId));
}

/** A counter login: not the owner, a manager or the platform. These are refused the owner-only rules, home store or not. */
export async function isCounterLogin(storeId: string, userId: string, role: string): Promise<boolean> {
  if ((ALL_LOCATION_ROLES as readonly string[]).includes(role) || role === "MANAGER") return false;
  const actor = await loadActor(storeId, userId, role);
  return !(ALL_LOCATION_ROLES as readonly string[]).includes(actor.role) && actor.role !== "MANAGER";
}

/** Is this order inside the wall? (No wall: yes.) */
export async function orderInsideWall(storeId: string, orderId: string, wall: Wall | null = currentWall()): Promise<boolean> {
  if (!wall) return true;
  return !!(await prisma.order.findFirst({ where: { id: orderId, storeId, AND: [wall.orders] }, select: { id: true } }));
}

// ─────────────────────────────── the rules, in one table ───────────────────────────────

export type WallRule =
  /**
   * The whole business's numbers or settings: refused to counter logins and behind a wall.
   * `managerMay`: a walled manager may still call it (the route itself limits them to their store).
   */
  | { kind: "owner-only"; methods?: readonly string[]; path: RegExp; what: string; managerMay?: boolean }
  /** One order named in the address (`:id`): it must be the store's own. */
  | { kind: "own-order"; path: RegExp };

/** Matched against the route as written in the controllers, e.g. `/admin/orders/:id/status`. */
export const WALL_RULES: readonly WallRule[] = [
  { kind: "owner-only", path: /^\/admin\/reports\//, what: "The business reports" },
  { kind: "owner-only", path: /^\/admin\/analytics\/(summary|products|vouchers)$/, what: "The business numbers" },
  { kind: "owner-only", path: /^\/admin\/(purchases|suppliers)(\/|$)/, what: "Purchases" },
  // The open-order LIST stays readable (no costs, own store only, see PurchaseOrderController.list):
  // Stock in receives a delivery against it. Everything else about supplier orders is the owner's.
  { kind: "owner-only", path: /^\/admin\/purchase-orders\/.+/, what: "Supplier orders" },
  { kind: "owner-only", methods: ["POST", "PATCH", "PUT", "DELETE"], path: /^\/admin\/purchase-orders$/, what: "Supplier orders" },
  { kind: "owner-only", path: /^\/admin\/customers\/export\.csv$/, what: "The customer list download" },
  { kind: "owner-only", path: /^\/admin\/crm\//, what: "Customer messages" },
  { kind: "owner-only", path: /^\/admin\/export$/, what: "Export data" },
  { kind: "owner-only", path: /^\/admin\/rice\/weekly$/, what: "The weekly summary" },
  // Managers: add a rice, picture, reorder level (domain/product-edit-rights.ts decides what exactly).
  { kind: "owner-only", methods: ["POST", "PATCH", "PUT", "DELETE"], path: /^\/admin\/products(\/|$)/, what: "Changing products and main prices", managerMay: true },
  { kind: "owner-only", methods: ["POST", "PATCH", "PUT", "DELETE"], path: /^\/admin\/vouchers(\/|$)/, what: "Making and changing vouchers" },
  { kind: "owner-only", methods: ["POST", "PATCH", "PUT", "DELETE"], path: /^\/admin\/payment-methods(\/|$)/, what: "Changing payment methods" },
  { kind: "owner-only", methods: ["POST", "PATCH", "PUT", "DELETE"], path: /^\/admin\/delivery-zones(\/|$)/, what: "Changing delivery areas" },
  { kind: "owner-only", methods: ["PATCH"], path: /^\/admin\/customers\/:id\/approval$/, what: "Approving customers", managerMay: true },
  // 2026-11-22: the business settings and the store-to-store money are the owner's (a manager runs one store).
  { kind: "owner-only", path: /^\/admin\/payable(\/|$)/, what: "The money between stores" },
  { kind: "own-order", path: /^\/admin\/orders\/:id(\/|$)/ },
  { kind: "own-order", path: /^\/admin\/pos\/(holds|preorders|sells)\/:id(\/|$)/ },
];

export type WallVerdict = { ok: true } | { ok: false; status: 403 | 404; message: string };

/**
 * What the wall says about one request. Pure but for the one order lookup, so it is easy to test.
 * `counter`: a counter login (see isCounterLogin). Every walled login is one; a counter login with no
 * home store has no wall but is still refused the owner-only rules.
 */
export async function checkWall(wall: Wall | null, storeId: string, method: string, routePath: string, params: Record<string, string | undefined>, counter = wall !== null): Promise<WallVerdict> {
  if (!wall && !counter) return { ok: true };
  for (const rule of WALL_RULES) {
    if (!rule.path.test(routePath)) continue;
    if (rule.kind === "owner-only") {
      if (rule.methods && !rule.methods.includes(method.toUpperCase())) continue;
      if (rule.managerMay && !counter) continue; // a walled manager
      return { ok: false, status: 403, message: `${rule.what}: this is for the owner.` };
    }
    if (!wall) continue;
    const id = params.id;
    if (id && !(await orderInsideWall(storeId, id, wall))) return { ok: false, status: 404, message: "Order not found" };
  }
  return { ok: true };
}

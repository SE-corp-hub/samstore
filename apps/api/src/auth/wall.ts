// The wall — a login tied to one store reads and changes only that store.
// Per-store build, step 6.
//
// Who is behind the wall: a login that is not the owner or a manager AND has a home store
// (`UserStore.homeLocationId`). The owner, a manager and a login with no home store see everything,
// as before.
//
// How it works: the wall interceptor (wall.interceptor.ts) works the wall out once per request and
// runs the request inside it. Code that lists orders adds `orderWall()` to its filter; outside a
// request (jobs, tests) there is no wall and the filter is empty.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { ALL_LOCATION_ROLES } from "../domain/people.js";
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

/** The wall of the request that is running, or null (owner, manager, no home store, or not in a request). */
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

/** The wall for a login in a business, or null when it sees everything. */
export async function wallFor(storeId: string, userId: string, role: string): Promise<Wall | null> {
  if ((ALL_LOCATION_ROLES as readonly string[]).includes(role)) return null;
  const actor = await loadActor(storeId, userId, role);
  if ((ALL_LOCATION_ROLES as readonly string[]).includes(actor.role) || !actor.homeLocationId) return null;
  return wallAt(actor.homeLocationId, await mainOf(storeId));
}

/** Is this order inside the wall? (No wall: yes.) */
export async function orderInsideWall(storeId: string, orderId: string, wall: Wall | null = currentWall()): Promise<boolean> {
  if (!wall) return true;
  return !!(await prisma.order.findFirst({ where: { id: orderId, storeId, AND: [wall.orders] }, select: { id: true } }));
}

// ─────────────────────────────── the rules, in one table ───────────────────────────────

export type WallRule =
  /** The whole business's numbers or settings: refused behind a wall. */
  | { kind: "owner-only"; methods?: readonly string[]; path: RegExp; what: string }
  /** One order named in the address (`:id`): it must be the store's own. */
  | { kind: "own-order"; path: RegExp };

/** Matched against the route as written in the controllers, e.g. `/admin/orders/:id/status`. */
export const WALL_RULES: readonly WallRule[] = [
  { kind: "owner-only", path: /^\/admin\/reports\//, what: "The business reports" },
  { kind: "owner-only", path: /^\/admin\/analytics\/(summary|products|vouchers)$/, what: "The business numbers" },
  { kind: "owner-only", path: /^\/admin\/(purchases|suppliers)(\/|$)/, what: "Purchases" },
  { kind: "owner-only", path: /^\/admin\/purchase-orders(\/|$)/, what: "Supplier orders" },
  { kind: "owner-only", path: /^\/admin\/customers\/export\.csv$/, what: "The customer list download" },
  { kind: "owner-only", path: /^\/admin\/crm\//, what: "Customer messages" },
  { kind: "owner-only", path: /^\/admin\/export$/, what: "Export data" },
  { kind: "owner-only", path: /^\/admin\/rice\/weekly$/, what: "The weekly summary" },
  { kind: "owner-only", methods: ["POST", "PATCH", "PUT", "DELETE"], path: /^\/admin\/products(\/|$)/, what: "Changing products and main prices" },
  { kind: "own-order", path: /^\/admin\/orders\/:id(\/|$)/ },
  { kind: "own-order", path: /^\/admin\/pos\/(holds|preorders|sells)\/:id(\/|$)/ },
];

export type WallVerdict = { ok: true } | { ok: false; status: 403 | 404; message: string };

/** What the wall says about one request. Pure but for the one order lookup, so it is easy to test. */
export async function checkWall(wall: Wall | null, storeId: string, method: string, routePath: string, params: Record<string, string | undefined>): Promise<WallVerdict> {
  if (!wall) return { ok: true };
  for (const rule of WALL_RULES) {
    if (!rule.path.test(routePath)) continue;
    if (rule.kind === "owner-only") {
      if (rule.methods && !rule.methods.includes(method.toUpperCase())) continue;
      return { ok: false, status: 403, message: `${rule.what}: this is for the owner.` };
    }
    const id = params.id;
    if (id && !(await orderInsideWall(storeId, id, wall))) return { ok: false, status: 404, message: "Order not found" };
  }
  return { ok: true };
}

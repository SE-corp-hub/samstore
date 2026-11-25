// Truck stock from SE Corp Hub. An Agent + Delivery sells from a truck: the hub keeps the truck's sheet (what was
// loaded, sold, given away, and what came back), and offers us two kinds of moves on our usual beat
// (integrations/hub-orders.service.ts) so this store's stock follows the truck:
//
//   load   the agent confirmed a load: the sacks leave the store's shelf for the truck's own place.
//   close  the day was counted and closed: the good sacks counted go back to the store's shelf, and the rest of
//          what was loaded (sold, given as a sample, damaged, missing) is taken off the truck, with why.
//
// The truck's place is a location of its own ("Truck: Ric"), made here the first time a load for it arrives and
// marked for the owner to check. Stock only: a truck sale is not a sale here yet; it stays in the hub.
//
// Each move is done once: its stock rows carry the hub's own id for it, and a move offered again is left alone.

import type { PrismaClient } from "@prisma/client";
import { mainLocation } from "../domain/main-store.js";
import { adjustStock, InsufficientStockError, transferStock } from "../domain/movements.js";

export interface TruckItem {
  name: string;
  quantity: number;
}

/** One move as the hub offers it. `location`: the code of the store location the truck loads from (else the main store). */
export interface HubTruckMove {
  id: number;
  kind: "load" | "close";
  truck: string;
  location?: string;
  day?: string;
  items: TruckItem[];
  back: TruckItem[];
  out: (TruckItem & { why: string })[];
}

/** Does one move for a store: null when done (or already done), else why not, in words staff read in the hub. */
export type HubTruckApplier = (storeId: string, move: HubTruckMove) => Promise<string | null>;

/** The document name on every stock row a truck move writes. */
export const TRUCK_DOC = "HUB_TRUCK";
/** Who the stock book says took sacks off a truck: the hub, not a login here. */
const HUB_ACTOR = "se-corp-hub";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function items(raw: unknown): (TruckItem & { why?: string })[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const out: (TruckItem & { why?: string })[] = [];
  for (const r of raw) {
    const x = (r ?? {}) as Record<string, unknown>;
    const name = typeof x.name === "string" ? x.name.trim().slice(0, 160) : "";
    if (!name || typeof x.quantity !== "number" || !Number.isSafeInteger(x.quantity) || x.quantity <= 0 || x.quantity > 100_000) return null;
    out.push({ name, quantity: x.quantity, ...(typeof x.why === "string" ? { why: x.why.trim().slice(0, 200) } : {}) });
  }
  return out;
}

/** A move as the hub sent it, checked: the store's slug and the move, or null when it can't be read. */
export function readTruckMove(raw: unknown): { store: string; move: HubTruckMove } | null {
  const x = (raw ?? {}) as Record<string, unknown>;
  const list = items(x.items);
  const back = items(x.back);
  const out = items(x.out);
  if (typeof x.id !== "number" || !Number.isSafeInteger(x.id) || x.id <= 0) return null;
  if (typeof x.store !== "string" || !x.store.trim() || typeof x.truck !== "string" || !x.truck.trim()) return null;
  if ((x.kind !== "load" && x.kind !== "close") || !list || !back || !out) return null;
  if (x.kind === "load" && list.length === 0) return null;
  return {
    store: x.store.trim().slice(0, 120),
    move: {
      id: x.id,
      kind: x.kind,
      truck: x.truck.trim().slice(0, 60),
      ...(typeof x.location === "string" && x.location.trim() ? { location: x.location.trim().slice(0, 20) } : {}),
      ...(typeof x.day === "string" ? { day: x.day.slice(0, 10) } : {}),
      items: list.map(({ name, quantity }) => ({ name, quantity })),
      back: back.map(({ name, quantity }) => ({ name, quantity })),
      out: out.map((o) => ({ name: o.name, quantity: o.quantity, why: o.why ?? "" })),
    },
  };
}

class Refused extends Error {}

/** Moves a truck's sacks in this store's stock, against the real database. */
export function hubTruckApplier(db: PrismaClient): HubTruckApplier {
  return async (storeId, move) => {
    const documentId = `${move.kind}:${move.id}`;
    const home = move.location
      ? await db.warehouse.findFirst({ where: { storeId, code: { equals: move.location, mode: "insensitive" }, isActive: true }, select: { id: true, name: true } })
      : await mainLocation(db, storeId);
    if (!home) return move.location ? `Sam Store has no open location with the code ${move.location}` : "Sam Store has no main store yet";

    // Items by their exact name (capitals and spacing aside), as the hub copied them from here.
    const products = await db.product.findMany({ where: { storeId, mergedIntoId: null }, select: { id: true, name: true } });
    const find = (name: string) => products.find((p) => norm(p.name) === norm(name));
    const all = [...move.items, ...move.back, ...move.out];
    const unknown = [...new Set(all.filter((i) => !find(i.name)).map((i) => i.name))];
    if (unknown.length) return `${unknown.map((n) => `"${n}"`).join(", ")} ${unknown.length === 1 ? "is not an item" : "are not items"} in this Sam Store`;
    const idOf = (name: string) => find(name)!.id;
    const nameOf = (productId: string) => products.find((p) => p.id === productId)?.name ?? "an item";
    const where = `${move.truck}${move.day ? `, ${move.day}` : ""} (SE Corp Hub)`;

    try {
      await db.$transaction(async (tx) => {
        // Done before? The hub offers a move again until it hears our answer.
        if (await tx.stockMovement.findFirst({ where: { storeId, documentType: TRUCK_DOC, documentId }, select: { id: true } })) return;
        let truck = await tx.warehouse.findFirst({ where: { storeId, name: move.truck }, select: { id: true, isActive: true } });
        if (!truck && move.kind === "close") throw new Refused(`Sam Store has no location named ${move.truck}`);
        // A truck holds stock and does not sell at a counter. The owner sees it under Locations, marked to check.
        truck ??= await tx.warehouse.create({ data: { storeId, name: move.truck, type: "WAREHOUSE", needsReview: true }, select: { id: true, isActive: true } });
        if (!truck.isActive) throw new Refused(`${move.truck} is turned off in Sam Store (Menu → Locations). Turn it on to move its sacks`);
        if (truck.id === home.id) throw new Refused(`${move.truck} is the store's own location in Sam Store`);
        const doc = { storeId, actorId: null, documentType: TRUCK_DOC, documentId };
        for (const i of move.items) {
          await transferStock(tx, { ...doc, productId: idOf(i.name), fromWarehouseId: home.id, toWarehouseId: truck.id, quantity: i.quantity, note: `Load out to ${where}` });
        }
        for (const i of move.back) {
          await transferStock(tx, { ...doc, productId: idOf(i.name), fromWarehouseId: truck.id, toWarehouseId: home.id, quantity: i.quantity, note: `Back from ${where}` });
        }
        for (const i of move.out) {
          await adjustStock(tx, { storeId, productId: idOf(i.name), warehouseId: truck.id, delta: -i.quantity, reason: `${where}: ${i.why || "off the truck"}`.slice(0, 300), actorId: HUB_ACTOR, documentType: TRUCK_DOC, documentId });
        }
      });
    } catch (e) {
      if (e instanceof Refused) return e.message;
      if (e instanceof InsufficientStockError) {
        const at = move.kind === "load" ? `at ${home.name}` : `on ${move.truck}`;
        return `Not enough "${nameOf(e.productId)}" ${at} in Sam Store: short by ${e.shortfall}`;
      }
      throw e;
    }
    return null;
  };
}

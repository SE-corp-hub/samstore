// The main store (Bogs and Lucy): the one place in the app that finds it.
//
// The main store owns all the stock, and an old order or request that names no store is its own.
// Everything that needs "the main store" asks here instead of writing its own look-up, so there is
// one rule: the location marked main (Warehouse.isDefault). Menu → Locations can move the mark, and
// a main store cannot be turned off (warehouse.service.ts), so the mark always points at an open store.
//
// Use it only as the fallback for a request that names no store (an old copy of the app, the offline
// queue, a job). A screen that changes stock must say which store; see store-separate.test.ts.

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** The main store's location id (null only for a very old business with no locations yet). */
export async function mainLocationId(db: Db, storeId: string): Promise<string | null> {
  return (await db.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } }))?.id ?? null;
}

/** The main store's id and name. */
export async function mainLocation(db: Db, storeId: string): Promise<{ id: string; name: string } | null> {
  return db.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true, name: true } });
}

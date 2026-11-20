// Each store's own switches (2026-11-20, "This store" in Settings).
//
// Three switches used to be one for the whole business (StoreSettings). Now each location may
// have its own value on its Warehouse row; an empty value (null) follows the business setting,
// so a store nobody has touched yet works exactly as before.
//   dayOpenClose      Open day + Close day (Z-read) on POS
//   requireOpenShift  Open the cash drawer before taking cash (only used while Z-read is off)
//   hidePricePreOrder Pre-order screen shows only the total

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface StoreSwitches {
  dayOpenClose: boolean;
  requireOpenShift: boolean;
  hidePricePreOrder: boolean;
}

export const SWITCH_KEYS = ["dayOpenClose", "requireOpenShift", "hidePricePreOrder"] as const;

type Row = { dayOpenClose: boolean | null; requireOpenShift: boolean | null; hidePricePreOrder: boolean | null };

/** The store's own value where it has one, else the business's. */
export function mergeSwitches(business: Partial<StoreSwitches> | null | undefined, own: Partial<Row> | null | undefined): StoreSwitches {
  return {
    dayOpenClose: own?.dayOpenClose ?? business?.dayOpenClose ?? false,
    requireOpenShift: own?.requireOpenShift ?? business?.requireOpenShift ?? false,
    hidePricePreOrder: own?.hidePricePreOrder ?? business?.hidePricePreOrder ?? false,
  };
}

async function businessSwitches(db: Db, storeId: string) {
  return db.storeSettings.findUnique({ where: { storeId }, select: { dayOpenClose: true, requireOpenShift: true, hidePricePreOrder: true } });
}

/** The switches of one location (no location: the business's own). */
export async function switchesAt(db: Db, storeId: string, locationId?: string | null): Promise<StoreSwitches> {
  const [business, own] = await Promise.all([
    businessSwitches(db, storeId),
    locationId ? db.warehouse.findFirst({ where: { id: locationId, storeId }, select: { dayOpenClose: true, requireOpenShift: true, hidePricePreOrder: true } }) : null,
  ]);
  return mergeSwitches(business, own);
}

/** Every active location's switches, by location id. */
export async function switchesOfAll(db: Db, storeId: string): Promise<Map<string, StoreSwitches & { name: string }>> {
  const [business, rows] = await Promise.all([
    businessSwitches(db, storeId),
    db.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true, dayOpenClose: true, requireOpenShift: true, hidePricePreOrder: true } }),
  ]);
  return new Map(rows.map((r) => [r.id, { ...mergeSwitches(business, r), name: r.name }]));
}

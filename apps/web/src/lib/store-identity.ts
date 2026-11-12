// Per-store build, step 9 — what a store calls itself on this tablet: its receipt name and text and
// its daily target. Read from the copy of the Locations list kept on the tablet, so receipts printed
// offline carry the right store too. Empty fields mean "use the business's" (Settings / this tablet's printer text).

import { getHomeLocation } from "./admin";
import { savedCopy } from "./offlineCache";

export interface PlaceIdentity {
  id: string; name: string;
  receiptName?: string | null; receiptHeader?: string | null; receiptFooter?: string | null; receiptContact?: string | null;
  dailySalesTargetMinor?: number | null;
}

export const PLACES_PATH = "/admin/warehouses";

/** The store a slip or a target is for: the one named, else the login's own store. Null: no store known (the owner, no store chosen). */
export function placeIdentity(locationId?: string | null): PlaceIdentity | null {
  const id = locationId || getHomeLocation();
  if (!id) return null;
  const places = savedCopy<{ warehouses?: PlaceIdentity[] }>(PLACES_PATH)?.warehouses;
  return (Array.isArray(places) ? places.find((p) => p.id === id) : null) ?? null;
}

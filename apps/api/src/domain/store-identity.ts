// Per-store build, step 9 — what a store calls itself: the name and text on its receipts, its daily
// sales target and the start of its order numbers. Each is the place's own value when the owner set
// one (Menu → Locations), else the business's (Settings), so nothing changes until the owner fills it in.

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = Pick<PrismaClient | Prisma.TransactionClient, "warehouse">;

export const IDENTITY_LIMITS = { receiptName: 60, receiptHeader: 120, receiptFooter: 120, receiptContact: 60, orderPrefix: 6 } as const;
export const MAX_DAILY_TARGET_MINOR = 100_000_000_00;

/** A place's own text, trimmed; empty means "use the business's". Too long: null with a reason. */
export function cleanIdentityText(field: keyof typeof IDENTITY_LIMITS, raw: string | null): { ok: true; value: string | null } | { ok: false; message: string } {
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return { ok: true, value: null };
  if (field === "orderPrefix") {
    const prefix = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (prefix.length < 2 || prefix.length > IDENTITY_LIMITS.orderPrefix) return { ok: false, message: "The start of the order number is 2 to 6 letters or numbers, like LIPA" };
    return { ok: true, value: prefix };
  }
  if (text.length > IDENTITY_LIMITS[field]) return { ok: false, message: `That text is too long (at most ${IDENTITY_LIMITS[field]} letters)` };
  return { ok: true, value: text };
}

/** The start of the order number for a sale at this place: the place's own, else the business's. */
export async function orderPrefixAt(db: Db, storeId: string, locationId: string | null | undefined, businessPrefix: string | null | undefined): Promise<string | undefined> {
  if (locationId) {
    const own = (await db.warehouse.findFirst({ where: { id: locationId, storeId }, select: { orderPrefix: true } }))?.orderPrefix;
    if (own) return own;
  }
  return businessPrefix ?? undefined;
}

// One change at a time per order. A refund, a void, a cancelled pre-order or a change of items reads the
// order, then gives money or rice back. Two taps at once (a double tap, a slow line and a retry, the
// offline queue sending again, two people on two tablets) would both read "not cancelled yet" and both
// give it back. Locking the order's row first makes the second one wait, then see what the first did.

import type { Prisma } from "@prisma/client";

export type LockedOrder = { status: string; paymentStatus: string; source: string };

/** Lock the order's row for the rest of the transaction and read it again. Null when it is not in this store. */
export async function lockOrder(tx: Prisma.TransactionClient, storeId: string, orderId: string): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT "status"::text AS "status", "paymentStatus"::text AS "paymentStatus", "source"
      FROM "Order" WHERE "id" = ${orderId} AND "storeId" = ${storeId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Thrown inside a transaction when the locked order shows the step was already done: the caller answers with it. */
export class OrderChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderChanged";
  }
}

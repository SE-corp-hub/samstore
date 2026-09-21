// P3j: abandoned-cart recovery — mark expired OPEN carts ABANDONED and enqueue a
// follow-up side effect (cart.abandoned) through the transactional outbox.
// The plan calls this the "cart expiry job"; a scheduler/cron should POST the admin
// endpoint (e.g. daily). Carts carry their own expiresAt (7-day TTL at creation).

import { prisma } from "../persistence/prisma-repositories.js";
import { enqueueOutboxEvent } from "../notifications/outbox.service.js";
import type { ApiError } from "@sam-store/contracts";

export type RecoveryResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export class CartRecoveryService {
  /**
   * Find OPEN carts for the store that have expired, mark them ABANDONED, and
   * enqueue a cart.abandoned event per cart (for the follow-up campaign worker).
   * Idempotent: already-ABANDONED/CONVERTED/EXPIRED carts are never re-marked.
   */
  async expireAbandoned(storeId: string): Promise<{ expired: number; enqueued: number }> {
    const now = new Date();
    const candidates = await prisma.cart.findMany({
      where: {
        storeId,
        status: "OPEN",
        expiresAt: { not: null, lt: now },
        items: { some: {} }, // only carts with content matter
      },
      select: {
        id: true,
        token: true,
        customerId: true,
        items: { select: { quantity: true } },
      },
      orderBy: { expiresAt: "asc" },
      take: 500,
    });

    let expired = 0;
    let enqueued = 0;
    for (const cart of candidates) {
      const itemCount = cart.items.reduce((s, i) => s + i.quantity, 0);
      const flipped = await prisma.$transaction(async (tx) => {
        const updated = await tx.cart.updateMany({
          where: { id: cart.id, status: "OPEN" }, // guard: only flip OPEN carts
          data: { status: "ABANDONED" },
        });
        if (updated.count === 0) return false; // someone converted it meanwhile
        await enqueueOutboxEvent({
          storeId,
          aggregateType: "Cart",
          aggregateId: cart.id,
          eventType: "cart.abandoned",
          payload: { token: cart.token, customerId: cart.customerId ?? null, itemCount },
        });
        return true;
      });
      if (flipped) {
        expired += 1;
        enqueued += 1;
      }
    }
    return { expired, enqueued };
  }
}
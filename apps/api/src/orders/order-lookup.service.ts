// Order lookup by single-use claim token — the guest's "track my order" path.
// Per the master prompt: a secure way for a guest to claim and view an order via a
// single-use signed claim link. The token is HMAC-signed (orderId.secret) and the
// OrderClaimToken row records first use + expiry.

import { prisma } from "../persistence/prisma-repositories.js";
import { verifyClaimToken, InvalidClaimTokenError } from "../domain/claim-token.js";
import type { ApiError } from "@sam-store/contracts";

export type LookupResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** DI token — explicit, matches the other service tokens. */
export const ORDER_LOOKUP_SERVICE = Symbol("ORDER_LOOKUP_SERVICE");

export class OrderLookupService {
  constructor(private readonly claimSecret: string) {}

  /** Verify the claim token, mark it used, and return the order view (single-use). */
  async claimOrder(claimToken: string): Promise<LookupResult<OrderView>> {
    let orderId: string;
    try {
      orderId = verifyClaimToken(claimToken, this.claimSecret);
    } catch (e) {
      if (e instanceof InvalidClaimTokenError) {
        return { ok: false, error: { type: "unauthorized", message: "Invalid claim link" } };
      }
      throw e;
    }

    const record = await prisma.orderClaimToken.findUnique({
      where: { token: claimToken },
      include: { order: { include: { items: true } } },
    });
    if (!record) {
      return { ok: false, error: { type: "unauthorized", message: "Invalid claim link" } };
    }
    if (record.expiresAt < new Date()) {
      return { ok: false, error: { type: "conflict", message: "This order link has expired" } };
    }

    // Consume the token ATOMICALLY (single-use): only one concurrent request can
    // flip usedAt from null. The loser gets a conflict — no race, no double-view.
    const consumed = await prisma.orderClaimToken.updateMany({
      where: { token: claimToken, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) {
      return { ok: false, error: { type: "conflict", message: "This order link has already been used" } };
    }

    const order = record.order;
    return {
      ok: true,
      value: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        currencyCode: order.currencyCode,
        subtotalMinor: order.subtotalMinor,
        deliveryFeeMinor: order.deliveryFeeMinor,
        discountMinor: order.discountMinor,
        totalMinor: order.totalMinor,
        customerName: order.customerName,
        deliverySchedule: order.deliverySchedule,
        createdAt: order.createdAt.toISOString(),
        items: order.items.map((i) => ({
          productName: i.productName,
          sku: i.sku,
          unitPriceMinor: i.unitPriceMinor,
          quantity: i.quantity,
          lineTotalMinor: i.lineTotalMinor,
        })),
      },
    };
  }
}

export interface OrderView {
  orderId: string;
  orderNumber: string;
  status: string;
  currencyCode: string;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  discountMinor: number;
  totalMinor: number;
  customerName: string;
  deliverySchedule: string | null;
  createdAt: string;
  items: {
    productName: string;
    sku: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
  }[];
}
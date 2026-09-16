// Public voucher application — evaluated and REDEEMED at checkout.
// Concurrency-safe: redemption recorded after the order exists (a failed checkout
// never consumes a redemption); the unique (voucherId, orderId) constraint prevents
// double-redeeming; usage limits are checked against live counts at validate time.

import { prisma } from "../persistence/prisma-repositories.js";
import { evaluateVoucher } from "../domain/voucher.js";
import type { VoucherGateway } from "../checkout/checkout.service.js";

export class VoucherPublicService implements VoucherGateway {
  async validate(
    storeId: string,
    code: string,
    orderTotalMinor: number,
  ): Promise<{ ok: true; discountMinor: number; voucherId: string } | { ok: false; message: string }> {
    const voucher = await prisma.voucher.findUnique({
      where: { storeId_code: { storeId, code: code.trim().toUpperCase() } },
      include: { _count: { select: { redemptions: true } } },
    });
    if (!voucher) return { ok: false, message: "Voucher not found" };

    const verdict = evaluateVoucher(
      {
        code: voucher.code,
        discountMinor: voucher.discountMinor,
        minOrderMinor: voucher.minOrderMinor,
        maxRedemptions: voucher.maxRedemptions,
        startsAt: voucher.startsAt,
        expiresAt: voucher.expiresAt,
        isActive: voucher.isActive,
        redemptionCount: voucher._count.redemptions,
      },
      orderTotalMinor,
      new Date(),
    );
    if (!verdict.ok) {
      const messages: Record<string, string> = {
        inactive: "This voucher is inactive",
        not_started: "This voucher is not active yet",
        expired: "This voucher has expired",
        below_minimum: "Your order does not meet the voucher minimum",
        limit_reached: "This voucher has reached its usage limit",
        unknown: "Voucher not found",
      };
      return { ok: false, message: messages[verdict.reason] ?? "Voucher not valid" };
    }

    return { ok: true, discountMinor: voucher.discountMinor, voucherId: voucher.id };
  }

  async redeem(orderId: string, storeId: string, voucherId: string): Promise<void> {
    await prisma.voucherRedemption.create({
      data: { voucherId, storeId, orderId },
    });
  }
}
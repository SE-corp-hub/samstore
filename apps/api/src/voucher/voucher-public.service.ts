// Public voucher application — evaluated and REDEEMED at checkout.
// Concurrency-safe: redemption recorded after the order exists (a failed checkout
// never consumes a redemption); the unique (voucherId, orderId) constraint prevents
// double-redeeming; usage + per-customer limits are checked against live counts.
// P3a: percent / free-delivery / first-order-only / scoped / stackable vouchers.

import { prisma } from "../persistence/prisma-repositories.js";
import { evaluateVoucher, computeVoucherDiscount, type VoucherContext } from "../domain/voucher.js";
import type { VoucherGateway, VoucherValidationContext } from "../checkout/checkout.service.js";

export class VoucherPublicService implements VoucherGateway {
  async validate(
    storeId: string,
    code: string,
    ctx: VoucherValidationContext,
  ): Promise<{ ok: true; discountMinor: number; voucherId: string; stackable: boolean } | { ok: false; message: string }> {
    const voucher = await prisma.voucher.findUnique({
      where: { storeId_code: { storeId, code: code.trim().toUpperCase() } },
      include: { _count: { select: { redemptions: true } } },
    });
    if (!voucher) return { ok: false, message: "Voucher not found" };

    const snapshot = {
      code: voucher.code,
      discountMinor: voucher.discountMinor,
      minOrderMinor: voucher.minOrderMinor,
      maxRedemptions: voucher.maxRedemptions,
      startsAt: voucher.startsAt,
      expiresAt: voucher.expiresAt,
      isActive: voucher.isActive,
      redemptionCount: voucher._count.redemptions,
      type: voucher.type as "fixed" | "percent" | "free_delivery",
      percentBp: voucher.percentBp,
      firstOrderOnly: voucher.firstOrderOnly,
      perCustomerLimit: voucher.perCustomerLimit,
      scopeType: voucher.scopeType as "all" | "product" | "category",
      scopeRefId: voucher.scopeRefId,
      stackable: voucher.stackable,
    };

    // Per-customer usage of THIS voucher (guests have no profile → count 0).
    let customerRedemptionCount = 0;
    if (ctx.storeCustomerId && voucher.perCustomerLimit !== null) {
      customerRedemptionCount = await prisma.voucherRedemption.count({
        where: { voucherId: voucher.id, storeCustomerId: ctx.storeCustomerId },
      });
    }

    // First-order vouchers need to know whether this customer has ordered before.
    let isFirstOrder: boolean | null = null;
    if (ctx.storeCustomerId) {
      const prior = await prisma.order.count({
        where: { storeCustomerId: ctx.storeCustomerId, status: { not: "CANCELLED" } },
      });
      isFirstOrder = prior === 0;
    }

    // Category-scoped vouchers need the cart's category ids.
    let categoryIds: string[] = [];
    if (voucher.scopeType === "category" && ctx.productIds.length > 0) {
      const rows = await prisma.product.findMany({
        where: { storeId, id: { in: ctx.productIds } },
        select: { categoryId: true },
      });
      categoryIds = rows.map((r) => r.categoryId).filter((x): x is string => !!x);
    }

    const full: VoucherContext = {
      subtotalMinor: ctx.subtotalMinor,
      orderTotalMinor: ctx.orderTotalMinor,
      deliveryFeeMinor: ctx.deliveryFeeMinor,
      storeCustomerId: ctx.storeCustomerId,
      productIds: ctx.productIds,
      categoryIds,
      isFirstOrder,
      customerRedemptionCount,
    };

    const verdict = evaluateVoucher(snapshot, full, new Date());
    if (!verdict.ok) {
      const messages: Record<string, string> = {
        inactive: "This voucher is inactive",
        not_started: "This voucher is not active yet",
        expired: "This voucher has expired",
        below_minimum: "Your order does not meet the voucher minimum",
        limit_reached: "This voucher has reached its usage limit",
        first_order_only: "This voucher applies to first orders only (sign in and order for the first time)",
        per_customer_limit: "You have already used this voucher the maximum number of times",
        scope_mismatch: "This voucher does not apply to the items in your cart",
        no_delivery_fee: "This voucher needs a delivery order",
        unknown: "Voucher not found",
      };
      return { ok: false, message: messages[verdict.reason] ?? "Voucher not valid" };
    }

    const discountMinor = computeVoucherDiscount(snapshot, full);
    return { ok: true, discountMinor, voucherId: voucher.id, stackable: voucher.stackable };
  }

  async redeem(orderId: string, storeId: string, voucherId: string, storeCustomerId: string | null): Promise<void> {
    await prisma.voucherRedemption.create({
      data: { voucherId, storeId, orderId, storeCustomerId },
    });
  }
}
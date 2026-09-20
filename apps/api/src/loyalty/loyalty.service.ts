// Loyalty service — earn points on delivered orders, redeem at checkout, ledger.
// Encapsulates the StoreCustomer balance updates + LoyaltyEntry audit trail.

import { prisma } from "../persistence/prisma-repositories.js";
import { cacheGet, cacheSet, cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { pointsEarnedFor, pointsEarned, redeemDiscountMinor, expirablePoints } from "../domain/loyalty.js";
import type { ApiError, AdminCreateCustomerRequest, AdminUpdateCustomerRequest } from "@sam-store/contracts";
import type { LoyaltyGateway } from "../checkout/checkout.service.js";

export type LoyaltyResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** Admin customer list/row shape (v4) — matches GET /admin/customers rows. */
export type AdminCustomerRow = {
  id: string;
  customerId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  approvalStatus: string;
  loyaltyPoints: number;
  creditApproved: boolean;
  creditLimitMinor: number;
  creditBalanceMinor: number;
  joinedAt: Date;
};

/** DI token. */
export const LOYALTY_SERVICE = Symbol("LOYALTY_SERVICE");

/** StoreCustomer row + nested Customer (what adminCustomers returns, cached value shape). */
interface AdminCustomerWithProfile {
  id: string; storeId: string; customerId: string; approvalStatus: string; loyaltyBalancePoints: number;
  creditApproved: boolean; creditLimitMinor: number; creditBalanceMinor: number; createdAt: Date; updatedAt: Date;
  customer: { id: string; email: string | null; name: string | null; phone: string | null; address: string | null };
}

export class LoyaltyService implements LoyaltyGateway {
  /** Ensure a per-store customer profile exists (created lazily at checkout).
   *  P3h: on first creation grants the store's configured welcome bonus once. */
  async ensureProfile(storeId: string, customerId: string): Promise<{ storeCustomerId: string }> {
    const existing = await prisma.storeCustomer.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    if (existing) return { storeCustomerId: existing.id };

    const settings = await prisma.storeSettings.findUnique({ where: { storeId } });
    const welcome = Math.max(0, settings?.loyaltyWelcomeBonusPoints ?? 0);

    return prisma.$transaction(async (tx) => {
      const sc = await tx.storeCustomer.create({
        data: { storeId, customerId, loyaltyBalancePoints: welcome },
      });
      if (welcome > 0) {
        await tx.loyaltyEntry.create({
          data: {
            storeId,
            customerId,
            storeCustomerId: sc.id,
            type: "WELCOME",
            points: welcome,
            balanceAfter: welcome,
            description: `Welcome bonus: ${welcome} pts`,
          },
        });
      }
      return { storeCustomerId: sc.id };
    });
  }

  /** Earn points for a delivered order (idempotent: only when order.storeCustomerId set). */
  async earnForDeliveredOrder(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { storeCustomer: true },
    });
    if (!order?.storeCustomerId || !order.storeCustomer) return;
    // Already earned? (Earn entries for this order exist → skip)
    const existing = await prisma.loyaltyEntry.findFirst({ where: { orderId, type: "EARN" } });
    if (existing) return;

    // P3h: earn rate is store-configurable.
    const settings = await prisma.storeSettings.findUnique({ where: { storeId: order.storeId } });
    const rate = Math.max(1, settings?.loyaltyPointsPerPeso ?? 1);
    const points = pointsEarnedFor(order.totalMinor, rate);
    if (points <= 0) return;

    await prisma.$transaction(async (tx) => {
      const sc = await tx.storeCustomer.update({
        where: { id: order.storeCustomerId! },
        data: { loyaltyBalancePoints: { increment: points } },
      });
      await tx.loyaltyEntry.create({
        data: {
          storeId: order.storeId,
          customerId: sc.customerId,
          storeCustomerId: sc.id,
          type: "EARN",
          points,
          balanceAfter: sc.loyaltyBalancePoints,
          orderId,
          description: `Earned ${points} pts for order ${order.orderNumber}`,
        },
      });
    });
  }

  /** P3h: reverse points earned for an order when it is voided/refunded (idempotent). */
  async reverseForOrder(orderId: string, reason: string): Promise<void> {
    const earned = await prisma.loyaltyEntry.findMany({ where: { orderId, type: "EARN" } });
    if (earned.length === 0) return;
    const total = earned.reduce((s, e) => s + e.points, 0);
    if (total <= 0) return;
    const alreadyReversed = await prisma.loyaltyEntry.findFirst({ where: { orderId, type: "REVERSE" } });
    if (alreadyReversed) return;

    const first = earned[0]!;
    await prisma.$transaction(async (tx) => {
      const sc = await tx.storeCustomer.findUnique({ where: { id: first.storeCustomerId } });
      if (!sc) return;
      const newBalance = Math.max(0, sc.loyaltyBalancePoints - total);
      await tx.storeCustomer.update({ where: { id: sc.id }, data: { loyaltyBalancePoints: newBalance } });
      await tx.loyaltyEntry.create({
        data: {
          storeId: first.storeId,
          customerId: first.customerId,
          storeCustomerId: sc.id,
          type: "REVERSE",
          points: -total,
          balanceAfter: newBalance,
          orderId,
          description: `Reversed ${total} pts — ${reason}`,
        },
      });
    });
  }

  /** P3h: FIFO-expire points older than the store's expiry window (0 months = never).
   *  Returns how many points expired and how many customers were touched. */
  async expirePoints(storeId: string): Promise<{ expiredPoints: number; customers: number }> {
    const settings = await prisma.storeSettings.findUnique({ where: { storeId } });
    const months = settings?.loyaltyExpiryMonths ?? 0;
    if (months <= 0) return { expiredPoints: 0, customers: 0 };

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    const profiles = await prisma.storeCustomer.findMany({ where: { storeId } });
    let expiredPoints = 0;
    let customers = 0;
    for (const sc of profiles) {
      const entries = await prisma.loyaltyEntry.findMany({
        where: { storeCustomerId: sc.id },
        orderBy: { createdAt: "asc" },
        select: { type: true, points: true, createdAt: true },
      });
      const toExpire = expirablePoints(entries, cutoff);
      if (toExpire <= 0) continue;
      const newBalance = Math.max(0, sc.loyaltyBalancePoints - toExpire);
      await prisma.loyaltyEntry.create({
        data: {
          storeId,
          customerId: sc.customerId,
          storeCustomerId: sc.id,
          type: "EXPIRED",
          points: -toExpire,
          balanceAfter: newBalance,
          description: `Expired ${toExpire} pts (older than ${months} months)`,
        },
      });
      await prisma.storeCustomer.update({ where: { id: sc.id }, data: { loyaltyBalancePoints: newBalance } });
      expiredPoints += toExpire;
      customers += 1;
    }
    await cacheBust(cacheKey("customers", storeId));
    return { expiredPoints, customers };
  }

  /** Redeem points at checkout — validates balance, returns discount + debits. */
  async redeem(
    storeId: string,
    customerId: string,
    points: number,
    orderTotalMinor: number,
  ): Promise<{ ok: true; discountMinor: number; storeCustomerId: string } | { ok: false; message: string }> {
    if (!Number.isInteger(points) || points <= 0) return { ok: false, message: "Invalid points" };
    const discountMinor = redeemDiscountMinor(points);
    if (discountMinor <= 0) return { ok: false, message: "Minimum 100 points to redeem" };
    if (discountMinor > orderTotalMinor) return { ok: false, message: "Redemption exceeds order total" };

    const sc = await prisma.storeCustomer.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    if (!sc) return { ok: false, message: "No customer profile for this store" };
    if (sc.loyaltyBalancePoints < points) {
      return { ok: false, message: `Insufficient points (balance ${sc.loyaltyBalancePoints})` };
    }

    return { ok: true, discountMinor, storeCustomerId: sc.id };
  }

  /** Record the actual redemption (called after order creation). */
  async recordRedemption(orderId: string, storeId: string, customerId: string, storeCustomerId: string, points: number): Promise<void> {
    const discountMinor = redeemDiscountMinor(points);
    await prisma.$transaction(async (tx) => {
      const sc = await tx.storeCustomer.update({
        where: { id: storeCustomerId },
        data: { loyaltyBalancePoints: { decrement: points } },
      });
      await tx.loyaltyEntry.create({
        data: {
          storeId,
          customerId,
          storeCustomerId,
          type: "REDEEM",
          points: -points,
          balanceAfter: sc.loyaltyBalancePoints,
          orderId,
          description: `Redeemed ${points} pts for ₱${discountMinor / 100} off`,
        },
      });
    });
  }

  /** Customer ledger + balance (public, customer-authed). */
  async customerLedger(storeId: string, customerId: string) {
    const sc = await prisma.storeCustomer.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    if (!sc) return { balance: 0, entries: [] };
    const entries = await prisma.loyaltyEntry.findMany({
      where: { storeCustomerId: sc.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { balance: sc.loyaltyBalancePoints, entries: entries.map((e) => ({ type: e.type, points: e.points, balanceAfter: e.balanceAfter, description: e.description, createdAt: e.createdAt })) };
  }

  /** Admin: store customers with balances. Filters: search (name/email/phone), approvalStatus, onlyUtang. */
      async adminCustomers(storeId: string, f: { search?: string; approvalStatus?: string; onlyUtang?: boolean } = {}) {
        const plain = !f.search && !f.approvalStatus && !f.onlyUtang;
        if (plain) {
          const hit = await cacheGet<AdminCustomerWithProfile[]>(cacheKey("customers", storeId));
          if (hit) return hit;
        }
      const where: Record<string, unknown> = { storeId };
    if (f.approvalStatus) where.approvalStatus = f.approvalStatus;
    if (f.onlyUtang) where.creditBalanceMinor = { gt: 0 };
    if (f.search) {
          where.customer = {
            OR: [
              { name: { contains: f.search, mode: "insensitive" } },
              { email: { contains: f.search, mode: "insensitive" } },
              { phone: { contains: f.search, mode: "insensitive" } },
            ],
          };
        }
        const rows = await prisma.storeCustomer.findMany({
          where,
          orderBy: { createdAt: "desc" },
          include: { customer: { select: { id: true, email: true, name: true, phone: true, address: true } } },
        });
        if (plain) await cacheSet(cacheKey("customers", storeId), rows, 30_000);
        return rows;
      }

  /** Admin: single customer profile with recent orders + credit entries + loyalty. */
  async adminCustomerProfile(storeId: string, storeCustomerId: string) {
    const sc = await prisma.storeCustomer.findFirst({
      where: { storeId, id: storeCustomerId },
      include: {
        customer: { select: { id: true, email: true, name: true, phone: true, address: true } },
        credit: { orderBy: { createdAt: "desc" }, take: 50 },
      },
    });
    if (!sc) return null;
    const orders = await prisma.order.findMany({
      where: { storeId, storeCustomerId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, orderNumber: true, status: true, totalMinor: true, source: true, createdAt: true, paymentStatus: true },
    });
    return {
      id: sc.id,
      customer: sc.customer,
      approvalStatus: sc.approvalStatus,
      loyaltyBalancePoints: sc.loyaltyBalancePoints,
      creditApproved: sc.creditApproved,
      creditLimitMinor: sc.creditLimitMinor,
      creditBalanceMinor: sc.creditBalanceMinor,
      createdAt: sc.createdAt,
      orders,
      creditEntries: sc.credit.map((e) => ({ id: e.id, type: e.type, amountMinor: e.amountMinor, note: e.note, orderId: e.orderId, createdAt: e.createdAt })),
    };
  }

  // ─────────────────────────────── v4: admin customers / loyalty ───────────────────────────────

  /** Admin row shape — mirrors GET /admin/customers list mapping. */
  static toAdminRow(sc: {
      id: string;
      customerId: string;
      approvalStatus: string;
      loyaltyBalancePoints: number;
      creditApproved: boolean;
      creditLimitMinor: number;
      creditBalanceMinor: number;
      createdAt: Date;
      customer: { name: string | null; email: string | null; phone: string | null; address: string | null };
    }): AdminCustomerRow {
      return {
        id: sc.id,
        customerId: sc.customerId,
        name: sc.customer.name,
        email: sc.customer.email,
        phone: sc.customer.phone,
        address: sc.customer.address,
        approvalStatus: sc.approvalStatus,
        loyaltyPoints: sc.loyaltyBalancePoints,
        creditApproved: sc.creditApproved,
        creditLimitMinor: sc.creditLimitMinor,
        creditBalanceMinor: sc.creditBalanceMinor,
        joinedAt: sc.createdAt,
      };
    }

  /** Admin: create a customer — find-or-create the global Customer by phone (then email), then create the store profile. */
  async createCustomer(storeId: string, input: AdminCreateCustomerRequest): Promise<LoyaltyResult<AdminCustomerRow>> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return { ok: false, error: { type: "validation", errors: ["name is required"] } };
    const phone = typeof input.phone === "string" && input.phone.trim() ? input.phone.trim() : null;
        const email = typeof input.email === "string" && input.email.trim() ? input.email.trim() : null;
        const address = typeof input.address === "string" && input.address.trim() ? input.address.trim() : null;
        const creditApproved = input.creditApproved === true;
        const creditLimitMinor = input.creditLimitMinor ?? 0;
        if (!Number.isInteger(creditLimitMinor) || creditLimitMinor < 0) {
          return { ok: false, error: { type: "validation", errors: ["creditLimitMinor must be a non-negative integer"] } };
        }

        const done = await prisma.$transaction(async (tx) => {
          let customer = phone ? await tx.customer.findFirst({ where: { phone } }) : null;
          if (!customer && email) customer = await tx.customer.findFirst({ where: { email } });
          if (!customer) {
            customer = await tx.customer.create({ data: { name, email, phone, address } });
          }
      const existing = await tx.storeCustomer.findFirst({ where: { storeId, customerId: customer!.id } });
      if (existing) return { created: false as const };
      const sc = await tx.storeCustomer.create({
        data: {
          storeId,
          customerId: customer!.id,
          approvalStatus: creditApproved ? "APPROVED" : "NOT_REQUIRED",
          creditApproved,
          creditLimitMinor,
        },
        include: { customer: { select: { id: true, email: true, name: true, phone: true, address: true } } },
      });
      return { created: true as const, row: LoyaltyService.toAdminRow(sc) };
    });
    if (!done.created) {
      return { ok: false, error: { type: "conflict", message: "Customer already exists in this store" } };
    }
    return { ok: true, value: done.row };
  }

  /** Admin: update a store customer (name/phone/email + credit limit). Store-scoped. */
  async updateCustomer(storeId: string, storeCustomerId: string, input: AdminUpdateCustomerRequest): Promise<LoyaltyResult<AdminCustomerRow>> {
    const customerData: { name?: string; phone?: string | null; email?: string | null; address?: string | null } = {};
        if (input.name !== undefined) {
          const name = typeof input.name === "string" ? input.name.trim() : "";
          if (!name) return { ok: false, error: { type: "validation", errors: ["name must be a non-empty string"] } };
          customerData.name = name;
        }
        if (input.phone !== undefined) {
          const phone = typeof input.phone === "string" ? input.phone.trim() : "";
          customerData.phone = phone || null;
        }
        if (input.email !== undefined) {
          const email = typeof input.email === "string" ? input.email.trim() : "";
          customerData.email = email || null;
        }
        if (input.address !== undefined) {
          const address = typeof input.address === "string" ? input.address.trim() : "";
          customerData.address = address || null;
        }
    let creditLimitMinor: number | undefined;
    if (input.creditLimitMinor !== undefined) {
      if (!Number.isInteger(input.creditLimitMinor) || input.creditLimitMinor < 0) {
        return { ok: false, error: { type: "validation", errors: ["creditLimitMinor must be a non-negative integer"] } };
      }
      creditLimitMinor = input.creditLimitMinor;
    }

    const row = await prisma.$transaction(async (tx) => {
      const sc = await tx.storeCustomer.findFirst({
        where: { id: storeCustomerId, storeId },
        include: { customer: { select: { id: true, email: true, name: true, phone: true, address: true } } },
      });
      if (!sc) return null;
      if (Object.keys(customerData).length > 0) {
        await tx.customer.update({ where: { id: sc.customerId }, data: customerData });
      }
      if (creditLimitMinor !== undefined) {
        await tx.storeCustomer.update({ where: { id: sc.id }, data: { creditLimitMinor } });
      }
      const fresh = await tx.storeCustomer.findFirst({
        where: { id: sc.id },
        include: { customer: { select: { id: true, email: true, name: true, phone: true, address: true } } },
      });
      return fresh ? LoyaltyService.toAdminRow(fresh) : null;
    });
    if (!row) return { ok: false, error: { type: "not_found", message: "Customer not found in this store" } };
    return { ok: true, value: row };
  }

  /** Admin: manual points adjustment (signed delta, balance never below 0). */
  async adjustPoints(
    storeId: string,
    storeCustomerId: string,
    delta: number,
    note: string,
  ): Promise<LoyaltyResult<{ balanceAfter: number; entry: { id: string; type: string; points: number; balanceAfter: number; description: string; createdAt: Date } }>> {
    if (!Number.isInteger(delta) || delta === 0) {
      return { ok: false, error: { type: "validation", errors: ["delta must be a non-zero integer"] } };
    }
    const text = typeof note === "string" ? note.trim() : "";
    if (!text) return { ok: false, error: { type: "validation", errors: ["note is required"] } };

    return prisma.$transaction(async (tx) => {
      const sc = await tx.storeCustomer.findFirst({ where: { id: storeCustomerId, storeId } });
      if (!sc) return { ok: false as const, error: { type: "not_found", message: "Customer not found in this store" } };
      const newBalance = sc.loyaltyBalancePoints + delta;
      if (newBalance < 0) return { ok: false as const, error: { type: "conflict", message: "Balance cannot go below 0" } };
      await tx.storeCustomer.update({ where: { id: sc.id }, data: { loyaltyBalancePoints: newBalance } });
      const entry = await tx.loyaltyEntry.create({
        data: {
          storeId,
          customerId: sc.customerId,
          storeCustomerId: sc.id,
          type: "ADJUST",
          points: delta,
          balanceAfter: newBalance,
          description: `Manual adjust: ${text}`,
        },
      });
      return {
        ok: true as const,
        value: {
          balanceAfter: newBalance,
          entry: {
            id: entry.id,
            type: entry.type,
            points: entry.points,
            balanceAfter: entry.balanceAfter,
            description: entry.description,
            createdAt: entry.createdAt,
          },
        },
      };
    });
  }
}
// Voucher admin service — tenant-scoped voucher CRUD + redemption counters.

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface VoucherInput {
  code: string;
  discountMinor: number;
  minOrderMinor?: number;
  maxRedemptions?: number | null;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  description?: string | null;
  isActive?: boolean;
}

export class VoucherAdminService {
  async list(storeId: string) {
    const vouchers = await prisma.voucher.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { redemptions: true } } },
    });
    return vouchers.map((v) => ({
      id: v.id,
      code: v.code,
      description: v.description,
      discountMinor: v.discountMinor,
      minOrderMinor: v.minOrderMinor,
      maxRedemptions: v.maxRedemptions,
      startsAt: v.startsAt,
      expiresAt: v.expiresAt,
      isActive: v.isActive,
      redemptionCount: v._count.redemptions,
    }));
  }

  async create(storeId: string, input: VoucherInput): Promise<AdminResult<{ id: string }>> {
    const code = input.code?.trim().toUpperCase() ?? "";
    if (code.length < 2 || code.length > 30 || !/^[A-Z0-9_-]+$/.test(code)) {
      return { ok: false, error: { type: "validation", errors: ["code must be 2-30 chars: letters, digits, _ or -"] } };
    }
    if (!Number.isInteger(input.discountMinor) || input.discountMinor <= 0) {
      return { ok: false, error: { type: "validation", errors: ["discountMinor must be a positive integer"] } };
    }
    if (input.minOrderMinor !== undefined && (!Number.isInteger(input.minOrderMinor) || input.minOrderMinor < 0)) {
      return { ok: false, error: { type: "validation", errors: ["minOrderMinor must be a non-negative integer"] } };
    }

    // Atomic on (storeId, code): a double-submitted create used to race the find-then-create
    // and surface a raw P2002 as an HTTP 500. Same class as the cart-item race.
    try {
      const voucher = await prisma.voucher.create({
        data: {
          storeId,
          code,
          description: input.description?.trim() ?? null,
          discountMinor: input.discountMinor,
          minOrderMinor: input.minOrderMinor ?? 0,
          maxRedemptions: input.maxRedemptions ?? null,
          startsAt: input.startsAt ?? null,
          expiresAt: input.expiresAt ?? null,
        },
      });
      return { ok: true, value: { id: voucher.id } };
    } catch (e) {
      // P2002 = the code exists (or a concurrent create won) → a clean conflict, never a 500.
      if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
        return { ok: false, error: { type: "conflict", message: "Voucher code already exists" } };
      }
      throw e;
    }
  }

  async update(storeId: string, voucherId: string, input: Partial<VoucherInput>): Promise<AdminResult<{ id: string }>> {
    const voucher = await prisma.voucher.findFirst({ where: { id: voucherId, storeId } });
    if (!voucher) return { ok: false, error: { type: "not_found", message: "Voucher not found" } };

    if (input.discountMinor !== undefined && (!Number.isInteger(input.discountMinor) || input.discountMinor <= 0)) {
      return { ok: false, error: { type: "validation", errors: ["discountMinor must be a positive integer"] } };
    }

    await prisma.voucher.update({
      where: { id: voucherId },
      data: {
        description: input.description !== undefined ? input.description?.trim() ?? null : voucher.description,
        discountMinor: input.discountMinor ?? voucher.discountMinor,
        minOrderMinor: input.minOrderMinor ?? voucher.minOrderMinor,
        maxRedemptions: input.maxRedemptions !== undefined ? input.maxRedemptions : voucher.maxRedemptions,
        startsAt: input.startsAt !== undefined ? input.startsAt : voucher.startsAt,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : voucher.expiresAt,
        isActive: input.isActive !== undefined ? input.isActive : voucher.isActive,
      },
    });
    return { ok: true, value: { id: voucherId } };
  }
}
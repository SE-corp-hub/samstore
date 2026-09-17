// Voucher admin service — tenant-scoped voucher CRUD + redemption counters.
// P3a: fixed / percent / free-delivery types, scoping, first-order-only,
// per-customer limits, and stackability.

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export type VoucherType = "fixed" | "percent" | "free_delivery";
export type VoucherScope = "all" | "product" | "category";

export interface VoucherInput {
  code: string;
  discountMinor?: number;
  type?: VoucherType;
  /** percent vouchers: basis points (1000 = 10%) */
  percentBp?: number;
  minOrderMinor?: number;
  maxRedemptions?: number | null;
  perCustomerLimit?: number | null;
  firstOrderOnly?: boolean;
  scopeType?: VoucherScope;
  /** product scope: the product's SKU (resolved to its id) */
  scopeSku?: string;
  /** category scope: the category slug (resolved to its id) */
  scopeCategorySlug?: string;
  stackable?: boolean;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  description?: string | null;
  isActive?: boolean;
}

interface ResolvedRules {
  type: VoucherType;
  discountMinor: number;
  percentBp: number | null;
  scopeType: VoucherScope;
  scopeRefId: string | null;
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
      type: v.type,
      percentBp: v.percentBp,
      minOrderMinor: v.minOrderMinor,
      maxRedemptions: v.maxRedemptions,
      perCustomerLimit: v.perCustomerLimit,
      firstOrderOnly: v.firstOrderOnly,
      scopeType: v.scopeType,
      scopeRefId: v.scopeRefId,
      stackable: v.stackable,
      startsAt: v.startsAt,
      expiresAt: v.expiresAt,
      isActive: v.isActive,
      redemptionCount: v._count.redemptions,
    }));
  }

  /** Validate + resolve the type/scope rules shared by create and update. */
  private async resolveRules(storeId: string, input: VoucherInput): Promise<{ ok: true; value: ResolvedRules } | { ok: false; error: ApiError }> {
    const type: VoucherType = input.type ?? "fixed";
    if (!["fixed", "percent", "free_delivery"].includes(type)) {
      return { ok: false, error: { type: "validation", errors: ["type must be fixed, percent or free_delivery"] } };
    }

    let discountMinor = 0;
    let percentBp: number | null = null;
    if (type === "fixed") {
      discountMinor = input.discountMinor ?? 0;
      if (!Number.isInteger(discountMinor) || discountMinor <= 0) {
        return { ok: false, error: { type: "validation", errors: ["fixed vouchers need a positive discountMinor"] } };
      }
    } else if (type === "percent") {
      percentBp = input.percentBp ?? 0;
      if (!Number.isInteger(percentBp) || percentBp <= 0 || percentBp > 10_000) {
        return { ok: false, error: { type: "validation", errors: ["percent vouchers need percentBp between 1 and 10000"] } };
      }
    }

    const scopeType: VoucherScope = input.scopeType ?? "all";
    if (!["all", "product", "category"].includes(scopeType)) {
      return { ok: false, error: { type: "validation", errors: ["scopeType must be all, product or category"] } };
    }
    let scopeRefId: string | null = null;
    if (scopeType === "product") {
      const sku = input.scopeSku?.trim();
      if (!sku) return { ok: false, error: { type: "validation", errors: ["product-scoped vouchers need scopeSku"] } };
      const product = await prisma.product.findFirst({ where: { storeId, sku } });
      if (!product) return { ok: false, error: { type: "not_found", message: "Scoped product not found" } };
      scopeRefId = product.id;
    } else if (scopeType === "category") {
      const slug = input.scopeCategorySlug?.trim();
      if (!slug) return { ok: false, error: { type: "validation", errors: ["category-scoped vouchers need scopeCategorySlug"] } };
      const category = await prisma.category.findFirst({ where: { storeId, slug } });
      if (!category) return { ok: false, error: { type: "not_found", message: "Scoped category not found" } };
      scopeRefId = category.id;
    }

    if (input.minOrderMinor !== undefined && (!Number.isInteger(input.minOrderMinor) || input.minOrderMinor < 0)) {
      return { ok: false, error: { type: "validation", errors: ["minOrderMinor must be a non-negative integer"] } };
    }
    if (input.perCustomerLimit !== undefined && input.perCustomerLimit !== null && (!Number.isInteger(input.perCustomerLimit) || input.perCustomerLimit < 1)) {
      return { ok: false, error: { type: "validation", errors: ["perCustomerLimit must be a positive integer or null"] } };
    }

    return { ok: true, value: { type, discountMinor, percentBp, scopeType, scopeRefId } };
  }

  async create(storeId: string, input: VoucherInput): Promise<AdminResult<{ id: string }>> {
    const code = input.code?.trim().toUpperCase() ?? "";
    if (code.length < 2 || code.length > 30 || !/^[A-Z0-9_-]+$/.test(code)) {
      return { ok: false, error: { type: "validation", errors: ["code must be 2-30 chars: letters, digits, _ or -"] } };
    }
    const rules = await this.resolveRules(storeId, input);
    if (!rules.ok) return { ok: false, error: rules.error };
    const r = rules.value;

    // Atomic on (storeId, code): a double-submitted create used to race the find-then-create
    // and surface a raw P2002 as an HTTP 500. Same class as the cart-item race.
    try {
      const voucher = await prisma.voucher.create({
        data: {
          storeId,
          code,
          description: input.description?.trim() ?? null,
          discountMinor: r.discountMinor,
          type: r.type,
          percentBp: r.percentBp,
          minOrderMinor: input.minOrderMinor ?? 0,
          maxRedemptions: input.maxRedemptions ?? null,
          perCustomerLimit: input.perCustomerLimit ?? null,
          firstOrderOnly: input.firstOrderOnly ?? false,
          scopeType: r.scopeType,
          scopeRefId: r.scopeRefId,
          stackable: input.stackable ?? false,
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

    // ── type-specific rules (merged view so a partial edit can switch type) ──
    const type = (input.type ?? voucher.type) as VoucherType;
    if (!["fixed", "percent", "free_delivery"].includes(type)) {
      return { ok: false, error: { type: "validation", errors: ["type must be fixed, percent or free_delivery"] } };
    }
    let discountMinor = 0;
    let percentBp: number | null = null;
    if (type === "fixed") {
      discountMinor = input.discountMinor ?? (voucher.type === "fixed" ? voucher.discountMinor : 0);
      if (!Number.isInteger(discountMinor) || discountMinor <= 0) {
        return { ok: false, error: { type: "validation", errors: ["fixed vouchers need a positive discountMinor"] } };
      }
    } else if (type === "percent") {
      percentBp = input.percentBp ?? (voucher.type === "percent" ? voucher.percentBp : null);
      if (percentBp === null || !Number.isInteger(percentBp) || percentBp <= 0 || percentBp > 10_000) {
        return { ok: false, error: { type: "validation", errors: ["percent vouchers need percentBp between 1 and 10000"] } };
      }
    }

    // ── scope: only re-resolve when the caller touched any scope field ──
    let scopeType = (input.scopeType ?? voucher.scopeType) as VoucherScope;
    let scopeRefId = voucher.scopeRefId;
    const touchedScope = input.scopeType !== undefined || input.scopeSku !== undefined || input.scopeCategorySlug !== undefined;
    if (touchedScope) {
      if (!["all", "product", "category"].includes(scopeType)) {
        return { ok: false, error: { type: "validation", errors: ["scopeType must be all, product or category"] } };
      }
      if (scopeType === "all") {
        scopeRefId = null;
      } else if (scopeType === "product") {
        const sku = input.scopeSku?.trim();
        if (!sku) return { ok: false, error: { type: "validation", errors: ["product-scoped vouchers need scopeSku"] } };
        const product = await prisma.product.findFirst({ where: { storeId, sku } });
        if (!product) return { ok: false, error: { type: "not_found", message: "Scoped product not found" } };
        scopeRefId = product.id;
      } else {
        const slug = input.scopeCategorySlug?.trim();
        if (!slug) return { ok: false, error: { type: "validation", errors: ["category-scoped vouchers need scopeCategorySlug"] } };
        const category = await prisma.category.findFirst({ where: { storeId, slug } });
        if (!category) return { ok: false, error: { type: "not_found", message: "Scoped category not found" } };
        scopeRefId = category.id;
      }
    }

    // ── limits ──
    if (input.minOrderMinor !== undefined && (!Number.isInteger(input.minOrderMinor) || input.minOrderMinor < 0)) {
      return { ok: false, error: { type: "validation", errors: ["minOrderMinor must be a non-negative integer"] } };
    }
    const perCustomerLimit = input.perCustomerLimit !== undefined ? input.perCustomerLimit : voucher.perCustomerLimit;
    if (perCustomerLimit !== null && (!Number.isInteger(perCustomerLimit) || perCustomerLimit < 1)) {
      return { ok: false, error: { type: "validation", errors: ["perCustomerLimit must be a positive integer or null"] } };
    }

    await prisma.voucher.update({
      where: { id: voucherId },
      data: {
        description: input.description !== undefined ? input.description?.trim() ?? null : voucher.description,
        discountMinor,
        type,
        percentBp,
        minOrderMinor: input.minOrderMinor ?? voucher.minOrderMinor,
        maxRedemptions: input.maxRedemptions !== undefined ? input.maxRedemptions : voucher.maxRedemptions,
        perCustomerLimit,
        firstOrderOnly: input.firstOrderOnly !== undefined ? input.firstOrderOnly : voucher.firstOrderOnly,
        scopeType,
        scopeRefId,
        stackable: input.stackable !== undefined ? input.stackable : voucher.stackable,
        startsAt: input.startsAt !== undefined ? input.startsAt : voucher.startsAt,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : voucher.expiresAt,
        isActive: input.isActive !== undefined ? input.isActive : voucher.isActive,
      },
    });
    return { ok: true, value: { id: voucherId } };
  }
}
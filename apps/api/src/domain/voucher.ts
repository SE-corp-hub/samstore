// Voucher rules — pure, unit-testable. Enforces the master-prompt invariant:
// "concurrent checkouts must never exceed voucher, loyalty, or per-customer usage limits."
// P3a: percent / free-delivery types, product/category scoping, first-order-only,
// per-customer limits, and stackable-with-loyalty semantics.

export type VoucherType = "fixed" | "percent" | "free_delivery";

export interface VoucherSnapshot {
  code: string;
  discountMinor: number;
  minOrderMinor: number;
  maxRedemptions: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  redemptionCount: number;
  // P3a
  type: VoucherType;
  percentBp: number | null;
  firstOrderOnly: boolean;
  perCustomerLimit: number | null;
  scopeType: "all" | "product" | "category";
  scopeRefId: string | null;
  stackable: boolean;
}

/** Everything evaluate needs about the ORDER + CUSTOMER to decide the voucher. */
export interface VoucherContext {
  /** subtotal of the lines (before delivery fee) — percent vouchers apply here */
  subtotalMinor: number;
  /** grand total incl. delivery fee, minus nothing */
  orderTotalMinor: number;
  /** delivery fee for THIS checkout (0 for pickup / free-delivery stores) */
  deliveryFeeMinor: number;
  /** null = guest (first-order vouchers are customer-only) */
  storeCustomerId: string | null;
  /** true when the customer has no prior non-cancelled orders at this store */
  isFirstOrder: boolean | null;
  /** per-customer redemptions of THIS voucher so far (0 for guests) */
  customerRedemptionCount: number;
  productIds: string[];
  categoryIds: string[];
}

export type VoucherVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unknown"
        | "inactive"
        | "not_started"
        | "expired"
        | "below_minimum"
        | "limit_reached"
        | "first_order_only"
        | "per_customer_limit"
        | "scope_mismatch"
        | "no_delivery_fee";
    };

export function evaluateVoucher(voucher: VoucherSnapshot, ctx: VoucherContext, now: Date): VoucherVerdict {
  if (!voucher) return { ok: false, reason: "unknown" };
  if (!voucher.isActive) return { ok: false, reason: "inactive" };
  if (voucher.startsAt && voucher.startsAt > now) return { ok: false, reason: "not_started" };
  if (voucher.expiresAt && voucher.expiresAt < now) return { ok: false, reason: "expired" };
  if (ctx.orderTotalMinor < voucher.minOrderMinor) return { ok: false, reason: "below_minimum" };
  if (voucher.maxRedemptions !== null && voucher.redemptionCount >= voucher.maxRedemptions) {
    return { ok: false, reason: "limit_reached" };
  }
  if (voucher.firstOrderOnly && (ctx.isFirstOrder === null || ctx.isFirstOrder === false)) {
    return { ok: false, reason: "first_order_only" };
  }
  if (voucher.perCustomerLimit !== null && ctx.customerRedemptionCount >= voucher.perCustomerLimit) {
    return { ok: false, reason: "per_customer_limit" };
  }
  if (voucher.scopeType === "product" && (!voucher.scopeRefId || !ctx.productIds.includes(voucher.scopeRefId))) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (voucher.scopeType === "category" && (!voucher.scopeRefId || !ctx.categoryIds.includes(voucher.scopeRefId))) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (voucher.type === "free_delivery" && ctx.deliveryFeeMinor <= 0) {
    return { ok: false, reason: "no_delivery_fee" };
  }
  return { ok: true };
}

/** The discount a valid voucher yields for this context (never below zero, never above the base). */
export function computeVoucherDiscount(voucher: VoucherSnapshot, ctx: VoucherContext): number {
  switch (voucher.type) {
    case "percent": {
      const bp = voucher.percentBp ?? 0;
      return Math.min(ctx.subtotalMinor, Math.floor((ctx.subtotalMinor * bp) / 10_000));
    }
    case "free_delivery":
      return ctx.deliveryFeeMinor;
    case "fixed":
    default:
      return Math.min(voucher.discountMinor, ctx.orderTotalMinor);
  }
}

/** Legacy helper kept for existing callers/tests (fixed-type totals). */
export function applyVoucherDiscount(totalMinor: number, discountMinor: number): number {
  return Math.max(0, totalMinor - discountMinor);
}
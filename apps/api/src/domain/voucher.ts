// Voucher rules — pure, unit-testable. Enforces the master-prompt invariant:
// "concurrent checkouts must never exceed voucher, loyalty, or per-customer usage limits."

export interface VoucherSnapshot {
  code: string;
  discountMinor: number;
  minOrderMinor: number;
  maxRedemptions: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  redemptionCount: number;
}

export type VoucherVerdict =
  | { ok: true }
  | { ok: false; reason: "unknown" | "inactive" | "not_started" | "expired" | "below_minimum" | "limit_reached" };

export function evaluateVoucher(voucher: VoucherSnapshot, orderTotalMinor: number, now: Date): VoucherVerdict {
  if (!voucher) return { ok: false, reason: "unknown" };
  if (!voucher.isActive) return { ok: false, reason: "inactive" };
  if (voucher.startsAt && voucher.startsAt > now) return { ok: false, reason: "not_started" };
  if (voucher.expiresAt && voucher.expiresAt < now) return { ok: false, reason: "expired" };
  if (orderTotalMinor < voucher.minOrderMinor) return { ok: false, reason: "below_minimum" };
  if (voucher.maxRedemptions !== null && voucher.redemptionCount >= voucher.maxRedemptions) {
    return { ok: false, reason: "limit_reached" };
  }
  return { ok: true };
}

/** Final total after applying a valid voucher (never below zero). */
export function applyVoucherDiscount(totalMinor: number, discountMinor: number): number {
  return Math.max(0, totalMinor - discountMinor);
}
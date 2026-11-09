// Store settings admin service — tenant-scoped store configuration.

import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface StoreSettingsInput {
  allowGuestOrders?: boolean;
  orderingPaused?: boolean;
  closedStoreMessage?: string | null;
  minOrderAmountMinor?: number;
  deliveryFeeMinor?: number;
  deliveryEnabled?: boolean;
  pickupEnabled?: boolean;
  orderCutoff?: string | null;
  maxOpenOrdersPerCustomer?: number;
  creditLimitMinor?: number; // P11: default utang limit
  creditTermDays?: number; // V1: default dueAt offset
  requireOpenShift?: boolean; // false = cash can be taken without opening a drawer shift
  receiptHeader?: string | null; // P11
  receiptFooter?: string | null; // P11
  showVatLabel?: boolean; // P11
  // M4 tax engine (decisions locked 2026-09-14).
  vatEnabled?: boolean; // master switch — off reproduces pre-M4 totals exactly
  vatRateBp?: number; // 1200 = 12% PH VAT
  pricesIncludeVat?: boolean; // catalogue prices already contain the VAT
  vatShowOnReceipt?: boolean; // owner may HIDE the VAT lines on the printed slip
  tin?: string | null; // BIR taxpayer ID printed on the slip
  dailySalesTargetMinor?: number; // Overview: daily sales target (0 = off)
  hidePricePreOrder?: boolean; // P11: hide per-product prices in Pre Orders screen
  // Quota promo: N sacks or more of the chosen groups → each sack cheaper (applied on the tablet).
  quotaPromoEnabled?: boolean;
  quotaPromoMinSacks?: number;
  quotaPromoOffMinor?: number;
  quotaPromoCategoryIds?: string[];
  seniorPwdDiscountEnabled?: boolean; // P3b: statutory 20% senior/PWD discount
  // P3g: Website→Messenger bridge — recorded connection state (sends stay suppressed).
  messengerConnected?: boolean;
  messengerPageId?: string | null;
  // P3h: loyalty config.
  loyaltyPointsPerPeso?: number;
  loyaltyWelcomeBonusPoints?: number;
  loyaltyExpiryMonths?: number;
  // P3i: order-number prefix (PIN-YYYY-NNNNNN when set).
  orderNumberPrefix?: string | null;
  privacyRetentionDays?: number;
}

export class StoreSettingsService {
  /** Read store + settings (for the admin settings page). */
  async get(storeId: string) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { settings: true, publicLink: { select: { slug: true, token: true, status: true } } },
    });
    if (!store) return null;
    return {
      id: store.id,
      name: store.name,
      slug: store.slug,
      currencyCode: store.currencyCode,
      timezone: store.timezone,
      status: store.status,
      publicLink: store.publicLink,
      accentColor: store.accentColor,
      bannerText: store.bannerText,
      shareMessage: store.shareMessage,
      logoUrl: store.logoUrl,
      settings: {
        allowGuestOrders: store.settings?.allowGuestOrders ?? true,
        orderingPaused: store.settings?.orderingPaused ?? false,
        closedStoreMessage: store.settings?.closedStoreMessage ?? null,
        minOrderAmountMinor: store.settings?.minOrderAmountMinor ?? 0,
        deliveryFeeMinor: store.settings?.deliveryFeeMinor ?? 0,
        deliveryEnabled: store.settings?.deliveryEnabled ?? true,
        pickupEnabled: store.settings?.pickupEnabled ?? false,
        orderCutoff: store.settings?.orderCutoff ?? null,
        maxOpenOrdersPerCustomer: store.settings?.maxOpenOrdersPerCustomer ?? 10,
        creditLimitMinor: store.settings?.creditLimitMinor ?? 0,
        creditTermDays: store.settings?.creditTermDays ?? 30,
        requireOpenShift: store.settings?.requireOpenShift ?? false,
        receiptHeader: store.settings?.receiptHeader ?? null,
        receiptFooter: store.settings?.receiptFooter ?? null,
        showVatLabel: store.settings?.showVatLabel ?? true,
        vatEnabled: store.settings?.vatEnabled ?? true,
        vatRateBp: store.settings?.vatRateBp ?? 1200,
        pricesIncludeVat: store.settings?.pricesIncludeVat ?? true,
        vatShowOnReceipt: store.settings?.vatShowOnReceipt ?? true,
        tin: store.settings?.tin ?? null,
        dailySalesTargetMinor: store.settings?.dailySalesTargetMinor ?? 0,
        hidePricePreOrder: store.settings?.hidePricePreOrder ?? false,
        quotaPromoEnabled: store.settings?.quotaPromoEnabled ?? false,
        quotaPromoMinSacks: store.settings?.quotaPromoMinSacks ?? 10,
        quotaPromoOffMinor: store.settings?.quotaPromoOffMinor ?? 2000,
        quotaPromoCategoryIds: store.settings?.quotaPromoCategoryIds ?? [],
        seniorPwdDiscountEnabled: store.settings?.seniorPwdDiscountEnabled ?? false,
        messengerConnected: store.settings?.messengerConnected ?? false,
        messengerPageId: store.settings?.messengerPageId ?? null,
        loyaltyPointsPerPeso: store.settings?.loyaltyPointsPerPeso ?? 1,
        loyaltyWelcomeBonusPoints: store.settings?.loyaltyWelcomeBonusPoints ?? 0,
        loyaltyExpiryMonths: store.settings?.loyaltyExpiryMonths ?? 0,
        orderNumberPrefix: store.settings?.orderNumberPrefix ?? null,
        privacyRetentionDays: store.settings?.privacyRetentionDays ?? 0,
      },
    };
  }

  /** Update store settings (upserts the settings row). */
  async update(storeId: string, input: StoreSettingsInput): Promise<AdminResult<{ id: string }>> {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };

    // Validate integers where provided.
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "number" && (!Number.isInteger(value) || value < 0)) {
        return { ok: false, error: { type: "validation", errors: [`${key} must be a non-negative integer`] } };
      }
    }
    if (input.orderCutoff !== undefined && input.orderCutoff !== null && !/^\d{2}:\d{2}$/.test(input.orderCutoff)) {
      return { ok: false, error: { type: "validation", errors: ["orderCutoff must be HH:MM (24h)"] } };
    }
    if (input.quotaPromoMinSacks !== undefined && (input.quotaPromoMinSacks < 1 || input.quotaPromoMinSacks > 1000)) {
      return { ok: false, error: { type: "validation", errors: ["Quota promo: the number of sacks must be 1 to 1,000"] } };
    }
    if (input.quotaPromoOffMinor !== undefined && (input.quotaPromoOffMinor < 1 || input.quotaPromoOffMinor > 100_000)) {
      return { ok: false, error: { type: "validation", errors: ["Quota promo: the amount off must be ₱0.01 to ₱1,000 per sack"] } };
    }
    if (input.quotaPromoCategoryIds !== undefined) {
      const ids = input.quotaPromoCategoryIds;
      if (!Array.isArray(ids) || ids.length > 50 || ids.some((x) => typeof x !== "string")) {
        return { ok: false, error: { type: "validation", errors: ["Quota promo: choose the groups from the list"] } };
      }
      const found = ids.length ? await prisma.category.count({ where: { storeId, id: { in: ids } } }) : 0;
      if (found !== new Set(ids).size) return { ok: false, error: { type: "validation", errors: ["Quota promo: a chosen group is not in this store"] } };
    }

    await prisma.storeSettings.upsert({
      where: { storeId },
      update: {
        ...(input.allowGuestOrders !== undefined ? { allowGuestOrders: input.allowGuestOrders } : {}),
        ...(input.orderingPaused !== undefined ? { orderingPaused: input.orderingPaused } : {}),
        ...(input.closedStoreMessage !== undefined ? { closedStoreMessage: input.closedStoreMessage } : {}),
        ...(input.minOrderAmountMinor !== undefined ? { minOrderAmountMinor: input.minOrderAmountMinor } : {}),
        ...(input.deliveryFeeMinor !== undefined ? { deliveryFeeMinor: input.deliveryFeeMinor } : {}),
        ...(input.deliveryEnabled !== undefined ? { deliveryEnabled: input.deliveryEnabled } : {}),
        ...(input.pickupEnabled !== undefined ? { pickupEnabled: input.pickupEnabled } : {}),
        ...(input.orderCutoff !== undefined ? { orderCutoff: input.orderCutoff } : {}),
        ...(input.maxOpenOrdersPerCustomer !== undefined ? { maxOpenOrdersPerCustomer: input.maxOpenOrdersPerCustomer } : {}),
        ...(input.creditLimitMinor !== undefined ? { creditLimitMinor: input.creditLimitMinor } : {}),
        ...(input.creditTermDays !== undefined ? { creditTermDays: input.creditTermDays } : {}),
        ...(input.requireOpenShift !== undefined ? { requireOpenShift: input.requireOpenShift } : {}),
        ...(input.receiptHeader !== undefined ? { receiptHeader: input.receiptHeader } : {}),
        ...(input.receiptFooter !== undefined ? { receiptFooter: input.receiptFooter } : {}),
        ...(input.showVatLabel !== undefined ? { showVatLabel: input.showVatLabel } : {}),
        ...(input.vatEnabled !== undefined ? { vatEnabled: input.vatEnabled } : {}),
        ...(input.vatRateBp !== undefined ? { vatRateBp: input.vatRateBp } : {}),
        ...(input.pricesIncludeVat !== undefined ? { pricesIncludeVat: input.pricesIncludeVat } : {}),
        ...(input.vatShowOnReceipt !== undefined ? { vatShowOnReceipt: input.vatShowOnReceipt } : {}),
        ...(input.tin !== undefined ? { tin: input.tin } : {}),
        ...(input.dailySalesTargetMinor !== undefined ? { dailySalesTargetMinor: input.dailySalesTargetMinor } : {}),
        ...(input.hidePricePreOrder !== undefined ? { hidePricePreOrder: input.hidePricePreOrder } : {}),
        ...(input.quotaPromoEnabled !== undefined ? { quotaPromoEnabled: input.quotaPromoEnabled } : {}),
        ...(input.quotaPromoMinSacks !== undefined ? { quotaPromoMinSacks: input.quotaPromoMinSacks } : {}),
        ...(input.quotaPromoOffMinor !== undefined ? { quotaPromoOffMinor: input.quotaPromoOffMinor } : {}),
        ...(input.quotaPromoCategoryIds !== undefined ? { quotaPromoCategoryIds: [...new Set(input.quotaPromoCategoryIds)] } : {}),
        ...(input.seniorPwdDiscountEnabled !== undefined ? { seniorPwdDiscountEnabled: input.seniorPwdDiscountEnabled } : {}),
        ...(input.messengerConnected !== undefined ? { messengerConnected: input.messengerConnected } : {}),
        ...(input.messengerPageId !== undefined ? { messengerPageId: input.messengerPageId } : {}),
        ...(input.loyaltyPointsPerPeso !== undefined ? { loyaltyPointsPerPeso: input.loyaltyPointsPerPeso } : {}),
        ...(input.loyaltyWelcomeBonusPoints !== undefined ? { loyaltyWelcomeBonusPoints: input.loyaltyWelcomeBonusPoints } : {}),
        ...(input.loyaltyExpiryMonths !== undefined ? { loyaltyExpiryMonths: input.loyaltyExpiryMonths } : {}),
        ...(input.orderNumberPrefix !== undefined ? { orderNumberPrefix: input.orderNumberPrefix } : {}),
        ...(input.privacyRetentionDays !== undefined ? { privacyRetentionDays: input.privacyRetentionDays } : {}),
      },
      create: {
        storeId,
        allowGuestOrders: input.allowGuestOrders ?? true,
        orderingPaused: input.orderingPaused ?? false,
        closedStoreMessage: input.closedStoreMessage ?? null,
        minOrderAmountMinor: input.minOrderAmountMinor ?? 0,
        deliveryFeeMinor: input.deliveryFeeMinor ?? 0,
        deliveryEnabled: input.deliveryEnabled ?? true,
        pickupEnabled: input.pickupEnabled ?? false,
        orderCutoff: input.orderCutoff ?? null,
        maxOpenOrdersPerCustomer: input.maxOpenOrdersPerCustomer ?? 10,
        creditLimitMinor: input.creditLimitMinor ?? 0,
        creditTermDays: input.creditTermDays ?? 30,
        requireOpenShift: input.requireOpenShift ?? false,
        receiptHeader: input.receiptHeader ?? null,
        receiptFooter: input.receiptFooter ?? null,
        showVatLabel: input.showVatLabel ?? true,
        dailySalesTargetMinor: input.dailySalesTargetMinor ?? 0,
        hidePricePreOrder: input.hidePricePreOrder ?? false,
        quotaPromoEnabled: input.quotaPromoEnabled ?? false,
        quotaPromoMinSacks: input.quotaPromoMinSacks ?? 10,
        quotaPromoOffMinor: input.quotaPromoOffMinor ?? 2000,
        quotaPromoCategoryIds: input.quotaPromoCategoryIds ? [...new Set(input.quotaPromoCategoryIds)] : [],
        seniorPwdDiscountEnabled: input.seniorPwdDiscountEnabled ?? false,
        messengerConnected: input.messengerConnected ?? false,
        messengerPageId: input.messengerPageId ?? null,
        loyaltyPointsPerPeso: input.loyaltyPointsPerPeso ?? 1,
        loyaltyWelcomeBonusPoints: input.loyaltyWelcomeBonusPoints ?? 0,
        loyaltyExpiryMonths: input.loyaltyExpiryMonths ?? 0,
        orderNumberPrefix: input.orderNumberPrefix ?? null,
        privacyRetentionDays: input.privacyRetentionDays ?? 0,
      },
    });
    return { ok: true, value: { id: storeId } };
  }

  /** P8 — store link branding: accent color, banner text, share message, logo. */
  async updateLink(storeId: string, input: { accentColor?: string; bannerText?: string | null; shareMessage?: string | null; logoUrl?: string | null }): Promise<AdminResult<{ id: string }>> {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    if (input.accentColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(input.accentColor)) {
      return { ok: false, error: { type: "validation", errors: ["accentColor must be a hex color (#rrggbb)"] } };
    }
    await prisma.store.update({
      where: { id: storeId },
      data: {
        ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
        ...(input.bannerText !== undefined ? { bannerText: input.bannerText } : {}),
        ...(input.shareMessage !== undefined ? { shareMessage: input.shareMessage } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      },
    });
    return { ok: true, value: { id: storeId } };
  }
}

// ─────────────────────────────── Store link tokens (Module 2) ───────────────────────────────

function newLinkToken(): string {
  return `lnk_${randomBytes(24).toString("base64url")}`;
}

/**
 * Rotate the store's public-link token: generates a new high-entropy token,
 * keeps the link ACTIVE (a rotation also reactivates a revoked link), and marks
 * rotatedAt. The previous token stops working immediately.
 */
export async function rotateStoreLinkToken(storeId: string): Promise<{ ok: true; value: { token: string; slug: string } } | { ok: false; error: ApiError }> {
  const link = await prisma.publicStoreLink.findUnique({ where: { storeId } });
  if (!link) return { ok: false, error: { type: "not_found", message: "Store link not found" } };
  const token = newLinkToken();
  await prisma.publicStoreLink.update({
    where: { id: link.id },
    data: { token, status: "ACTIVE", rotatedAt: new Date(), revokedAt: null },
  });
  return { ok: true, value: { token, slug: link.slug } };
}

/**
 * Revoke the store's public link: the storefront stops resolving until the
 * owner rotates (reactivates) it. `revokedAt` records when.
 */
export async function revokeStoreLink(storeId: string): Promise<{ ok: true; value: { revoked: true } } | { ok: false; error: ApiError }> {
  const link = await prisma.publicStoreLink.findUnique({ where: { storeId } });
  if (!link) return { ok: false, error: { type: "not_found", message: "Store link not found" } };
  await prisma.publicStoreLink.update({
    where: { id: link.id },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  return { ok: true, value: { revoked: true } };
}

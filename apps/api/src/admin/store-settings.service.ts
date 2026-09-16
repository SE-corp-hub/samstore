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
        receiptHeader: input.receiptHeader ?? null,
        receiptFooter: input.receiptFooter ?? null,
        showVatLabel: input.showVatLabel ?? true,
        dailySalesTargetMinor: input.dailySalesTargetMinor ?? 0,
        hidePricePreOrder: input.hidePricePreOrder ?? false,
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
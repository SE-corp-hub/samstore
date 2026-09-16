// Public storefront service — the public link is the access control.
// Module 2 hardening:
//  - Requires BOTH the human-readable slug AND the high-entropy token for an ACTIVE
//    public link. A missing/wrong/revoked token returns null (→ 404) so we never
//    reveal whether a slug exists or that a token is merely wrong.
//  - Store status/paused handling preserved (closed-store shape stays stable).

import { prisma } from "../persistence/prisma-repositories.js";
import { PrismaCatalogRepository } from "../persistence/prisma-repositories.js";

export type PublicStorePayload =
  | { closed: true; store: Record<string, unknown> }
  | { closed: false; store: Record<string, unknown>; products: unknown[] };

export class PublicStoreService {
  private readonly catalog = new PrismaCatalogRepository();

  /**
   * Resolve a storefront by slug + link token. Returns null when the link is
   * unknown, revoked, inactive, or the token is missing/wrong (all → 404 at the
   * controller). The caller must not distinguish the failure mode.
   */
  async getStore(slug: string, token?: string): Promise<PublicStorePayload | null> {
    const cleanSlug = slug?.trim().toLowerCase() ?? "";
    if (!cleanSlug || !token) return null;

    const link = await prisma.publicStoreLink.findUnique({
      where: { slug: cleanSlug },
      include: { store: { include: { settings: true } } },
    });
    if (!link || link.status !== "ACTIVE") return null;
    if (link.token !== token) return null;

    const store = link.store;

    const base = {
      id: store.id,
      slug: store.slug,
      name: store.name,
      description: store.description,
      currencyCode: store.currencyCode,
      timezone: store.timezone,
      status: store.status,
      guestOrderingEnabled: store.settings?.allowGuestOrders ?? true,
      orderingPaused: store.settings?.orderingPaused ?? false,
      closedStoreMessage:
        store.status !== "ACTIVE"
          ? (store.settings?.closedStoreMessage ?? "This store is temporarily closed")
          : (store.settings?.closedStoreMessage ?? null),
      deliveryFeeMinor: store.settings?.deliveryFeeMinor ?? 0,
      deliveryEnabled: store.settings?.deliveryEnabled ?? true,
      pickupEnabled: store.settings?.pickupEnabled ?? false,
      minOrderAmountMinor: store.settings?.minOrderAmountMinor ?? 0,
      accentColor: store.accentColor,
      bannerText: store.bannerText,
      logoUrl: store.logoUrl,
    };

    if (!base.guestOrderingEnabled || base.orderingPaused) {
      return { closed: true, store: base };
    }

    const products = await this.catalog.listActiveProducts(store.id);
    return {
      closed: false,
      store: base,
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        priceMinor: p.priceMinor,
        category: p.categoryName ? { id: "", name: p.categoryName, slug: "", sortOrder: 0 } : null,
        images: p.images.map((url, i) => ({ url, sortOrder: i })),
        availableQuantity: p.quantityOnHand - p.quantityReserved,
      })),
    };
  }
}

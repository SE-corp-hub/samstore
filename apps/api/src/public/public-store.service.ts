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
    const variants = await this.catalog.getVariantsByProductIds(store.id, products.map((p) => p.id));
    const byProduct = new Map<string, (typeof variants)[number][]>();
    for (const v of variants) {
      const list = byProduct.get(v.productId) ?? [];
      list.push(v);
      byProduct.set(v.productId, list);
    }
    // P3d: related/upsell links — targets must be ACTIVE same-store products; batch-loaded.
    const relations = await this.catalog.getProductRelations(store.id, products.map((p) => p.id), ["related", "upsell"]);
    const targetIds = [...new Set(relations.map((r) => r.targetProductId))];
    const activeTargets = new Map(
      (await this.catalog.getProductsByIds(store.id, targetIds))
        .filter((t) => t.isActive)
        .map((t) => [t.id, t]),
    );
    const linksByProduct = new Map<string, { kind: "related" | "upsell"; productId: string }[]>();
    for (const r of relations) {
      if (!activeTargets.has(r.targetProductId)) continue;
      const list = linksByProduct.get(r.sourceProductId) ?? [];
      list.push({ kind: r.kind, productId: r.targetProductId });
      linksByProduct.set(r.sourceProductId, list);
    }
    const targetSummary = (id: string) => {
      const t = activeTargets.get(id)!;
      return { id: t.id, name: t.name, priceMinor: t.priceMinor, image: t.images[0] ?? null };
    };
    return {
      closed: false,
      store: base,
      products: await Promise.all(products.map(async (p) => {
        const pv = byProduct.get(p.id) ?? [];
        const addons = await this.catalog.getProductAddons(store.id, p.id);
        const links = (linksByProduct.get(p.id) ?? []).map((l) => ({ kind: l.kind, summary: targetSummary(l.productId) }));
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          description: p.description,
          priceMinor: p.priceMinor,
          featured: p.featured,
          tags: p.tags,
          related: links.filter((l) => l.kind === "related").map((l) => l.summary),
          upsell: links.filter((l) => l.kind === "upsell").map((l) => l.summary),
          category: p.categoryName ? { id: "", name: p.categoryName, slug: "", sortOrder: 0 } : null,
          images: p.images.map((url, i) => ({ url, sortOrder: i })),
          availableQuantity: p.quantityOnHand - p.quantityReserved,
          variants: pv.map((v) => ({
            id: v.id,
            name: v.name,
            sku: v.sku,
            priceMinor: v.priceMinor,
            availableQuantity: v.quantityOnHand - v.quantityReserved,
          })),
          addons: addons.map((a) => ({
            id: a.id,
            name: a.name,
            required: a.required,
            options: a.options.map((o) => ({ id: o.id, name: o.name, priceMinor: o.priceMinor })),
          })),
        };
      })),
    };
  }
}

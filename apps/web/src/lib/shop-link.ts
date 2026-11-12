// The customers' shop link: the store's link name plus its key. The key is part of the address: without it the
// shop answers "Store not found", which is what the old "Open storefront" buttons did (they sent the name only).
// Since 2026-11-12 the link is not offered in the app (orders come from the Facebook Pages); the hidden Store Link
// screen and Settings, Online shop still use these.

export interface ShopLinkInfo { slug: string; token: string; status: string }

/** The full address a customer opens. */
export function shopLinkUrl(link: Pick<ShopLinkInfo, "slug" | "token">, origin?: string): string {
  const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  return `${base}/${link.slug}?token=${encodeURIComponent(link.token)}`;
}

/** Is the link switched on? (The owner can switch it off on the Store Link screen.) */
export const shopLinkOn = (link: ShopLinkInfo | null | undefined): link is ShopLinkInfo => !!link && link.status === "ACTIVE";

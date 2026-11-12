// The customers' shop link: the store's link name plus its key. The key is part of the address: without it the
// shop answers "Store not found", which is what the old "Open storefront" buttons did (they sent the name only).
import { useEffect, useState } from "react";
import { API_URL } from "../config";
import { adminHeaders } from "./admin";

export interface ShopLinkInfo { slug: string; token: string; status: string }

/** The full address a customer opens. */
export function shopLinkUrl(link: Pick<ShopLinkInfo, "slug" | "token">, origin?: string): string {
  const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  return `${base}/${link.slug}?token=${encodeURIComponent(link.token)}`;
}

/** Is the link switched on? (The owner can switch it off on the Store Link screen.) */
export const shopLinkOn = (link: ShopLinkInfo | null | undefined): link is ShopLinkInfo => !!link && link.status === "ACTIVE";

/** The working shop address for the open store, or null while loading, when it is switched off, or offline. */
export function useShopLink(storeId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!storeId) return;
    let off = false;
    fetch(`${API_URL}/admin/settings`, { headers: adminHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off && shopLinkOn(d?.publicLink)) setUrl(shopLinkUrl(d.publicLink)); })
      .catch(() => { /* offline: no button */ });
    return () => { off = true; };
  }, [storeId]);
  return url;
}

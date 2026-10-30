// Environment blueprint for the storefront.
// These are PUBLIC values (client-safe); never put secrets here.

/** The customer-facing base URL of the NestJS API. */
// NEXT_PUBLIC_API_URL may be "/backend" (same-origin, proxied by next.config.mjs) so
// phones and other PCs on the network work; server-side code then needs a full URL.
const publicBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";
const serverBase = process.env.API_INTERNAL_URL ?? (publicBase.startsWith("/") ? "http://localhost:4100" : publicBase);

export const API_URL = typeof window === "undefined" ? serverBase : publicBase;
/**
 * The API's own public address (set from API_INTERNAL_URL at build, see next.config.mjs), or "".
 * Only used to wake a sleeping beta API straight from the tablet: Render refuses to wake it for
 * calls that come through the web server's /backend proxy (429 hibernate-rate-limited).
 */
export const API_DIRECT_URL = process.env.NEXT_PUBLIC_API_DIRECT_URL ?? "";
export const DEFAULT_CART_TOKEN = "cart-demo-token"; // seeded demo cart; replaced by per-guest tokens later
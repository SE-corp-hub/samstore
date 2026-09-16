// Environment blueprint for the storefront.
// These are PUBLIC values (client-safe); never put secrets here.

/** The customer-facing base URL of the NestJS API. */
const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";

export const API_URL = apiBase;
export const DEFAULT_CART_TOKEN = "cart-demo-token"; // seeded demo cart; replaced by per-guest tokens later
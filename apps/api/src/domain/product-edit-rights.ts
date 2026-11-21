// 2026-11-21 (owner's ask: "why in manager role can I change the name of the product?"):
// who may change what on a product. The owner sets up the products; a manager may only fix
// the selling price, the reorder level and the picture. Counter logins are already refused
// every product change by the store wall (auth/wall.ts).

const OWNER_ROLES = ["OWNER", "STORE_OWNER", "PLATFORM_ADMIN"];
const OWNER_MANAGER_ROLES = [...OWNER_ROLES, "MANAGER"];

/** Product fields a manager may still change (PATCH /admin/products/:id). */
export const MANAGER_PRODUCT_FIELDS: readonly string[] = ["priceMinor", "reorderThreshold"];

export const OWNER_ONLY_PRODUCT_MESSAGE = "Only the owner can change this. A manager can change the selling price, reorder level and picture.";
const NOT_FOR_STAFF_MESSAGE = "Only the owner or a manager can change products.";

export const ownsProducts = (role: string | undefined): boolean => OWNER_ROLES.includes(role ?? "");

/**
 * Why this login may not make this product change, or null when it may.
 * `owner-only`: add, delete, hide, per-kilo, rack sacks, variants, add-ons.
 * `price-or-photo`: the picture (owner or manager).
 * `edit`: PATCH /admin/products/:id — a manager only with MANAGER_PRODUCT_FIELDS in the body.
 */
export function productEditRefusal(role: string | undefined, what: "owner-only" | "price-or-photo" | "edit", body?: Record<string, unknown> | null): string | null {
  if (ownsProducts(role)) return null;
  if (!OWNER_MANAGER_ROLES.includes(role ?? "")) return NOT_FOR_STAFF_MESSAGE;
  if (what === "price-or-photo") return null;
  if (what === "owner-only") return OWNER_ONLY_PRODUCT_MESSAGE;
  const keys = Object.keys(body ?? {}).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
  return keys.every((k) => MANAGER_PRODUCT_FIELDS.includes(k)) ? null : OWNER_ONLY_PRODUCT_MESSAGE;
}

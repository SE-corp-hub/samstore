// 2026-11-21 (owner's ask: "why in manager role can I change the name of the product?"):
// who may change what on a product. The owner sets up the products; a manager may only change
// the picture, the NAME (2026-11-22, owner's choice) and add a NEW product (2026-11-22: the main price is every store's, so it is the owner's) (2026-11-22: a manager
// at Lipa could not add rice). Changing an existing product's name/cost/setup stays the owner's. Counter logins are already refused
// every product change by the store wall (auth/wall.ts).

const OWNER_ROLES = ["OWNER", "STORE_OWNER", "PLATFORM_ADMIN"];
const OWNER_MANAGER_ROLES = [...OWNER_ROLES, "MANAGER"];

/**
 * Product fields a manager may still change (PATCH /admin/products/:id). 2026-11-22: the NAME only
 * (owner's choice: "Yes, any rice"; the new name shows at every store). The main selling price, cost and
 * setup stay the owner's; a manager sets ITS store's price and reorder level (Products → Manage).
 */
export const MANAGER_PRODUCT_FIELDS: readonly string[] = ["name"];

export const OWNER_ONLY_PRODUCT_MESSAGE = "Only the owner can change this. It changes every store. A manager may change the name, and their own store's price and reorder level.";
const NOT_FOR_STAFF_MESSAGE = "Only the owner or a manager can change products.";

export const ownsProducts = (role: string | undefined): boolean => OWNER_ROLES.includes(role ?? "");

/** The owner or a manager (not a counter login). A counter "New item" made by anyone else waits for the owner's check. */
export const ownerOrManager = (role: string | undefined): boolean => OWNER_MANAGER_ROLES.includes(role ?? "");

/**
 * Why this login may not make this product change, or null when it may.
 * `owner-only`: delete, hide, per-kilo, rack sacks, variants, add-ons.
 * `add` / `price-or-photo`: a new product (2026-11-22: a manager adds rice too, e.g. at Lipa) and the picture — owner or manager.
 * `edit`: PATCH /admin/products/:id — a manager only with MANAGER_PRODUCT_FIELDS in the body.
 */
export function productEditRefusal(role: string | undefined, what: "owner-only" | "add" | "price-or-photo" | "edit", body?: Record<string, unknown> | null): string | null {
  if (ownsProducts(role)) return null;
  if (!OWNER_MANAGER_ROLES.includes(role ?? "")) return NOT_FOR_STAFF_MESSAGE;
  if (what === "price-or-photo" || what === "add") return null;
  if (what === "owner-only") return OWNER_ONLY_PRODUCT_MESSAGE;
  const keys = Object.keys(body ?? {}).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
  return keys.every((k) => MANAGER_PRODUCT_FIELDS.includes(k)) ? null : OWNER_ONLY_PRODUCT_MESSAGE;
}

// M7 — capability-set definitions shared by the guards (tenant-context) and the
// deny matrix (role-permissions). Single source of truth: controllers import
// TENANT_ROLES via tenant-context's re-export; the matrix reads the same arrays.

export type TenantContext = { storeId: string; role: string };

/** Per-store capability sets, expressed in StoreRole terms (+ PLATFORM_ADMIN bypass). */
export const TENANT_ROLES = {
  /** Orders/sales surface + most store features (staff + above). */
  ADMIN: ["OWNER", "MANAGER", "STAFF", "PLATFORM_ADMIN"],
  /** Includes SALES_AGENT (orders inbox, delivery-state transitions). */
  VIEW: ["OWNER", "MANAGER", "STAFF", "SALES_AGENT", "PLATFORM_ADMIN"],
  /** Store config/team/settings — store owner (or platform) only. */
  MANAGE: ["OWNER", "PLATFORM_ADMIN"],
  /** Profit/expense/COGS reports + credit approval + void/refund. */
  OWNER_MANAGER: ["OWNER", "MANAGER", "PLATFORM_ADMIN"],
  /** Delivery (courier) surface. */
  DELIVERY: ["DELIVERY", "PLATFORM_ADMIN"],
} as const;

/** Tenant (store) roles — the only legal `role` values in the matrix. PLATFORM_ADMIN is a bypass, never in rows. */
export const TENANT_ROLES_FOR_MATRIX = Object.freeze(["OWNER", "MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"] as const);

/** Coarse capability-set keys — one per TENANT_ROLES entry. */
export const PERMISSION_KEYS = Object.freeze(Object.keys(TENANT_ROLES)) as readonly (keyof typeof TENANT_ROLES)[];

/** Reverse map: capability-set array reference → its key, for resolveTenant's overlay. */
export const KEY_BY_SET = new Map<readonly string[], string>(
  PERMISSION_KEYS.map((key) => [TENANT_ROLES[key] as readonly string[], key as string]),
);
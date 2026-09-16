// Tenant authorization guard.
// Rule (AGENTS.md): store A must never read store B's data.

export type Principal =
  | { type: "platform_admin" }
  | { type: "store_member"; storeIds: string[] };

export class AccessDeniedError extends Error {
  constructor(storeId: string) {
    super(`Access denied for store ${storeId}`);
    this.name = "AccessDeniedError";
  }
}

export function canAccessStore(principal: Principal, storeId: string): boolean {
  if (principal.type === "platform_admin") return true;
  return principal.storeIds.includes(storeId);
}

/** Throws when the principal has no rights to the store. Call at the top of every store-scoped service. */
export function assertStoreAccess(principal: Principal, storeId: string): void {
  if (!canAccessStore(principal, storeId)) {
    throw new AccessDeniedError(storeId);
  }
}
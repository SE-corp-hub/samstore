// Tenant context — resolves the ACTIVE per-store membership for a request and
// authorizes against that store's membership role (NOT the global JWT role).
//
// Module 1 hardening (project-hardening prompt):
//  - No demo/default tenant fallback. A user with no ACTIVE membership is DENIED.
//  - A multi-store user gets exactly the role granted in the selected store.
//  - PLATFORM_ADMIN is a global bypass that still requires an explicit store target
//    (header) or an ACTIVE membership when no header is provided.

import { HttpException, HttpStatus } from "@nestjs/common";
import { prisma } from "../persistence/prisma-repositories.js";
import type { AuthPrincipal } from "./auth.guard.js";
import { TENANT_ROLES, KEY_BY_SET } from "./capability-sets.js";
import { effectiveRoleSets } from "./role-permissions.js";

export type TenantContext = { storeId: string; role: string };

export { TENANT_ROLES };

export function unauthorized(): never {
  throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
}

/** Narrow `AuthPrincipal | undefined` to `AuthPrincipal` (401 when absent). */
export function requireUser(user: AuthPrincipal | undefined): asserts user is AuthPrincipal {
  if (!user) unauthorized();
}

export function forbidden(message = "Not authorized"): never {
  throw new HttpException({ type: "forbidden", message }, HttpStatus.FORBIDDEN);
}

/**
 * Resolve the tenant store + membership role for a request.
 * Resolution order (same as the legacy controllers, minus the demo fallback):
 *  1. X-Store-Id header — must be an ACTIVE membership (or a platform-admin target).
 *  2. Token storeId claim — if still an ACTIVE membership.
 *  3. First ACTIVE membership.
 * If no ACTIVE membership can be resolved the request is DENIED (403) — never
 * silently routed to a default tenant. When `allowed` is provided, the resolved
 * membership role must be in the set (PLATFORM_ADMIN always passes).
 */
export async function resolveTenant(
  user: AuthPrincipal | undefined,
  headerStoreId?: string,
  allowed?: readonly string[],
): Promise<TenantContext> {
  if (!user) unauthorized();

  let ctx: TenantContext | null = null;

  if (user.role === "PLATFORM_ADMIN") {
    if (headerStoreId) {
      const store = await prisma.store.findUnique({ where: { id: headerStoreId }, select: { id: true } });
      if (!store) forbidden("Not a member of that store");
      ctx = { storeId: headerStoreId, role: "PLATFORM_ADMIN" };
    } else {
      const first = await prisma.userStore.findFirst({ where: { userId: user.sub, status: "ACTIVE" } });
      if (first) ctx = { storeId: first.storeId, role: "PLATFORM_ADMIN" };
    }
  } else {
    if (headerStoreId) {
      const m = await prisma.userStore.findUnique({
        where: { userId_storeId: { userId: user.sub, storeId: headerStoreId } },
      });
      if (!m || m.status !== "ACTIVE") forbidden("Not a member of that store");
      ctx = { storeId: headerStoreId, role: m!.role };
    } else {
      if (user.storeId) {
        const m = await prisma.userStore.findUnique({
          where: { userId_storeId: { userId: user.sub, storeId: user.storeId } },
        });
        if (m && m.status === "ACTIVE") ctx = { storeId: m.storeId, role: m.role };
      }
      if (!ctx) {
        const first = await prisma.userStore.findFirst({ where: { userId: user.sub, status: "ACTIVE" } });
        if (first) ctx = { storeId: first.storeId, role: first.role };
      }
    }
  }

  if (!ctx) forbidden("No active store membership");
  if (allowed) {
    // M7: coarse matrix overlay — when the `allowed` array is one of the TENANT_ROLES
    // capability-set references, read the store's effective set (baseline minus denies).
    // Reference-identity lookup means a caller-passed literal array (tests, ad-hoc
    // checks) falls through to the raw membership check = default-permissive.
    const key = KEY_BY_SET.get(allowed);
    const effective = key ? (await effectiveRoleSets(ctx.storeId))[key as string] ?? allowed : allowed;
    if (!(effective as readonly string[]).includes(ctx.role)) forbidden("Not authorized");
  }
  return ctx;
}

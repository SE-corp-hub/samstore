// M7 — roles × permissions deny matrix.
//
// Coarse model: the matrix keys are exactly the TENANT_ROLES capability-set keys
// (ADMIN/VIEW/MANAGE/OWNER_MANAGER/DELIVERY). A RolePermission row REMOVES a capability
// set from a store role — it can never grant one a role does not have in the baseline
// TENANT_ROLES (deny-only: "never widen a role silently").
//
//   effective[storeId][key] = TENANT_ROLES[key] − { roles denied that key }
//
// Default-permissive: when no rows exist, effective == baseline → today's behaviour
// everywhere. resolveTenant reads effective sets via the reference-shared capability
// set passed by every guard, so NO controller edit is needed.

import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheGet, cacheKey, cacheSet } from "../persistence/ttl-cache.js";
import { TENANT_ROLES, TENANT_ROLES_FOR_MATRIX, PERMISSION_KEYS } from "./capability-sets.js";
import type { ApiError } from "@sam-store/contracts";

export type RolePerm = { role: string; key: string; allowed: boolean };

const CACHE_PREFIX = "role-permissions";
const CACHE_TTL_MS = 30_000;

/** Effective capability sets for a store after applying denies. Shape mirrors TENANT_ROLES (flat string arrays). */
export async function effectiveRoleSets(storeId: string): Promise<Record<string, string[]>> {
  const hit = await cacheGet<Record<string, string[]>>(cacheKey(CACHE_PREFIX, storeId));
  if (hit) return hit;

  const rows = await prisma.rolePermission.findMany({
    where: { storeId, allowed: false },
    select: { role: true, key: true },
  });

  const denied = new Set<string>(rows.map((r) => `${r.role}\u0000${r.key}`));
  const effective: Record<string, string[]> = {};
  for (const [key, roles] of Object.entries(TENANT_ROLES)) {
    effective[key] = (roles as readonly string[]).filter((r) => r === "PLATFORM_ADMIN" || !denied.has(`${r}\u0000${key}`));
  }
  await cacheSet(cacheKey(CACHE_PREFIX, storeId), effective, CACHE_TTL_MS);
  return effective;
}

export async function bustRolePermissionCache(storeId: string): Promise<void> {
  await cacheBust(cacheKey(CACHE_PREFIX, storeId));
}

export type PermissionResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/**
 * Deny-only setter. `allowed=false` upserts a deny row; `allowed=true` restores the
 * baseline (deletes the row). Rejects a "grant" for a role that does not have the
 * capability in the baseline — i.e. widening is impossible, never silent.
 * Every change is audit-logged in the same transaction.
 */
export async function setRolePermission(
  storeId: string,
  actorId: string,
  actorType: string,
  role: string,
  key: string,
  allowed: boolean,
): Promise<PermissionResult<{ role: string; key: string; allowed: boolean }>> {
  const keyValid = PERMISSION_KEYS.includes(key as (keyof typeof TENANT_ROLES));
  if (!keyValid) return { ok: false, error: { type: "validation", errors: [`Unknown permission key: ${key}`] } };
  if (!TENANT_ROLES_FOR_MATRIX.includes(role as (typeof TENANT_ROLES_FOR_MATRIX)[number])) {
    return { ok: false, error: { type: "validation", errors: [`Invalid role for the matrix: ${role}`] } };
  }

  const baseline = TENANT_ROLES[key as keyof typeof TENANT_ROLES] as readonly string[];
  const hasBaseline = baseline.includes(role);
  if (allowed && !hasBaseline) {
    return {
      ok: false,
      error: {
        type: "validation",
        errors: [`Deny-only matrix: role ${role} has no ${key} capability in the baseline; it cannot be granted`],
      },
    };
  }

  const existing = await prisma.rolePermission.findUnique({
    where: { storeId_role_key: { storeId, role, key } },
    select: { id: true, allowed: true },
  });

  await prisma.$transaction(async (tx) => {
    if (allowed && existing) {
      await tx.rolePermission.delete({ where: { id: existing.id } });
    } else if (!allowed && !existing) {
      await tx.rolePermission.create({ data: { storeId, role, key, allowed: false } });
    } else if (!allowed && existing && existing.allowed) {
      await tx.rolePermission.update({ where: { id: existing.id }, data: { allowed: false } });
    }
    await tx.auditLog.create({
      data: {
        storeId,
        actorType,
        actorId,
        action: "role_permission.set",
        entityType: "RolePermission",
        entityId: `${role}:${key}`,
        before: { role, key, allowed: existing?.allowed ?? (allowed ? true : false) },
        after: { role, key, allowed },
      },
    });
  });

  await bustRolePermissionCache(storeId);
  return { ok: true, value: { role, key, allowed } };
}

/** Full role × key matrix for the panel, derived from baseline + rows. */
export async function listRolePermissions(storeId: string): Promise<{ keys: string[]; cells: RolePerm[] }> {
  const rows = await prisma.rolePermission.findMany({
    where: { storeId, allowed: false },
    select: { role: true, key: true },
  });
  const denied = new Set<string>(rows.map((r) => `${r.role}\u0000${r.key}`));
  const cells: RolePerm[] = [];
  for (const role of TENANT_ROLES_FOR_MATRIX) {
    for (const key of PERMISSION_KEYS) {
      const allowed = (TENANT_ROLES[key] as readonly string[]).includes(role) && !denied.has(`${role}\u0000${key}`);
      cells.push({ role, key, allowed });
    }
  }
  return { keys: [...PERMISSION_KEYS], cells };
}
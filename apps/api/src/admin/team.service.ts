// Team management — invite/store-owned staff & agent roles.
// Closes the "all roles are created" gap: OWNER is auto-assigned at store creation;
// MANAGER / STAFF / SALES_AGENT can now be invited and managed here.

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { StoreRole } from "@prisma/client";
import type { ApiError } from "@sam-store/contracts";
import { bustMemberships } from "../auth/membership-cache.js";
import { bustTokenVersion } from "../auth/token-version.js";
import { toE164 } from "../domain/phone.js";
import { accountBelongsToStore, alignGlobalRole } from "../auth/account-scope.js";

export type TeamResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

// Roles that can be invited to a store (OWNER is only assigned at store creation).
export const INVITABLE_STORE_ROLES = ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"] as const;

export class TeamService {
  /**
   * List active members of a store (with user + role), and who added each one and who last
   * reset their PIN or password (from the audit log and the reset history; older members
   * added before this was recorded show only when they joined).
   */
  async list(storeId: string) {
    const rows = await prisma.userStore.findMany({
      where: { storeId, status: "ACTIVE" },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    const ids = rows.map((m) => m.user.id);
    const [invites, pinSets, resets] = await Promise.all([
      prisma.auditLog.findMany({ where: { storeId, action: "member.invite", entityId: { in: ids } }, orderBy: { createdAt: "asc" }, select: { entityId: true, actorId: true, createdAt: true } }),
      prisma.auditLog.findMany({ where: { storeId, action: "member.people.update", entityId: { in: ids }, after: { path: ["pinChanged"], equals: true } }, select: { entityId: true, actorId: true, createdAt: true } }),
      prisma.passwordResetHistory.findMany({ where: { storeId, userId: { in: ids } }, select: { userId: true, resetBy: true, createdAt: true } }),
    ]);
    const actorIds = [...new Set([...invites, ...pinSets].map((a) => a.actorId).concat(resets.map((r) => r.resetBy)).filter((x): x is string => !!x))];
    const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, phone: true, email: true } });
    const who = (id: string | null) => {
      const u = actors.find((a) => a.id === id);
      return u ? u.name || u.phone || u.email || "someone" : null;
    };
    const lastReset = (userId: string) => {
      const all = [
        ...pinSets.filter((p) => p.entityId === userId).map((p) => ({ kind: "PIN" as const, by: p.actorId, at: p.createdAt })),
        ...resets.filter((r) => r.userId === userId).map((r) => ({ kind: "password" as const, by: r.resetBy, at: r.createdAt })),
      ].sort((a, b) => b.at.getTime() - a.at.getTime());
      const last = all[0];
      return last ? { kind: last.kind, by: who(last.by), at: last.at } : null;
    };
    return rows.map((m) => {
      const invite = invites.find((i) => i.entityId === m.user.id);
      return {
        userId: m.user.id, email: m.user.email, name: m.user.name, role: m.role, joinedAt: m.createdAt,
        addedBy: invite ? who(invite.actorId) : null,
        lastReset: lastReset(m.user.id),
      };
    });
  }

  /**
   * Invite a user to a store with a store role.
   * - If the email already has a User account → link membership.
   * - Else create the user (role + a temporary password) so they can log in.
   * New accounts are flagged to change their password on first login.
   */
  async invite(
    storeId: string,
    email: string,
    name: string | null,
    role: string,
    phone?: string | null,
    homeLocationId?: string | null,
    invitedBy?: string,
  ): Promise<TeamResult<{ userId: string; role: string; tempPassword?: string }>> {
    // Rice Ops M2: staff often have no email — a PH mobile number is enough.
    const cleanEmail = email?.trim().toLowerCase() ?? "";
    const cleanPhone = phone ? toE164(phone) : null;
    if (phone && !cleanPhone) {
      return { ok: false, error: { type: "validation", errors: ["A valid Philippine mobile number is required"] } };
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return { ok: false, error: { type: "validation", errors: ["A valid email is required"] } };
    }
    if (!cleanEmail && !cleanPhone) {
      return { ok: false, error: { type: "validation", errors: ["A mobile number or an email is required"] } };
    }
    if (!(INVITABLE_STORE_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: { type: "validation", errors: ["Role must be MANAGER, STAFF, SALES_AGENT, or DELIVERY"] } };
    }
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    if (homeLocationId) {
      const loc = await prisma.warehouse.findFirst({ where: { id: homeLocationId, storeId, isActive: true }, select: { id: true } });
      if (!loc) return { ok: false, error: { type: "validation", errors: ["Unknown location"] } };
    }

    // Existing user? (by phone first, then email)
    let user = cleanPhone ? await prisma.user.findUnique({ where: { phone: cleanPhone } }) : null;
    if (!user && cleanEmail) user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    let tempPassword: string | undefined;
    if (!user) {
      // Create a user account with a one-time temp password (owner communicates it out-of-band).
      tempPassword = randomBytes(9).toString("base64url");
      user = await prisma.user.create({
        data: {
          email: cleanEmail || null,
          phone: cleanPhone,
          name: name?.trim() || null,
          passwordHash: await bcrypt.hash(tempPassword, 12),
          role,
          mustChangePassword: true,
        },
      });
    }

    // Upsert the membership (re-activate if it was deactivated).
    const membership = await prisma.userStore.upsert({
      where: { userId_storeId: { userId: user.id, storeId } },
      update: { role: role as StoreRole, status: "ACTIVE", ...(homeLocationId !== undefined ? { homeLocationId: homeLocationId || null } : {}) },
      create: { userId: user.id, storeId, role: role as StoreRole, status: "ACTIVE", homeLocationId: homeLocationId || null },
    });

    // Align the account-wide role only when this store is the account's only store
    // (M11: inviting someone from another store must not rewrite their account).
    await alignGlobalRole(prisma, user.id, storeId, role);
    // Shown in Team as "Added by …".
    await prisma.auditLog.create({
      data: { storeId, actorType: "USER", actorId: invitedBy ?? null, action: "member.invite", entityType: "User", entityId: user.id, after: { role, newAccount: !!tempPassword } },
    });

    await bustMemberships();
    return { ok: true, value: { userId: user.id, role: membership.role, ...(tempPassword ? { tempPassword } : {}) } };
  }

  /** Change a member's store role. */
  async changeRole(storeId: string, userId: string, role: string): Promise<TeamResult<{ userId: string; role: string }>> {
    if (!(INVITABLE_STORE_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: { type: "validation", errors: ["Role must be MANAGER, STAFF, SALES_AGENT, or DELIVERY"] } };
    }
    const membership = await prisma.userStore.findUnique({ where: { userId_storeId: { userId, storeId } } });
    if (!membership) return { ok: false, error: { type: "not_found", message: "Member not part of this store" } };
    if (membership.role === "OWNER") return { ok: false, error: { type: "conflict", message: "Cannot change the owner's role" } };

    const updated = await prisma.userStore.update({
      where: { userId_storeId: { userId, storeId } },
      data: { role: role as StoreRole },
    });
    await alignGlobalRole(prisma, userId, storeId, role); // M11: single-store accounts only
    await bustMemberships();
    return { ok: true, value: { userId, role: updated.role } };
  }

  /** Deactivate a member (soft removal). */
  async deactivate(storeId: string, userId: string): Promise<TeamResult<{ userId: string }>> {
    const membership = await prisma.userStore.findUnique({ where: { userId_storeId: { userId, storeId } } });
    if (!membership) return { ok: false, error: { type: "not_found", message: "Member not part of this store" } };
    if (membership.role === "OWNER") return { ok: false, error: { type: "conflict", message: "Cannot deactivate the owner" } };
    await prisma.userStore.update({ where: { userId_storeId: { userId, storeId } }, data: { status: "DEACTIVATED" } });
    // Rice Ops M2: removing someone signs them out on every phone at once — M11: unless
    // another store still uses the account (this store's access is already gone with
    // the membership; signing them out of the other store is not this store's call).
    if (await accountBelongsToStore(prisma, userId, storeId)) {
      await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
      await bustTokenVersion(userId);
    }
    await bustMemberships();
    return { ok: true, value: { userId } };
  }
}
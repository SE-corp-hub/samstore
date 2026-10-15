// Auth repository — user persistence.

import { prisma } from "../persistence/prisma-repositories.js";
import { toE164 } from "../domain/phone.js";
import { StoreRole } from "@prisma/client";

export interface AuthUserRecord {
  id: string;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
  passwordHash: string;
  name: string | null;
  role: string;
  /** store memberships: storeId + role */
  memberships: { storeId: string; role: string }[];
  /** v6: set by an admin password reset — forces a password change on next login. */
  mustChangePassword?: boolean;
  /** Rice Ops M2: copied into the JWT as `tv`. */
  tokenVersion?: number;
}

export interface MembershipLookup {
  storeId: string;
  role: string;
  status: string;
}

export interface AuthRepository {
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  /** A1: resolve a user by its raw identifier — normalized phone E.164 or email. */
  findByIdentifier(identifier: string): Promise<AuthUserRecord | null>;
  createUser(
    email: string | null,
    phone: string | null,
    passwordHash: string,
    name: string | null,
    role: string,
    storeBinding?: { storeId: string; role: string },
  ): Promise<AuthUserRecord>;
  /**
   * v6 user-management helpers (implemented by PrismaAuthRepository).
   * Optional so legacy in-memory test doubles of AuthRepository keep compiling;
   * AuthService guards with a runtime check before using them.
   */
  resetPassword?(userId: string, passwordHash: string): Promise<void>;
  setMustChange?(userId: string, mustChange: boolean): Promise<void>;
  findMemberships?(userId: string): Promise<MembershipLookup[]>;
  updateProfile?(userId: string, name: string | null, email: string): Promise<void>;
  /**
   * Rice Ops M11 — password login lockout. Counts one try BEFORE the password is
   * checked, in one guarded UPDATE (parallel guesses cannot slip past the limit).
   * Optional so in-memory test doubles keep working without a database.
   */
  reserveLoginTry?(userId: string): Promise<LoginTry>;
  clearLoginFails?(userId: string): Promise<void>;
}

/** used = tries counted so far after this one (0 means this try just started a lock). */
export type LoginTry = { locked: true; secondsLeft: number } | { locked: false; used: number };

export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MINUTES = 15;

export class PrismaAuthRepository implements AuthRepository {
  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    if (!email) return null;
    return this.findByIdentifier(email);
  }

  /** Resolves by normalized phone (E.164) first, else by lowercased email. */
  async findByIdentifier(identifier: string): Promise<AuthUserRecord | null> {
    const raw = (identifier ?? "").trim();
    const phone = toE164(raw);
    const id = phone || raw.toLowerCase();
    if (!id) return null;
    const u = await prisma.user.findFirst({
      where: { OR: [{ email: id }, { phone: id }] },
      include: { memberships: { select: { storeId: true, role: true } } },
    });
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      phone: u.phone,
      phoneVerified: u.phoneVerified,
      passwordHash: u.passwordHash,
      name: u.name,
      role: u.role ?? "STORE_OWNER",
      memberships: u.memberships.map((m) => ({ storeId: m.storeId, role: m.role })),
      mustChangePassword: u.mustChangePassword ?? false,
      tokenVersion: u.tokenVersion ?? 0,
    };
  }

  async createUser(
    email: string | null,
    phone: string | null,
    passwordHash: string,
    name: string | null,
    role: string,
    storeBinding?: { storeId: string; role: string },
  ): Promise<AuthUserRecord> {
    const u = await prisma.user.create({
      data: {
        email: email?.toLowerCase() ?? null,
        phone,
        passwordHash,
        name,
        role,
        ...(storeBinding
          ? {
              memberships: {
                create: { storeId: storeBinding.storeId, role: storeBinding.role as StoreRole },
              },
            }
          : {}),
      },
      include: { memberships: { select: { storeId: true, role: true } } },
    });
    return {
      id: u.id,
      email: u.email,
      phone: u.phone,
      phoneVerified: u.phoneVerified,
      passwordHash: u.passwordHash,
      name: u.name,
      role: u.role,
      memberships: u.memberships.map((m) => ({ storeId: m.storeId, role: m.role })),
      mustChangePassword: u.mustChangePassword ?? false,
    };
  }

  /** Replace the user's bcrypt password hash (admin password reset / self change). */
  async resetPassword(userId: string, passwordHash: string): Promise<void> {
    // A new password also lifts a password-login lock (M11).
    await prisma.user.update({ where: { id: userId }, data: { passwordHash, loginFailedCount: 0, loginLockedUntil: null } });
  }

  async reserveLoginTry(userId: string): Promise<LoginTry> {
    const rows = await prisma.$queryRaw<{ loginFailedCount: number }[]>`
      UPDATE "User"
         SET "loginFailedCount" = CASE WHEN "loginFailedCount" + 1 >= ${LOGIN_MAX_FAILS}::int THEN 0 ELSE "loginFailedCount" + 1 END,
             "loginLockedUntil" = CASE WHEN "loginFailedCount" + 1 >= ${LOGIN_MAX_FAILS}::int
                                       THEN now() + make_interval(mins => ${LOGIN_LOCK_MINUTES}::int) ELSE "loginLockedUntil" END
       WHERE id = ${userId} AND ("loginLockedUntil" IS NULL OR "loginLockedUntil" <= now())
   RETURNING "loginFailedCount"`;
    if (rows.length > 0) return { locked: false, used: Number(rows[0]!.loginFailedCount) };
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { loginLockedUntil: true } });
    const left = u?.loginLockedUntil ? Math.ceil((u.loginLockedUntil.getTime() - Date.now()) / 1000) : 0;
    return { locked: true, secondsLeft: Math.max(1, left) };
  }

  async clearLoginFails(userId: string): Promise<void> {
    await prisma.user.updateMany({ where: { id: userId, OR: [{ loginFailedCount: { gt: 0 } }, { loginLockedUntil: { not: null } }] }, data: { loginFailedCount: 0, loginLockedUntil: null } });
  }

  /** v6: set/unset the must-change-password-on-next-login flag. */
  async setMustChange(userId: string, mustChange: boolean): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { mustChangePassword: mustChange } });
  }

  /** v6: update a user's own profile (name/email). Email uniqueness is the controller's job. */
  async updateProfile(userId: string, name: string | null, email: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { name, email } });
  }

  /** All store memberships for a user (any status). */
  async findMemberships(userId: string): Promise<MembershipLookup[]> {
    const rows = await prisma.userStore.findMany({ where: { userId } });
    return rows.map((m) => ({ storeId: m.storeId, role: m.role, status: m.status }));
  }
}

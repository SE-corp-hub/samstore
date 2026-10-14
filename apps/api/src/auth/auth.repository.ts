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
}

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
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
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

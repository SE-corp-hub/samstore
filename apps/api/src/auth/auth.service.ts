// Auth service — register/login and JWT issuance + v6 user-management operations.

import type { ApiError } from "@sam-store/contracts";
import { randomBytes } from "node:crypto";
import { StoreRole } from "@prisma/client";
import { hashPassword, verifyPassword, signToken, AuthConfig } from "./auth.domain.js";
import { toE164 } from "../domain/phone.js";
import {
  type AuthRepository,
} from "./auth.repository.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { bustMemberships } from "./membership-cache.js";
import { PIN_LOCK_MINUTES, PIN_MAX_FAILS, pinLockSecondsLeft } from "../domain/people.js";

/** bcrypt of a random never-used PIN; compared against when the number has no PIN, to keep timing flat. */
const DUMMY_PIN_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.8DqQ6E9QeE3n9gVnK6S2r1a4VJ7e";

export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** v6: login is refused with this shape when the user's password was reset by an admin. */
export type MustChangePasswordError = {
  type: "forbidden";
  message: string;
  mustChangePassword: true;
};

export type LoginResult<T> = AuthResult<T> | { ok: false; error: MustChangePasswordError };

/** DI token. */
export const AUTH_SERVICE = Symbol("AUTH_SERVICE");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * D7 kill switch — app-level, store-independent. When true, registration REQUIRES
 * a phone and email becomes optional-with-not-required; when false (default) the
 * legacy email-required register flow is unchanged. Read once per call so an
 * operator can flip it at runtime without a rebuild.
 */
export function registerRequiresPhone(): boolean {
  return process.env.IDENTITY_REQUIRE_PHONE === "true";
}

export const ALLOWED_ROLES = ["STORE_OWNER", "PLATFORM_ADMIN", "MANAGER", "STAFF", "SALES_AGENT"] as const;

/** v6 B2 — roles a platform admin / owner may assign to a store member. */
export const MANAGEABLE_STORE_ROLES = ["OWNER", "MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"] as const;

export type AuthUserSummary = { id: string; email: string | null; phone: string | null; name: string | null };

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly config: AuthConfig,
  ) {}

  async register(input: {
    email?: string;
    phone?: string;
    password: string;
    passwordConfirm?: string;
    name?: string;
  }): Promise<AuthResult<{ token: string; user: AuthUserSummary }>> {
    const email = (input.email ?? "").trim().toLowerCase();
    const phone = toE164(input.phone);
    // D7 kill switch: with identityRequirePhone OFF (default) the legacy
    // email-required register flow is unchanged; phone becomes the required
    // identity only when the operator flips the flag.
    const requirePhone = registerRequiresPhone();
    if (requirePhone) {
      // Phone-first mode: a valid PH mobile is required; email is optional.
      if (!phone) {
        return { ok: false, error: { type: "validation", errors: ["A valid Philippine mobile number is required"] } };
      }
    } else {
      // Legacy mode (D7): email is required, exactly as before the module; phone is extra.
      if (!EMAIL_RE.test(email)) {
        return { ok: false, error: { type: "validation", errors: ["A valid email is required"] } };
      }
    }
    if (input.password?.length < 8) {
      return { ok: false, error: { type: "validation", errors: ["Password must be at least 8 characters"] } };
    }
    // A mistyped password cannot be recovered by the owner, so the confirmation is
    // verified here as well as in the form — same rule change-password already uses.
    if (input.password !== (input.passwordConfirm ?? input.password)) {
      return { ok: false, error: { type: "validation", errors: ["Passwords do not match"] } };
    }
    // Module 1 (invite/admin-created owner only): public registration NEVER binds a
    // store or accepts a client-supplied role. Any storeId/role sent by a caller is
    // ignored; the user is created as a bare STORE_OWNER-role account with NO
    // membership. A platform admin (or existing owner) later creates a store and
    // binds this user as OWNER via /admin/stores, or invites them via /admin/team.
    const role = "STORE_OWNER";

    if (email) {
      const byEmail = await this.repo.findByEmail(email);
      if (byEmail) return { ok: false, error: { type: "conflict", message: "Email already registered" } };
    }
    if (phone) {
      const byPhone = await this.repo.findByIdentifier(phone);
      if (byPhone) return { ok: false, error: { type: "conflict", message: "This mobile number is already registered" } };
    }

    const passwordHash = await hashPassword(input.password);
    try {
      const user = await this.repo.createUser(email || null, phone || null, passwordHash, input.name ?? null, role);
      const token = signToken(
        {
          sub: user.id,
          role: user.role,
          email: user.email ?? "",
          phone: user.phone ?? undefined,
          storeId: undefined,
        },
        this.config,
      );
      return {
        ok: true,
        value: { token, user: { id: user.id, email: user.email, phone: user.phone, name: user.name } },
      };
    } catch (e) {
      // Race on the unique constraint → same normalized phone/email registered twice.
      if ((e as { code?: string }).code === "P2002") {
        return { ok: false, error: { type: "conflict", message: "Email or mobile number already registered" } };
      }
      throw e;
    }
  }

  /** Accepts `identifier` (phone or email) or the legacy `email` key. */
  async login(input: {
    identifier?: string;
    email?: string;
    password: string;
  }): Promise<LoginResult<{ token: string; user: AuthUserSummary }>> {
    const identifier = (input.identifier ?? input.email ?? "").trim().toLowerCase();
    const user = await this.repo.findByIdentifier(identifier);
    if (!user) return { ok: false, error: { type: "unauthorized", message: "Invalid phone/email or password" } };
    const valid = await verifyPassword(input.password ?? "", user.passwordHash);
    if (!valid) return { ok: false, error: { type: "unauthorized", message: "Invalid phone/email or password" } };

    // v6 B3: an admin reset the password → the temp password only unlocks the
    // must-change flow. No token is issued until the user sets a new password.
    if (user.mustChangePassword) {
      return {
        ok: false,
        error: {
          type: "forbidden",
          message: "You must change your password on first login",
          mustChangePassword: true,
        },
      };
    }

    // v6 A2: store-wide restriction — when a non-platform user's ACTIVE memberships
    // ALL belong to restricted stores (SUSPENDED/ARCHIVED/CLOSED), refuse login.
    // Platform admins bypass; storeless users (no memberships) are never blocked.
    if (user.role !== "PLATFORM_ADMIN" && user.memberships.length > 0) {
      const memberships = await prisma.userStore.findMany({
        where: { userId: user.id, status: "ACTIVE" },
        select: { store: { select: { status: true } } },
      });
      if (memberships.length > 0 && memberships.every((m) => m.store.status !== "ACTIVE")) {
        return {
          ok: false,
          error: { type: "forbidden", message: "Your store is suspended or closed" },
        };
      }
    }

    const token = signToken(
      {
        sub: user.id,
        role: user.role,
        email: user.email ?? "",
        phone: user.phone ?? undefined,
        storeId: user.memberships[0]?.storeId,
        tv: user.tokenVersion ?? 0,
      },
      this.config,
    );
    return {
      ok: true,
      value: { token, user: { id: user.id, email: user.email, phone: user.phone, name: user.name } },
    };
  }

  /**
   * Rice Ops M2 — quick login on a staff phone: mobile number + 4-digit PIN.
   * Each try is counted BEFORE the PIN is checked, in one guarded UPDATE, so even a
   * burst of parallel guesses gets at most 5 tries; the 5th wrong one locks PIN login
   * for 15 minutes (the password login still works, and the owner can unlock).
   */
  async pinLogin(input: { phone?: string; pin?: string }): Promise<AuthResult<{ token: string; user: AuthUserSummary }>> {
    const generic = { ok: false as const, error: { type: "unauthorized" as const, message: "Mali ang numero o PIN" } };
    const phone = toE164(input.phone);
    const pin = typeof input.pin === "string" ? input.pin : "";
    const user = phone
      ? await prisma.user.findUnique({
          where: { phone },
          select: { id: true, email: true, phone: true, name: true, role: true, pinHash: true, tokenVersion: true },
        })
      : null;
    if (!user?.pinHash || !/^\d{4}$/.test(pin)) {
      await verifyPassword(pin || "0000", DUMMY_PIN_HASH); // same time whether or not the number exists
      return generic;
    }
    const reserved = await prisma.$queryRaw<{ pinFailedCount: number }[]>`
      UPDATE "User"
         SET "pinFailedCount" = CASE WHEN "pinFailedCount" + 1 >= ${PIN_MAX_FAILS}::int THEN 0 ELSE "pinFailedCount" + 1 END,
             "pinLockedUntil" = CASE WHEN "pinFailedCount" + 1 >= ${PIN_MAX_FAILS}
                                     THEN now() + make_interval(mins => ${PIN_LOCK_MINUTES}::int) ELSE "pinLockedUntil" END
       WHERE id = ${user.id} AND ("pinLockedUntil" IS NULL OR "pinLockedUntil" <= now())
   RETURNING "pinFailedCount"`;
    if (reserved.length === 0) {
      const locked = await prisma.user.findUnique({ where: { id: user.id }, select: { pinLockedUntil: true } });
      const mins = Math.max(1, Math.ceil(pinLockSecondsLeft(locked?.pinLockedUntil, new Date()) / 60));
      return { ok: false, error: { type: "rate_limited", message: `Naka-lock ang PIN. Subukan ulit sa loob ng ${mins} minuto, o magpa-unlock sa may-ari.` } };
    }
    if (!(await verifyPassword(pin, user.pinHash))) {
      const used = reserved[0]!.pinFailedCount;
      if (used === 0) {
        return { ok: false, error: { type: "rate_limited", message: `Naka-lock ang PIN nang ${PIN_LOCK_MINUTES} minuto (${PIN_MAX_FAILS} maling subok).` } };
      }
      return { ok: false, error: { type: "unauthorized", message: `Mali ang numero o PIN. ${PIN_MAX_FAILS - used} subok na lang.` } };
    }
    await prisma.user.update({ where: { id: user.id }, data: { pinFailedCount: 0, pinLockedUntil: null } });

    // PIN login is for store people: an ACTIVE membership in an ACTIVE store is required.
    const memberships = await prisma.userStore.findMany({
      where: { userId: user.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { storeId: true, store: { select: { status: true } } },
    });
    const usable = memberships.find((m) => m.store.status === "ACTIVE");
    if (!usable && user.role !== "PLATFORM_ADMIN") {
      return { ok: false, error: { type: "forbidden", message: "Walang aktibong tindahan ang account na ito" } };
    }
    const token = signToken(
      { sub: user.id, role: user.role, email: user.email ?? "", phone: user.phone ?? undefined, storeId: usable?.storeId, tv: user.tokenVersion },
      this.config,
    );
    return { ok: true, value: { token, user: { id: user.id, email: user.email, phone: user.phone, name: user.name } } };
  }

  // ─────────────────────────────── v6 user management ───────────────────────────────

  /**
   * v6 B3 — admin reset of a member's password. Generates a strong temp password
   * (12 chars, base64url) or honors a provided one (≥ 10 chars), sets the
   * must-change-on-next-login flag, and records a PasswordResetHistory audit row.
   * The temp password is returned exactly once — never logged.
   */
  async resetPassword(input: {
    userId: string;
    storeId: string;
    resetBy: string;
    newPassword?: string;
  }): Promise<AuthResult<{ userId: string; tempPassword: string; mustChangePassword: true }>> {
    const admin = this.adminRepo();
    const membership = (await admin.findMemberships(input.userId)).find((m) => m.storeId === input.storeId);
    if (!membership) {
      return { ok: false, error: { type: "not_found", message: "User is not a member of this store" } };
    }

    const provided = input.newPassword?.trim() ?? "";
    let temp: string;
    if (provided.length > 0) {
      if (provided.length < 10) {
        return { ok: false, error: { type: "validation", errors: ["Temporary password must be at least 10 characters"] } };
      }
      temp = provided;
    } else {
      temp = randomBytes(9).toString("base64url").replace(/=+$/, "");
    }

    await admin.resetPassword(input.userId, await hashPassword(temp));
    await admin.setMustChange(input.userId, true);
    await prisma.passwordResetHistory.create({
      data: { userId: input.userId, storeId: input.storeId, resetBy: input.resetBy },
    });
    return { ok: true, value: { userId: input.userId, tempPassword: temp, mustChangePassword: true } };
  }

  /**
   * v6 — self-service password change (drives the must-change-on-next-login flow).
   * Verifies the current password, installs the new hash, clears the must-change
   * flag, and returns a fresh token.
   */
  async changePassword(input: {
    identifier?: string;
    email?: string;
    currentPassword: string;
    newPassword: string;
    newPasswordConfirm?: string;
  }): Promise<AuthResult<{ token: string; user: AuthUserSummary }>> {
    const identifier = (input.identifier ?? input.email ?? "").trim();
    if (!input.newPassword || input.newPassword.length < 8) {
      return { ok: false, error: { type: "validation", errors: ["Password must be at least 8 characters"] } };
    }
    if (input.newPassword !== (input.newPasswordConfirm ?? input.newPassword)) {
      return { ok: false, error: { type: "validation", errors: ["New passwords do not match"] } };
    }
    const user = await this.repo.findByIdentifier(identifier);
    if (!user) return { ok: false, error: { type: "unauthorized", message: "Invalid phone/email or password" } };
    const valid = await verifyPassword(input.currentPassword ?? "", user.passwordHash);
    if (!valid) return { ok: false, error: { type: "unauthorized", message: "Current password is incorrect" } };

    const admin = this.adminRepo();
    await admin.resetPassword(user.id, await hashPassword(input.newPassword));
    await admin.setMustChange(user.id, false);

    const token = signToken(
      {
        sub: user.id,
        role: user.role,
        email: user.email ?? "",
        phone: user.phone ?? undefined,
        storeId: user.memberships[0]?.storeId,
        tv: user.tokenVersion ?? 0,
      },
      this.config,
    );
    return { ok: true, value: { token, user: { id: user.id, email: user.email, phone: user.phone, name: user.name } } };
  }

  /** v6: update the logged-in user's own profile (name/email). Email uniqueness check in service. */
  async updateProfile(input: {
    userId: string;
    email: string;
    name?: string | null;
  }): Promise<AuthResult<{ id: string; email: string; name: string | null }>> {
    const email = input.email?.trim().toLowerCase() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: { type: "validation", errors: ["A valid email is required"] } };
    }
    const existing = await this.repo.findByEmail(email);
    if (existing && existing.id !== input.userId) {
      return { ok: false, error: { type: "conflict", message: "Email already in use by another account" } };
    }
    const admin = this.adminRepo();
    await admin.updateProfile(input.userId, input.name?.trim() ? input.name.trim() : null, email);
    return { ok: true, value: { id: input.userId, email, name: input.name?.trim() || null } };
  }

  /**
   * v6 B2 — change a member's store role. The last ACTIVE OWNER can never be
   * demoted or removed. (The self-membership guard lives in the controller.)
   */
  async changeRole(input: {
    storeId: string;
    userId: string;
    role: string;
  }): Promise<AuthResult<{ userId: string; role: string }>> {
    if (!(MANAGEABLE_STORE_ROLES as readonly string[]).includes(input.role)) {
      return {
        ok: false,
        error: { type: "validation", errors: ["Role must be OWNER, MANAGER, STAFF, SALES_AGENT, or DELIVERY"] },
      };
    }
    const membership = (await this.adminRepo().findMemberships(input.userId)).find((m) => m.storeId === input.storeId);
    if (!membership) {
      return { ok: false, error: { type: "not_found", message: "User is not a member of this store" } };
    }

    if (membership.role === "OWNER" && input.role !== "OWNER") {
      const owners = await prisma.userStore.count({
        where: { storeId: input.storeId, role: "OWNER", status: "ACTIVE" },
      });
      if (owners <= 1) {
        return { ok: false, error: { type: "conflict", message: "Cannot demote the last active owner" } };
      }
    }

    const updated = await prisma.userStore.update({
      where: { userId_storeId: { userId: input.userId, storeId: input.storeId } },
      data: { role: input.role as StoreRole },
    });
    // Keep the user's global role claim aligned (same convention as TeamService).
    await prisma.user.update({
      where: { id: input.userId },
      data: { role: input.role === "OWNER" ? "STORE_OWNER" : input.role },
    });
    await bustMemberships();
    return { ok: true, value: { userId: input.userId, role: updated.role } };
  }

  /**
   * Platform admin user creation — mints a user (with a one-time temp password and
   * must-change flag) and optionally binds them to a store. An email that already
   * has an account is bound to the store instead: no password or flag change.
   * Without a store there is nothing to bind, so a duplicate email conflicts.
   */
  async createPlatformUser(input: {
    name?: string | null;
    email: string;
    phone?: string | null;
    storeId?: string | null;
    role: string;
    actorId: string;
  }): Promise<AuthResult<{ userId: string; email: string; role: string; tempPassword?: string }>> {
    const email = (input.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return { ok: false, error: { type: "validation", errors: ["A valid email is required"] } };
    }
    if (!(MANAGEABLE_STORE_ROLES as readonly string[]).includes(input.role)) {
      return {
        ok: false,
        error: { type: "validation", errors: ["Role must be OWNER, MANAGER, STAFF, SALES_AGENT, or DELIVERY"] },
      };
    }
    const phone = toE164(input.phone) || null;
    const storeId = input.storeId ?? null;
    if (storeId) {
      const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
      if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    }

    const existing = await this.repo.findByEmail(email);
    if (existing && !storeId) {
      return { ok: false, error: { type: "conflict", message: "Email already registered" } };
    }
    if (phone) {
      const byPhone = await this.repo.findByIdentifier(phone);
      if (byPhone && byPhone.id !== existing?.id) {
        return { ok: false, error: { type: "conflict", message: "This mobile number is already registered" } };
      }
    }

    try {
      const { userId, tempPassword } = await prisma.$transaction(async (tx) => {
        let userId: string;
        let tempPassword: string | undefined;
        if (existing) {
          userId = existing.id;
          // Align the bound user's global role claim with the membership role
          // (same convention as changeRole).
          await tx.user.update({
            where: { id: existing.id },
            data: { role: input.role === "OWNER" ? "STORE_OWNER" : input.role },
          });
        } else {
          tempPassword = randomBytes(9).toString("base64url");
          const user = await tx.user.create({
            data: {
              email,
              phone,
              passwordHash: await hashPassword(tempPassword),
              name: input.name?.trim() || null,
              role: input.role === "OWNER" ? "STORE_OWNER" : input.role,
              mustChangePassword: true,
            },
            select: { id: true },
          });
          userId = user.id;
        }

        if (storeId) {
          await tx.userStore.upsert({
            where: { userId_storeId: { userId, storeId } },
            update: { role: input.role as StoreRole, status: "ACTIVE" },
            create: { userId, storeId, role: input.role as StoreRole, status: "ACTIVE" },
          });
        }

        await tx.auditLog.create({
          data: {
            storeId: storeId ?? null,
            actorType: "platform_admin",
            actorId: input.actorId,
            action: "platform.user.create",
            entityType: "User",
            entityId: userId,
            after: { role: input.role },
          },
        });

        return { userId, tempPassword };
      });

      await bustMemberships();
    return { ok: true, value: { userId, email, role: input.role, ...(tempPassword ? { tempPassword } : {}) } };
    } catch (e) {
      // Race on the unique constraint → same normalized email/phone created twice.
      if ((e as { code?: string }).code === "P2002") {
        return { ok: false, error: { type: "conflict", message: "Email or mobile number already registered" } };
      }
      throw e;
    }
  }

  /**
   * v6 A3 — per-user access within a store. A DEACTIVATED membership drops out of
   * tenant resolution immediately (resolveStoreId only counts ACTIVE memberships),
   * locking the user out of that store while leaving other stores usable.
   */
  async setUserAccess(input: {
    storeId: string;
    userId: string;
    status: "ACTIVE" | "DEACTIVATED";
  }): Promise<AuthResult<{ userId: string; storeId: string; status: string }>> {
    const membership = (await this.adminRepo().findMemberships(input.userId)).find((m) => m.storeId === input.storeId);
    if (!membership) {
      return { ok: false, error: { type: "not_found", message: "User is not a member of this store" } };
    }

    if (input.status === "DEACTIVATED" && membership.role === "OWNER") {
      const owners = await prisma.userStore.count({
        where: { storeId: input.storeId, role: "OWNER", status: "ACTIVE" },
      });
      if (owners <= 1) {
        return { ok: false, error: { type: "conflict", message: "Cannot deactivate the last active owner" } };
      }
    }

    const updated = await prisma.userStore.update({
      where: { userId_storeId: { userId: input.userId, storeId: input.storeId } },
      data: { status: input.status },
    });
    await bustMemberships();
    return { ok: true, value: { userId: input.userId, storeId: input.storeId, status: updated.status } };
  }

  /**
   * v6 — the user-management repo helpers live on PrismaAuthRepository. The
   * legacy in-memory test double of AuthRepository doesn't implement them, so
   * they are optional on the interface; fail loudly if ever misused.
   */
  private adminRepo(): Required<AuthRepository> {
    if (!this.repo.resetPassword || !this.repo.setMustChange || !this.repo.findMemberships) {
      throw new Error("AuthRepository does not support user-management operations (PrismaAuthRepository required)");
    }
    return this.repo as Required<AuthRepository>;
  }
}

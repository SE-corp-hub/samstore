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
      },
      this.config,
    );
    return {
      ok: true,
      value: { token, user: { id: user.id, email: user.email, phone: user.phone, name: user.name } },
    };
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
    email: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<AuthResult<{ token: string; user: AuthUserSummary }>> {
    const email = input.email?.trim().toLowerCase() ?? "";
    if (!input.newPassword || input.newPassword.length < 8) {
      return { ok: false, error: { type: "validation", errors: ["Password must be at least 8 characters"] } };
    }
    const user = await this.repo.findByEmail(email);
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
    return { ok: true, value: { userId: input.userId, role: updated.role } };
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
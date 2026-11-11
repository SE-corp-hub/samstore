// NestJS guard — authenticates the Bearer token and exposes the principal.
// Returns the verified token (the passport for tenant-scoped authorization).

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { verifyToken, InvalidTokenError } from "./auth.domain.js";
import { getMemberships } from "./membership-cache.js";
import { getTokenVersion, tokenVersionCurrent } from "./token-version.js";
import { effectiveRoleSets } from "./role-permissions.js";

/** Store ids are cuids; anything else in the header is left for resolveTenant to refuse. */
const STORE_ID = /^[a-z0-9]{20,40}$/;

export interface AuthPrincipal {
  sub: string;
  role: string;
  email: string;
  storeId?: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject("AUTH_CONFIG") private readonly config: { jwtSecret: string }) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException("Missing bearer token");

    let verified: ReturnType<typeof verifyToken>;
    try {
      verified = verifyToken(token, { jwtSecret: this.config.jwtSecret, jwtExpiresIn: "7d" });
    } catch (e) {
      if (e instanceof InvalidTokenError) throw new UnauthorizedException(e.message);
      throw e;
    }
    // The lookups below are independent reads: ask them at the same time, so a request after
    // the 10 s caches expire waits for one database round trip instead of three. The store's
    // role overrides are only read into their cache here; resolveTenant decides with them.
    const isPlatform = verified.role === "PLATFORM_ADMIN";
    const headerStore = req.headers["x-store-id"];
    const [storedTv, memberships] = await Promise.all([
      getTokenVersion(verified.sub),
      isPlatform ? Promise.resolve([]) : getMemberships(verified.sub),
      typeof headerStore === "string" && STORE_ID.test(headerStore) ? effectiveRoleSets(headerStore).catch(() => undefined) : undefined,
    ]);
    // Rice Ops M2: a PIN reset (or removal) bumps tokenVersion → older tokens stop working.
    if (!tokenVersionCurrent(verified.tv, storedTv)) {
      throw new UnauthorizedException("Session ended. Please log in again.");
    }

    (req as unknown as { user: AuthPrincipal }).user = {
      sub: verified.sub,
      role: verified.role,
      email: verified.email,
      storeId: verified.storeId,
    };

    // v6 A2: store-wide restriction — when a non-platform user's ACTIVE memberships
    // ALL belong to restricted stores (SUSPENDED/ARCHIVED/CLOSED), refuse the request.
    // Storeless users (no memberships) are never blocked here.
    if (!isPlatform) {
      // Shared 10 s cache with resolveTenant, which needs the same rows — one query per
      // request instead of two. See membership-cache.ts for the staleness contract.
      if (memberships.length > 0 && memberships.every((m) => m.storeStatus !== "ACTIVE")) {
        throw new UnauthorizedException("Store suspended");
      }
    }
    return true;
  }
}
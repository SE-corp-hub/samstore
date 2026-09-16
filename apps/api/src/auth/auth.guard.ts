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
import { prisma } from "../persistence/prisma-repositories.js";

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
    (req as unknown as { user: AuthPrincipal }).user = {
      sub: verified.sub,
      role: verified.role,
      email: verified.email,
      storeId: verified.storeId,
    };

    // v6 A2: store-wide restriction — when a non-platform user's ACTIVE memberships
    // ALL belong to restricted stores (SUSPENDED/ARCHIVED/CLOSED), refuse the request.
    // Storeless users (no memberships) are never blocked here.
    if (verified.role !== "PLATFORM_ADMIN") {
      const memberships = await prisma.userStore.findMany({
        where: { userId: verified.sub, status: "ACTIVE" },
        select: { store: { select: { status: true } } },
      });
      if (memberships.length > 0 && memberships.every((m) => m.store.status !== "ACTIVE")) {
        throw new UnauthorizedException("Store suspended");
      }
    }
    return true;
  }
}
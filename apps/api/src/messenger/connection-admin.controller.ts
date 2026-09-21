import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { MessengerConnectionService } from "./connection.service.js";

function statusFor(error: ApiError): HttpStatus {
  switch (error.type) {
    case "validation": return HttpStatus.UNPROCESSABLE_ENTITY;
    case "not_found": return HttpStatus.NOT_FOUND;
    case "conflict": return HttpStatus.CONFLICT;
    case "forbidden": return HttpStatus.FORBIDDEN;
    case "unauthorized": return HttpStatus.UNAUTHORIZED;
    case "rate_limited": return HttpStatus.TOO_MANY_REQUESTS;
  }
}

// P6a: Messenger connection + identity mapping — admin, tenant-scoped.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class MessengerConnectionAdminController {
  private readonly messenger = new MessengerConnectionService();

  /** GET /admin/messenger — connection status (portal). */
  @Get("messenger")
  async status(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, connection: await this.messenger.getConnection(storeId) };
  }

  /** POST /admin/messenger/connect — record the Page config (token hashed). */
  @Post("messenger/connect")
  async connect(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { pageId: string; pageName: string; accessToken: string }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.messenger.connect(storeId, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("settings", storeId));
    return result.value;
  }

  /** POST /admin/messenger/disconnect — clear the recorded config. */
  @Post("messenger/disconnect")
  async disconnect(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.messenger.disconnect(storeId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("settings", storeId));
    return result.value;
  }

  /** POST /admin/messenger/rotate-webhook-token — returns the token ONCE. */
  @Post("messenger/rotate-webhook-token")
  async rotate(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.messenger.rotateWebhookToken(storeId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/messenger/users — map a PSID to a customer. */
  @Post("messenger/users")
  async mapUser(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { psid: string; customerId?: string | null }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.messenger.mapUser(storeId, body?.psid ?? "", body?.customerId ?? null);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/messenger/users — messenger identities. */
  @Get("messenger/users")
  async listUsers(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, users: await this.messenger.listUsers(storeId) };
  }

  /** GET /admin/messenger/deep-link — the storefront deep link (+ QR payload) when connected. */
  @Get("messenger/deep-link")
  async deepLink(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: { slug: true } });
    const result = await this.messenger.deepLink(storeId, store?.slug ?? storeId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}
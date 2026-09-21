import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { DeliveryZonesAdminService, type DeliveryZoneInput } from "./zones-admin.service.js";

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

// P5a: delivery zones — admin-managed, tenant-scoped per-zone delivery pricing/ETA.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class DeliveryZonesAdminController {
  private readonly zones = new DeliveryZonesAdminService();

  /** GET /admin/delivery-zones — the store's zones. */
  @Get("delivery-zones")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, zones: await this.zones.list(storeId) };
  }

  /** POST /admin/delivery-zones — create a zone. */
  @Post("delivery-zones")
  async create(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: DeliveryZoneInput, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.zones.upsert(storeId, null, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("settings", storeId));
    return result.value;
  }

  /** PATCH /admin/delivery-zones/:id — update a zone. */
  @Patch("delivery-zones/:id")
  async update(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: DeliveryZoneInput, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.zones.upsert(storeId, id, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("settings", storeId));
    return result.value;
  }

  /** DELETE /admin/delivery-zones/:id — delete a zone. */
  @Delete("delivery-zones/:id")
  async remove(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.zones.remove(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("settings", storeId));
    return result.value;
  }
}
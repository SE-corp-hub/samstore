import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { SecurityIncidentService } from "./breach.service.js";

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

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class SecurityIncidentAdminController {
  private readonly incidents = new SecurityIncidentService();

  @Get("security/incidents")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, incidents: await this.incidents.list(storeId) };
  }

  @Post("security/incidents")
  async create(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { title: string; severity: string; details?: unknown }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.incidents.create(storeId, user.sub, body ?? { title: "", severity: "" });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  @Post("security/incidents/:id/contain")
  async contain(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.incidents.contain(storeId, id, user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  @Post("security/incidents/:id/npc-notify")
  async npcNotify(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.incidents.notifyNpc(storeId, id, user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}

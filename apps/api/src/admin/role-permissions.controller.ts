// M7 — roles × permissions matrix management (deny-only, audited).
// GET  /admin/role-permissions           → full role × key matrix (MANAGE)
// PUT  /admin/role-permissions           → set one cell: { role, key, allowed } (MANAGE)

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Put, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { listRolePermissions, setRolePermission } from "../auth/role-permissions.js";

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

/** AuditLog.actorType vocabulary (kept at rest; the token role is broader). */
function actorTypeFor(role: string): string {
  switch (role) {
    case "PLATFORM_ADMIN": return "platform_admin";
    case "OWNER": return "store_owner";
    case "SALES_AGENT": return "sales_agent";
    case "DELIVERY": return "staff";
    default: return (role ?? "staff").toLowerCase();
  }
}

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class RolePermissionsController {
  @Get("role-permissions")
  async listPermissions(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    return listRolePermissions(storeId);
  }

  @Put("role-permissions")
  async setPermission(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { role: string; key: string; allowed: boolean },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await setRolePermission(storeId, user.sub, actorTypeFor(role), body.role, body.key, body.allowed);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}
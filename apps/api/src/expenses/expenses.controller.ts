import {
  Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { EXPENSES_SERVICE, ExpensesService } from "./expenses.service.js";

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
export class ExpensesController {
  constructor(@Inject(EXPENSES_SERVICE) private readonly expensesSvc: ExpensesService) {}

  private async ctx(req: Request & { user?: AuthPrincipal }, headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/expenses?from=&to=&locationId= — a store's expenses ("business" = the ones with no store). */
  @Get("expenses")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Query("locationId") locationId?: string, @Headers("x-store-id") headerStoreId?: string) {
    const { storeId, actor } = await this.ctx(req, headerStoreId);
    return this.expensesSvc.list(storeId, actor, { from, to, locationId });
  }

  @Post("expenses")
  async create(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { category: string; amountMinor: number; note?: string; spentAt?: string; locationId?: string | null; paidFromDrawer?: boolean }, @Headers("x-store-id") headerStoreId?: string) {
    const { storeId, actor } = await this.ctx(req, headerStoreId);
    const result = await this.expensesSvc.create(storeId, actor, body ?? ({} as never));
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/expenses/:id/cancel { reason } — owner or manager. The expense stays on the list, crossed out. */
  @Post("expenses/:id/cancel")
  async cancel(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: { reason?: string }, @Headers("x-store-id") headerStoreId?: string) {
    const { storeId, actor } = await this.ctx(req, headerStoreId);
    const result = await this.expensesSvc.cancel(storeId, actor, id, typeof body?.reason === "string" ? body.reason : undefined);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** Old copies of the app still send DELETE: it cancels (owner or manager), it never deletes. */
  @Delete("expenses/:id")
  async remove(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const { storeId, actor } = await this.ctx(req, headerStoreId);
    const result = await this.expensesSvc.remove(storeId, actor, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}

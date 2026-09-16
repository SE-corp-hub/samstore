import {
  Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { prisma } from "../persistence/prisma-repositories.js";
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

  @Get("expenses")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { expenses: await this.expensesSvc.list(storeId, from, to) };
  }

  @Post("expenses")
  async create(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { category: string; amountMinor: number; note?: string; spentAt?: string }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.expensesSvc.create(storeId, user.sub, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  @Delete("expenses/:id")
  async remove(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.expensesSvc.remove(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}
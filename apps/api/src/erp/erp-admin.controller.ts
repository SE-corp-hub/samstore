import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { JournalService } from "./journal.service.js";

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

// P9: ERP double-entry ledger — owner-managed, tenant-scoped.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class ErpAdminController {
  private readonly journal = new JournalService();

  /** GET /admin/erp/accounts — the chart of accounts. */
  @Get("erp/accounts")
  async accounts(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    await this.journal.ensureChart(storeId);
    return { storeId, accounts: await prisma.account.findMany({ where: { storeId }, orderBy: { code: "asc" } }) };
  }

  /** GET /admin/erp/trial-balance. */
  @Get("erp/trial-balance")
  async trialBalance(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, ...(await this.journal.trialBalance(storeId)) };
  }

  /** GET /admin/erp/income-statement?from=&to=. */
  @Get("erp/income-statement")
  async incomeStatement(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const f = from ? new Date(from) : new Date(0);
    const t = to ? new Date(to) : new Date();
    return { storeId, statement: await this.journal.incomeStatement(storeId, f, t) };
  }

  /** POST /admin/erp/entries — manual balancing entry. */
  @Post("erp/entries")
  async postEntry(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { reference: string; memo?: string; lines: { accountCode: string; debitMinor?: number; creditMinor?: number }[] },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.journal.postEntry(storeId, { reference: body?.reference ?? `manual-${Date.now()}`, memo: body?.memo, source: "manual", createdBy: user.sub, lines: body?.lines ?? [] });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("erp", storeId));
    return result.value;
  }

  /** POST /admin/erp/orders/:id/post — post a fulfilled order (idempotent). */
  @Post("erp/orders/:id/post")
  async postOrder(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.journal.postOrder(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("erp", storeId));
    return result.value;
  }

  /** POST /admin/erp/backfill — post all un-posted fulfilled orders + expenses. */
  @Post("erp/backfill")
  async backfill(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.journal.backfill(storeId);
    await cacheBust(cacheKey("erp", storeId));
    return { storeId, ...result };
  }
}
import { Controller, Get, Headers, HttpException, HttpStatus, Inject, Query, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { BirService, PendingEInvoiceAdapter } from "./bir.service.js";

// P9: BIR exports + e-invoice status — owner-managed, tenant-scoped.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class BirAdminController {
  private readonly bir = new BirService();

  /** GET /admin/bir/sales-journal?from=&to= — BIR Sales Journal CSV. */
  @Get("bir/sales-journal")
  async salesJournal(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const f = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
    const t = to ? new Date(to) : new Date();
    const csv = await this.bir.salesJournalCsv(storeId, f, t);
    return { storeId, filename: `sales-journal-${f.toISOString().slice(0, 10)}-to-${t.toISOString().slice(0, 10)}.csv`, csv };
  }

  /** GET /admin/bir/cash-receipts-journal?from=&to=. */
  @Get("bir/cash-receipts-journal")
  async cashReceipts(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const f = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
    const t = to ? new Date(to) : new Date();
    const csv = await this.bir.cashReceiptsJournalCsv(storeId, f, t);
    return { storeId, filename: `cash-receipts-journal-${f.toISOString().slice(0, 10)}-to-${t.toISOString().slice(0, 10)}.csv`, csv };
  }

  /** GET /admin/bir/einvoice/status — honest e-invoice adapter status. */
  @Get("bir/einvoice/status")
  async einvoiceStatus(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const adapter = new PendingEInvoiceAdapter();
    return { storeId, adapter: adapter.name, ready: adapter.ready(), pendingCredentials: !adapter.ready() };
  }
}
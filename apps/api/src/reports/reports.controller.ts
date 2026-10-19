import { Controller, Get, Headers, HttpException, HttpStatus, Inject, Query, Req, Res, UseGuards } from "@nestjs/common";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { REPORTS_SERVICE, ReportsService } from "./reports.service.js";

function parseRange(from?: string, to?: string, days = 30): { from: Date; to: Date } {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - days * 86_400_000);
  return { from: fromDate, to: toDate };
}

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(@Inject(REPORTS_SERVICE) private readonly reportsSvc: ReportsService) {}

  /** GET /admin/reports/profit?from=&to= — OWNER/MANAGER only (decision #9). */
  @Get("reports/profit")
  async profit(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const { from: f, to: t } = parseRange(from, to);
    return { ...(await this.reportsSvc.profitSummary(storeId, f, t)), storeId };
  }

  /** GET /admin/reports/sales?from=&to= — sales-level (all admins incl. staff/agents). */
  @Get("reports/sales")
  async sales(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const { from: f, to: t } = parseRange(from, to);
    return { ...(await this.reportsSvc.salesReport(storeId, f, t)), storeId };
  }

  /** GET /admin/reports/stock-low?from=&to= — products at or below reorder threshold (OWNER/MANAGER). */
  @Get("reports/stock-low")
  async stockLow(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const { from: f, to: t } = parseRange(from, to);
    return { ...(await this.reportsSvc.stockLow(storeId, f, t)), storeId };
  }

  /** GET /admin/reports/sold-stock?from=&to= — units sold per product in period (VIEW). */
  @Get("reports/sold-stock")
  async soldStock(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const { from: f, to: t } = parseRange(from, to);
    return { ...(await this.reportsSvc.soldStock(storeId, f, t)), storeId };
  }

  /** GET /admin/reports/income-loss?from=&to= — detailed income vs expenses (OWNER/MANAGER). */
  @Get("reports/income-loss")
  async incomeLoss(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const { from: f, to: t } = parseRange(from, to);
    return { ...(await this.reportsSvc.incomeLoss(storeId, f, t)), storeId };
  }

  /** GET /admin/reports/sales-by-payment?from=&to= — payment method breakdown (VIEW). */
  @Get("reports/sales-by-payment")
  async salesByPayment(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const { from: f, to: t } = parseRange(from, to);
    return { ...(await this.reportsSvc.salesByPayment(storeId, f, t)), storeId };
  }

  /** GET /admin/reports/customer-statement?from=&to= — per-customer ledger (OWNER/MANAGER). */
  @Get("reports/customer-statement")
  async customerStatement(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const { from: f, to: t } = parseRange(from, to);
    return { ...(await this.reportsSvc.customerStatement(storeId, f, t)), storeId };
  }

  /** GET /admin/reports/profit.csv — CSV export of the profit report (OWNER/MANAGER). */
  @Get("reports/profit.csv")
  async profitCsv(@Req() req: Request & { user?: AuthPrincipal }, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") headerStoreId?: string, @Res() res?: any) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const { from: f, to: t } = parseRange(from, to);
    const r = await this.reportsSvc.profitSummary(storeId, f, t);
    const rows = [
      ["metric", "minor", "pesos"],
      ["revenue", r.revenueMinor, (r.revenueMinor / 100).toFixed(2)],
      ["refunds", r.refundsMinor, (r.refundsMinor / 100).toFixed(2)],
      ["netRevenue", r.netRevenueMinor, (r.netRevenueMinor / 100).toFixed(2)],
      ["cogs", r.cogsMinor, (r.cogsMinor / 100).toFixed(2)],
      ["expenses", r.expensesMinor, (r.expensesMinor / 100).toFixed(2)],
      ["profit", r.profitMinor, (r.profitMinor / 100).toFixed(2)],
      ["orders", r.ordersCount, ""],
    ];
    const csv = rows.map((row) => row.join(",")).join("\n");
    res?.setHeader?.("Content-Type", "text/csv; charset=utf-8");
    res?.setHeader?.("Content-Disposition", `attachment; filename="profit-${f.toISOString().slice(0, 10)}-${t.toISOString().slice(0, 10)}.csv"`);
    return res?.send?.(csv) ?? csv;
  }
}
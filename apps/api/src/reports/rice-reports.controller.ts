// Rice Ops M9 — report routes. Stock Live streams a "stock" event (server-sent events)
// within seconds of any signed step; phones refetch the matrix then (and every 30 s as a
// backup). The stream is read with fetch (it carries the login header), not EventSource.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Post, Put, Query, Req, Res, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { Response } from "express";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { signaturesFrom } from "../people/signature-input.js";
import { RiceReportsService, watchStock } from "./rice-reports.service.js";
import { StoreReportService } from "./store-report.service.js";

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

type Req_ = Request & { user?: AuthPrincipal; on?: (ev: string, cb: () => void) => void };
type R<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const unwrap = <T>(r: R<T>): T => {
  if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
  return r.value;
};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

@Controller("admin/rice")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class RiceReportsController {
  private readonly reports = new RiceReportsService();
  private readonly storeReports = new StoreReportService();

  private async ctx(req: Req_, h: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, h, TENANT_ROLES.ADMIN);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/rice/stock-live — every rice product × location, in transit, in resack, totals. */
  @Get("stock-live")
  async stockLive(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    return this.reports.stockLive(storeId);
  }

  /** GET /admin/rice/stream — server-sent events: "stock" whenever a signed step moves stock. */
  @Get("stream")
  async stream(@Req() req: Req_, @Res() res: Response, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`event: hello\ndata: {}\n\n`);
    const stop = watchStock(storeId, (version) => res.write(`event: stock\ndata: ${JSON.stringify({ version })}\n\n`));
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    const end = () => { stop(); clearInterval(ping); };
    res.on("close", end);
  }

  /** GET /admin/rice/movements?productId=&locationId= — the documents behind a Stock Live cell. */
  @Get("movements")
  async movements(@Req() req: Req_, @Query("productId") productId?: string, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    if (!productId) throw new HttpException({ type: "validation", errors: ["productId is required"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    return { storeId, movements: await this.reports.movements(storeId, productId, locationId) };
  }

  /** GET /admin/rice/daily?date=YYYY-MM-DD&locationId= — Ulat ngayong araw (locked once closed). */
  @Get("daily")
  async daily(@Req() req: Req_, @Query("date") date?: string, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.daily(storeId, actor, { date, locationId }));
  }

  /** POST /admin/rice/close — Pagsasara: { locationId?, date?, cashCountedMinor, closingCountId?, note?, signatures } */
  @Post("close")
  async close(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.close(storeId, actor, {
      locationId: str(body?.locationId), date: str(body?.date), cashCountedMinor: body?.cashCountedMinor, closingCountId: str(body?.closingCountId), note: str(body?.note), signatures: signaturesFrom(body?.signatures),
    }));
  }

  /** GET /admin/rice/monthly?month=YYYY-MM — Ulat ngayong buwan (owner). */
  @Get("monthly")
  async monthly(@Req() req: Req_, @Query("month") month?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.monthly(storeId, actor, month));
  }

  /** GET /admin/rice/kargador-pay?month= — transactions per kargador (owner). */
  @Get("kargador-pay")
  async kargadorPay(@Req() req: Req_, @Query("month") month?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.kargadorPay(storeId, actor, month));
  }

  /** GET /admin/rice/balance?from=&to=&locationId= — kulang ranked by pesos, with the trail (owner). */
  @Get("balance")
  async balance(@Req() req: Req_, @Query("from") from?: string, @Query("to") to?: string, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.balanceReport(storeId, actor, { from, to, locationId }));
  }

  /** GET /admin/rice/stock-book?productId=&locationId=&from=&to= — every ledger row for one product (owner, read-only). */
  @Get("stock-book")
  async stockBook(@Req() req: Req_, @Query("productId") productId?: string, @Query("locationId") locationId?: string, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.stockBookPage(storeId, actor, { productId, locationId, from, to }));
  }

  /** GET/PUT /admin/rice/cost-mode — how cost is counted (owner). */
  @Get("cost-mode")
  async costMode(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.getCostMode(storeId, actor));
  }

  @Put("cost-mode")
  async setCostMode(@Req() req: Req_, @Body() body: { costMode?: unknown }, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.setCostMode(storeId, actor, body?.costMode));
  }

  /** GET /admin/rice/stock-book/check?locationId= — where the shelf and the ledger disagree (owner, read-only). */
  @Get("stock-book/check")
  async stockBookCheck(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.stockBookCheck(storeId, actor, { locationId }));
  }

  /** GET /admin/rice/trace?q= — Hanapin (owner). */
  @Get("trace")
  async trace(@Req() req: Req_, @Query("q") q?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.trace(storeId, actor, q));
  }

  /** GET /admin/rice/alerts — what the owner should look at now. */
  @Get("alerts")
  async alerts(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.reports.alerts(storeId, actor));
  }
  /** GET /admin/rice/store-stock?locationId= — what is left at one store, with the selling price and its value. */
  @Get("store-stock")
  async storeStock(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.storeReports.stockLeft(storeId, actor, { locationId }));
  }

  /** GET /admin/rice/store-sales?locationId=&from=YYYY-MM-DD&to=YYYY-MM-DD — one store's sales. */
  @Get("store-sales")
  async storeSales(@Req() req: Req_, @Query("locationId") locationId?: string, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.storeReports.sales(storeId, actor, { locationId, from, to }));
  }

  /** GET /admin/rice/store-compare?from=&to= — every store side by side (owner). */
  @Get("store-compare")
  async storeCompare(@Req() req: Req_, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.storeReports.compare(storeId, actor, { from, to }));
  }
  /** GET /admin/rice/store-buffer — what the Buffer store covered (the "to fix" list). Owner only. */
  @Get("store-buffer")
  async storeBuffer(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.storeReports.buffer(storeId, actor));
  }
  /** GET /admin/rice/store-records?locationId=&from=&to=&productId=&kind=all|sales|stock|money — every transaction, newest first. */
  @Get("store-records")
  async storeRecords(@Req() req: Req_, @Query("locationId") locationId?: string, @Query("from") from?: string, @Query("to") to?: string, @Query("productId") productId?: string, @Query("kind") kind?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.storeReports.records(storeId, actor, { locationId, from, to, productId, kind }));
  }
}

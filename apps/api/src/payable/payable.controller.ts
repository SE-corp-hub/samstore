// Store payable routes — owner and manager only.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { PayableService } from "./payable.service.js";

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
type Req_ = Request & { user?: AuthPrincipal };
type R<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const unwrap = <T>(r: R<T>): T => {
  if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
  return r.value;
};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

@Controller("admin/payable")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PayableController {
  private readonly payable = new PayableService();

  private async ctx(req: Req_, h: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, h, TENANT_ROLES.OWNER_MANAGER);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/payable/summary — what each store owes, shortages still to charge, recent entries. */
  @Get("summary")
  async summary(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.summary(storeId, actor));
  }

  /** GET /admin/payable/reconcile?locationId= — supplied, sold, returned, short, on hand: per item. */
  @Get("reconcile")
  async reconcile(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.reconcile(storeId, actor, locationId));
  }

  /** GET /admin/payable/statement?locationId= — one store's statement with a running balance. */
  @Get("statement")
  async statement(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.statement(storeId, actor, locationId));
  }

  /** POST /admin/payable/charge-count — { lineId, locationId } */
  @Post("charge-count")
  async chargeCount(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.chargeFromCount(storeId, actor, { lineId: str(body?.lineId), locationId: str(body?.locationId) }));
  }

  /** POST /admin/payable/charge — { locationId, sourceLocationId?, productId, quantity, note? } */
  @Post("charge")
  async charge(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.chargeManual(storeId, actor, { locationId: str(body?.locationId), sourceLocationId: str(body?.sourceLocationId), productId: str(body?.productId), quantity: body?.quantity, note: str(body?.note) }));
  }

  /** GET /admin/payable/sales-check?locationId= — expected sales at selling price since the last report. */
  @Get("sales-check")
  async salesCheck(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.salesCheck(storeId, actor, locationId));
  }

  /** POST /admin/payable/sales-report — { locationId, reportedMinor, note? } */
  @Post("sales-report")
  async salesReport(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.reportSales(storeId, actor, { locationId: str(body?.locationId), reportedMinor: body?.reportedMinor, note: str(body?.note) }));
  }

  /** POST /admin/payable/payment — { locationId, amountMinor, note? } */
  @Post("payment")
  async payment(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.payment(storeId, actor, { locationId: str(body?.locationId), amountMinor: body?.amountMinor, note: str(body?.note) }));
  }

  /** POST /admin/payable/entries/:id/reverse — { reason } */
  @Post("entries/:id/reverse")
  async reverse(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.payable.reverse(storeId, actor, id, str(body?.reason)));
  }
}

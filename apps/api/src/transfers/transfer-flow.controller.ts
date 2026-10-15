// Rice Ops M3 — trip steps for the store phones: Ilabas, Tanggapin, Naihatid,
// Tanggapin pabalik, cancel, and Ibinalik (customer returns). Tenant-scoped via
// resolveTenant; the store role it returns is the actor's role; location checks live
// in the service (staff act only at their home location).

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { badRequest, signaturesFrom } from "../people/signature-input.js";
import { TransferFlowService, type TripView } from "./transfer-flow.service.js";

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
const VIEWS: TripView[] = ["ilabas", "tanggapin", "naihatid", "pabalik", "all"];

@Controller("admin")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class TransferFlowController {
  private readonly flow = new TransferFlowService();

  private async ctx(req: Req_, headerStoreId: string | undefined, roles: readonly string[]) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, roles);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/trips?view=ilabas|tanggapin|naihatid|pabalik|all&locationId= */
  @Get("trips")
  async list(@Req() req: Req_, @Query("view") view?: string, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    const v = (view ?? "all") as TripView;
    if (!VIEWS.includes(v)) badRequest("view must be ilabas, tanggapin, naihatid, pabalik or all");
    return { storeId, view: v, trips: await this.flow.list(storeId, actor, v, locationId) };
  }

  /** GET /admin/trips/:id/readback?step=RELEASE&qty=2&kargadorName= — the sentence shown before signing. */
  @Get("trips/:id/readback")
  async readback(@Req() req: Req_, @Param("id") id: string, @Query("step") step?: string, @Query("qty") qty?: string, @Query("kargadorName") kargadorName?: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    if (!["RELEASE", "RECEIVE", "DELIVERED", "RETURN"].includes(step ?? "")) badRequest("unknown step");
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 0) badRequest("qty must be a whole number");
    const sentence = await this.flow.readBackFor(storeId, id, step as "RELEASE", n, kargadorName ?? null);
    if (sentence === null) throw new HttpException({ type: "not_found", message: "Trip not found" }, HttpStatus.NOT_FOUND);
    return { sentence };
  }

  /** POST /admin/trips/:id/release — Ilabas: { quantity, kargadorId, signatures: [STAFF, KARGADOR] } */
  @Post("trips/:id/release")
  async release(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.flow.release(storeId, actor, id, { quantity: body?.quantity, kargadorId: str(body?.kargadorId), signatures: signaturesFrom(body?.signatures) }));
  }

  /** POST /admin/trips/:id/receive — Tanggapin: { quantity, signatures: [STAFF, KARGADOR] } */
  @Post("trips/:id/receive")
  async receive(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.flow.receive(storeId, actor, id, { quantity: body?.quantity, signatures: signaturesFrom(body?.signatures) }));
  }

  /** POST /admin/trips/:id/deliver — Naihatid: { quantity, note, signatures: [STAFF, KARGADOR, (CUSTOMER)] } */
  @Post("trips/:id/deliver")
  async deliver(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.flow.deliver(storeId, actor, id, { quantity: body?.quantity, note: str(body?.note), signatures: signaturesFrom(body?.signatures) }));
  }

  /** POST /admin/trips/:id/return — Tanggapin pabalik: { quantity, signatures: [STAFF, KARGADOR] } */
  @Post("trips/:id/return")
  async receiveBack(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.flow.receiveBack(storeId, actor, id, { quantity: body?.quantity, signatures: signaturesFrom(body?.signatures) }));
  }

  /** POST /admin/trips/:id/cancel — owner/manager, before anything left the source: { reason } */
  @Post("trips/:id/cancel")
  async cancel(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.OWNER_MANAGER);
    return unwrap(await this.flow.cancel(storeId, actor, id, str(body?.reason)));
  }

  /** POST /admin/returns — Ibinalik: { locationId, productId, quantity, condition, reason, orderId?, kargadorId?, signatures } */
  @Post("returns")
  async createReturn(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.flow.createReturn(storeId, actor, {
      locationId: str(body?.locationId), productId: str(body?.productId), quantity: body?.quantity, condition: str(body?.condition),
      reason: str(body?.reason), orderId: str(body?.orderId), kargadorId: str(body?.kargadorId), signatures: signaturesFrom(body?.signatures),
    }));
  }
}

// Rice Ops M4 — Resack routes for the store phones. Tenant-scoped via resolveTenant;
// location checks and signatures live in the service.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { badRequest, signaturesFrom } from "../people/signature-input.js";
import { ResackService, type OutputInput } from "./resack.service.js";

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

function outputsFrom(v: unknown): OutputInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) badRequest("outputs must be a list");
  return v.map((o) => {
    if (!o || typeof o !== "object") badRequest("invalid output");
    const x = o as Record<string, unknown>;
    return { productId: str(x.productId), quantity: x.quantity };
  });
}

@Controller("admin")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ResackController {
  private readonly resacks = new ResackService();

  private async ctx(req: Req_, headerStoreId: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/resacks?status=STARTED|FINISHED|CANCELLED|ALL&locationId= */
  @Get("resacks")
  async list(@Req() req: Req_, @Query("status") status?: string, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const s = (status ?? "ALL").toUpperCase();
    if (!["STARTED", "FINISHED", "CANCELLED", "ALL"].includes(s)) badRequest("unknown status");
    return { storeId, resacks: await this.resacks.list(storeId, actor, { status: s, locationId }) };
  }

  /** POST /admin/resacks — one step: { locationId, inputProductId, inputQty, outputs:[{productId, quantity}], kargadorId?, note?, signatures } */
  @Post("resacks")
  async resack(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.resacks.resack(storeId, actor, {
      locationId: str(body?.locationId), inputProductId: str(body?.inputProductId), inputQty: body?.inputQty,
      outputs: outputsFrom(body?.outputs), kargadorId: str(body?.kargadorId), note: str(body?.note), signatures: signaturesFrom(body?.signatures),
    }));
  }

  /** POST /admin/resacks/open-sack — Buksan ang sako: { locationId, sackProductId, sacks, looseProductId, looseGrams, signatures } */
  @Post("resacks/open-sack")
  async openSack(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.resacks.resack(storeId, actor, {
      locationId: str(body?.locationId), inputProductId: str(body?.sackProductId), inputQty: body?.sacks ?? 1,
      outputs: [{ productId: str(body?.looseProductId), quantity: body?.looseGrams }], kargadorId: str(body?.kargadorId),
      note: str(body?.note), openSack: true, signatures: signaturesFrom(body?.signatures),
    }));
  }

  /** POST /admin/resacks/start — Simulan: { locationId, inputProductId, inputQty, kargadorId?, note?, signatures } */
  @Post("resacks/start")
  async start(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.resacks.start(storeId, actor, {
      locationId: str(body?.locationId), inputProductId: str(body?.inputProductId), inputQty: body?.inputQty,
      kargadorId: str(body?.kargadorId), note: str(body?.note), signatures: signaturesFrom(body?.signatures),
    }));
  }

  /** POST /admin/resacks/:id/finish — Tapusin: { outputs:[{productId, quantity}], signatures } */
  @Post("resacks/:id/finish")
  async finish(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.resacks.finish(storeId, actor, id, { outputs: outputsFrom(body?.outputs), signatures: signaturesFrom(body?.signatures) }));
  }

  /** POST /admin/resacks/:id/cancel — { reason } */
  @Post("resacks/:id/cancel")
  async cancel(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.resacks.cancel(storeId, actor, id, str(body?.reason)));
  }
}

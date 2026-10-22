// Rice Ops M8 — Bilangin, balance and Manual na bawas routes. Tenant-scoped; the
// location rule, blind counting and signatures live in the service.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { signaturesFrom } from "../people/signature-input.js";
import { CountService } from "./count.service.js";

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
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

@Controller("admin")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class CountController {
  private readonly counts = new CountService();

  private async ctx(req: Req_, h: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, h, TENANT_ROLES.ADMIN);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/counts?locationId=&status= */
  @Get("counts")
  async list(@Req() req: Req_, @Query("locationId") locationId?: string, @Query("status") status?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return { storeId, counts: await this.counts.list(storeId, actor, { locationId, status }) };
  }

  /**
   * POST /admin/counts — anyone starts a list count at their location:
   * { locationId, productIds? | variety? | staleDays? (nothing = every item there), showSystem? (owner/manager only), note? }
   */
  @Post("counts")
  async start(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const ids = Array.isArray(body?.productIds) ? (body.productIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return unwrap(await this.counts.start(storeId, actor, {
      locationId: str(body?.locationId), productIds: ids, variety: str(body?.variety), staleDays: typeof body?.staleDays === "number" ? body.staleDays : undefined,
      showSystem: body?.showSystem === true, note: str(body?.note),
    }));
  }

  /** GET /admin/counts/items?locationId= — every item that can be counted there, with when it was last counted (no quantities, no cost). */
  @Get("counts/items")
  async items(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.items(storeId, actor, { locationId }));
  }

  /** POST /admin/counts/quick — the zero check: { locationId?, productId, counted (sacks, or kilos text for loose), signatures } */
  @Post("counts/quick")
  async quick(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.quick(storeId, actor, { locationId: str(body?.locationId), productId: str(body?.productId), counted: body?.counted, signatures: signaturesFrom(body?.signatures) }));
  }

  /** POST /admin/counts/closing — the top-5 count at closing: { locationId? } */
  @Post("counts/closing")
  async closing(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.startClosing(storeId, actor, { locationId: str(body?.locationId) }));
  }

  /** GET /admin/counts/report?locationId=&from=&to= — counts posted in a period, totals, shortages by reason, every difference. */
  @Get("counts/report")
  async reportList(@Req() req: Req_, @Query("locationId") locationId?: string, @Query("from") from?: string, @Query("to") to?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.reportList(storeId, actor, { locationId, from, to }));
  }

  /** GET /admin/counts/overview — owner/manager: every item against every store, last counted and what the system holds. */
  @Get("counts/overview")
  async overview(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.overview(storeId, actor));
  }

  /** GET /admin/counts/balance?locationId=&productId= — expected vs the system's shelf, per item. */
  @Get("counts/balance")
  async balance(@Req() req: Req_, @Query("locationId") locationId?: string, @Query("productId") productId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.balance(storeId, actor, { locationId, productId }));
  }

  @Get("counts/:id")
  async get(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.get(storeId, actor, id));
  }

  /** POST /admin/counts/:id/lines — { lines: [{ productId, counted }] } */
  @Post("counts/:id/lines")
  async record(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const lines = Array.isArray(body?.lines) ? (body.lines as unknown[]).map((l) => { const x = obj(l); return { productId: str(x.productId), counted: x.counted }; }) : [];
    return unwrap(await this.counts.record(storeId, actor, id, lines));
  }

  /** POST /admin/counts/:id/submit — { signatures, recordResack? (kinds of rice where a sack was opened) } */
  @Post("counts/:id/submit")
  async submit(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const resack = Array.isArray(body?.recordResack) ? (body.recordResack as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
    return unwrap(await this.counts.submit(storeId, actor, id, signaturesFrom(body?.signatures), resack));
  }

  /** GET /admin/counts/:id/report — one posted count explained (differences, since the last count, weight, resack, charge). */
  @Get("counts/:id/report")
  async report(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.report(storeId, actor, id));
  }

  /** GET /admin/counts/:id/check — the check step: only the items that differ, with their reasons to choose from. */
  @Get("counts/:id/check")
  async check(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.check(storeId, actor, id));
  }

  /** POST /admin/counts/:id/reasons — { lines: [{ productId, reason, note? }] } why items are short or over. */
  @Post("counts/:id/reasons")
  async reasons(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const lines = Array.isArray(body?.lines) ? (body.lines as unknown[]).map((l) => { const x = obj(l); return { productId: str(x.productId), reason: x.reason, note: x.note }; }) : [];
    return unwrap(await this.counts.setReasons(storeId, actor, id, lines));
  }

  @Post("counts/:id/cancel")
  async cancel(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.cancel(storeId, actor, id));
  }

  /** GET /admin/write-offs?locationId= · POST /admin/write-offs { locationId?, productId, quantity | kilos, reason, note?, signatures } */
  @Get("write-offs")
  async writeOffs(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return { storeId, writeOffs: await this.counts.writeOffs(storeId, actor, { locationId }) };
  }

  @Post("write-offs")
  async writeOff(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.counts.writeOff(storeId, actor, {
      locationId: str(body?.locationId), productId: str(body?.productId), quantity: body?.quantity, kilos: body?.kilos, reason: body?.reason, note: str(body?.note), signatures: signaturesFrom(body?.signatures),
    }));
  }
}

// Rice Ops M7 — agent order routes. Agents (SALES_AGENT) create and see their own orders;
// store staff approve, decline and take the payment. An agent can never approve.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { signaturesFrom } from "../people/signature-input.js";
import { BentaService } from "../selling/benta.service.js";
import { AgentOrderService, type AgentLineInput } from "./agent-order.service.js";

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
export class AgentOrderController {
  private readonly orders = new AgentOrderService();
  private readonly benta = new BentaService();

  /** Agents and staff (VIEW set includes SALES_AGENT). */
  private async anyone(req: Req_, h: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, h, TENANT_ROLES.VIEW);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** Store staff only (ADMIN set — no SALES_AGENT). */
  private async staff(req: Req_, h: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, h, TENANT_ROLES.ADMIN);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/agent-orders/catalog?locationId= — rice with that store's prices and stock everywhere. */
  @Get("agent-orders/catalog")
  async catalog(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.anyone(req, h);
    return unwrap(await this.benta.catalog(storeId, { ...actor, homeLocationId: null }, locationId));
  }

  /** POST /admin/agent-orders — Bagong order: { idempotencyKey, locationId, customerId? | customerName + customerPhone, address, landmark?, note?, lines } */
  @Post("agent-orders")
  async create(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.anyone(req, h);
    const lines: AgentLineInput[] = Array.isArray(body?.lines) ? (body.lines as unknown[]).map((l) => { const x = obj(l); return { productId: str(x.productId), quantity: x.quantity, kilos: x.kilos, grams: x.grams, amountMinor: x.amountMinor }; }) : [];
    return unwrap(await this.orders.create(storeId, actor, {
      idempotencyKey: body?.idempotencyKey, locationId: str(body?.locationId), customerId: str(body?.customerId), customerName: str(body?.customerName),
      customerPhone: str(body?.customerPhone), address: body?.address, landmark: str(body?.landmark), note: str(body?.note), lines,
    }));
  }

  /** GET /admin/agent-orders/mine — Mga order ko. */
  @Get("agent-orders/mine")
  async mine(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.anyone(req, h);
    return { storeId, orders: await this.orders.mine(storeId, actor) };
  }

  /** GET /admin/agent-orders?view=waiting|active|done — the store's agent orders. */
  @Get("agent-orders")
  async forStore(@Req() req: Req_, @Query("view") view?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.staff(req, h);
    return { storeId, orders: await this.orders.forStore(storeId, actor, view) };
  }

  /** POST /admin/agent-orders/:id/approve — { sources?: [{ itemId, sourceLocationId }] } */
  @Post("agent-orders/:id/approve")
  async approve(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.staff(req, h);
    const sources = Array.isArray(body?.sources) ? (body.sources as unknown[]).map((s) => { const x = obj(s); return { itemId: str(x.itemId), sourceLocationId: str(x.sourceLocationId) }; }) : [];
    return unwrap(await this.orders.approve(storeId, actor, id, { sources }));
  }

  /** POST /admin/agent-orders/:id/decline — { reason } */
  @Post("agent-orders/:id/decline")
  async decline(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.staff(req, h);
    return unwrap(await this.orders.decline(storeId, actor, id, str(body?.reason)));
  }

  /** POST /admin/agent-orders/:id/pay — { method: cash|gcash|utang, tenderedMinor?, reference?, signatures? } */
  @Post("agent-orders/:id/pay")
  async pay(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.staff(req, h);
    return unwrap(await this.orders.pay(storeId, actor, id, { method: str(body?.method), tenderedMinor: body?.tenderedMinor, reference: str(body?.reference), signatures: signaturesFrom(body?.signatures) }));
  }
  /** POST /admin/agent-orders/:id/delivered */
  @Post("agent-orders/:id/delivered")
  async delivered(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.staff(req, h);
    return unwrap(await this.orders.markDelivered(storeId, actor, id));
  }

  /** POST /admin/agent-orders/:id/not-delivered — { reason } */
  @Post("agent-orders/:id/not-delivered")
  async notDelivered(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.staff(req, h);
    return unwrap(await this.orders.markNotDelivered(storeId, actor, id, str(body?.reason)));
  }
}

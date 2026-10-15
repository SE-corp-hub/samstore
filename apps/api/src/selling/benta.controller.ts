// Rice Ops M5 — Benta routes for the store phones. Tenant-scoped via resolveTenant;
// location checks, prices, stock and signatures live in the service.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { badRequest, signaturesFrom } from "../people/signature-input.js";
import { BentaService, type BentaLineInput } from "./benta.service.js";

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
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function linesFrom(v: unknown): BentaLineInput[] {
  if (!Array.isArray(v)) badRequest("lines must be a list");
  return v.map((l) => {
    const x = obj(l);
    if (!x) badRequest("invalid line");
    return {
      productId: str(x.productId), quantity: x.quantity, kilos: x.kilos, grams: x.grams, amountMinor: x.amountMinor,
      sourceLocationId: str(x.sourceLocationId), unitPriceMinorOverride: x.unitPriceMinorOverride, priceOverrideReason: str(x.priceOverrideReason),
    };
  });
}

@Controller("admin")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class BentaController {
  private readonly benta = new BentaService();

  private async ctx(req: Req_, headerStoreId: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/benta/catalog?locationId= — products with this location's price and stock everywhere, most-sold first. */
  @Get("benta/catalog")
  async catalog(@Req() req: Req_, @Query("locationId") locationId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.benta.catalog(storeId, actor, locationId));
  }

  /**
   * POST /admin/benta — { idempotencyKey, locationId?, lines:[{productId, quantity | kilos | grams | amountMinor, sourceLocationId?}],
   * payment:{method:"cash"|"gcash"|"utang", tenderedMinor?, reference?}, customerId?, customerName?, signatures?, paperSlip?:{slipNo, occurredAt} }
   * The same idempotencyKey always returns the same sale (replayed: true).
   */
  @Post("benta")
  async sell(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string, @Headers("idempotency-key") headerKey?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const pay = obj(body?.payment) ?? {};
    const paper = obj(body?.paperSlip);
    return unwrap(await this.benta.sell(storeId, actor, {
      idempotencyKey: body?.idempotencyKey ?? headerKey, locationId: str(body?.locationId), lines: linesFrom(body?.lines),
      payment: { method: str(pay.method), tenderedMinor: pay.tenderedMinor, reference: str(pay.reference) },
      customerId: str(body?.customerId), customerName: str(body?.customerName), signatures: signaturesFrom(body?.signatures),
      paperSlip: paper ? { slipNo: paper.slipNo, occurredAt: paper.occurredAt } : undefined,
    }));
  }

  /** POST /admin/benta/manual-item — Bagong item: { name, soldAs:"SACK"|"KILO"|"PIECE", gramsPerSack?, priceMinor, costMinor, openingQty, locationId?, signatures } */
  @Post("benta/manual-item")
  async manualItem(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.benta.manualItem(storeId, actor, {
      name: body?.name, soldAs: body?.soldAs, gramsPerSack: body?.gramsPerSack, priceMinor: body?.priceMinor, costMinor: body?.costMinor,
      openingQty: body?.openingQty, locationId: str(body?.locationId), signatures: signaturesFrom(body?.signatures),
    }));
  }

  /** POST /admin/stock-in — Manual na pasok: { locationId?, supplierName?, note?, lines:[{productId, quantity, unitCostMinor?}], signatures } */
  @Post("stock-in")
  async stockIn(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const raw: unknown = body?.lines;
    if (!Array.isArray(raw)) badRequest("lines must be a list");
    const lines = (raw as unknown[]).map((l) => { const x = obj(l) ?? {}; return { productId: str(x.productId), quantity: x.quantity, unitCostMinor: x.unitCostMinor }; });
    return unwrap(await this.benta.stockIn(storeId, actor, {
      locationId: str(body?.locationId), supplierName: str(body?.supplierName), note: str(body?.note), lines, signatures: signaturesFrom(body?.signatures),
    }));
  }

  /** GET /admin/products/review — Susuriin: manual items waiting for the owner. */
  @Get("products/review")
  async review(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    return { storeId, products: await this.benta.reviewList(storeId) };
  }

  /** POST /admin/products/:id/merge — { intoProductId } (owner/manager). */
  @Post("products/:id/merge")
  async merge(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.benta.merge(storeId, actor, id, str(body?.intoProductId)));
  }
}

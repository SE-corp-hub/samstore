// Purchase order routes. Counter staff may read the open orders (no costs) so they can receive a delivery against one;
// everything else is owner/manager only.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { PurchaseOrderService } from "./purchase-order.service.js";

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

@Controller("admin/purchase-orders")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PurchaseOrderController {
  private readonly orders = new PurchaseOrderService();

  private async counter(req: Req_, h: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, h, TENANT_ROLES.ADMIN);
    return { storeId, role, userId: user.sub };
  }
  private async owner(req: Req_, h: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, h, TENANT_ROLES.OWNER_MANAGER);
    return { storeId, userId: user.sub };
  }

  /** GET /admin/purchase-orders/suppliers — supplier names for the order form. */
  @Get("suppliers")
  async suppliers(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.owner(req, h);
    return unwrap(await this.orders.suppliers(storeId));
  }

  /** GET /admin/purchase-orders/reorder — items that will run out soon, with a suggested amount (owner and manager). */
  @Get("reorder")
  async reorder(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.owner(req, h);
    return unwrap(await this.orders.reorder(storeId));
  }

  /** GET /admin/purchase-orders/last-costs?supplierId= — what this supplier charged last time, per item (owner and manager). */
  @Get("last-costs")
  async lastCosts(@Req() req: Req_, @Query("supplierId") supplierId?: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.owner(req, h);
    return unwrap(await this.orders.lastCosts(storeId, supplierId));
  }

  /** GET /admin/purchase-orders?status=open|all|OPEN|PARTLY|RECEIVED|CANCELLED&locationId=&supplierId= — counter staff always get open orders without costs. */
  @Get()
  async list(@Req() req: Req_, @Query("status") status?: string, @Query("locationId") locationId?: string, @Query("supplierId") supplierId?: string, @Headers("x-store-id") h?: string) {
    const { storeId, role } = await this.counter(req, h);
    return unwrap(await this.orders.list(storeId, role, { status, locationId, supplierId }));
  }

  /** POST /admin/purchase-orders — { supplierId? | supplierName?, locationId, expectedAt?: "YYYY-MM-DD", note?, lines:[{productId, quantity, unitCostMinor}] } */
  @Post()
  async create(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, userId } = await this.owner(req, h);
    const raw = Array.isArray(body?.lines) ? (body.lines as unknown[]) : [];
    const lines = raw.map((l) => { const x = obj(l); return { productId: str(x.productId), quantity: x.quantity, unitCostMinor: x.unitCostMinor }; });
    return unwrap(await this.orders.create(storeId, userId, {
      supplierId: str(body?.supplierId), supplierName: str(body?.supplierName), locationId: str(body?.locationId), expectedAt: str(body?.expectedAt), note: str(body?.note), lines,
    }));
  }

  /** GET /admin/purchase-orders/owed — what each supplier is owed, and what is still on order. */
  @Get("owed")
  async owed(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.owner(req, h);
    return unwrap(await this.orders.balances(storeId));
  }

  /** GET /admin/purchase-orders/owed/:supplierId — one supplier's statement. */
  @Get("owed/:supplierId")
  async statement(@Req() req: Req_, @Param("supplierId") supplierId: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.owner(req, h);
    return unwrap(await this.orders.statement(storeId, supplierId));
  }

  /** POST /admin/purchase-orders/pay — { supplierId, amountMinor, note? } */
  @Post("pay")
  async pay(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, userId } = await this.owner(req, h);
    return unwrap(await this.orders.pay(storeId, userId, { supplierId: str(body?.supplierId), amountMinor: body?.amountMinor, note: str(body?.note) }));
  }

  /** POST /admin/purchase-orders/pay/:id/undo */
  @Post("pay/:id/undo")
  async undo(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId, userId } = await this.owner(req, h);
    return unwrap(await this.orders.undoPayment(storeId, userId, id));
  }

  /** POST /admin/purchase-orders/:id/cancel */
  @Post(":id/cancel")
  async cancel(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId, userId } = await this.owner(req, h);
    return unwrap(await this.orders.cancel(storeId, userId, id));
  }
}

import {
  Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Patch, Post, Req, UseGuards,
} from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { PAYMENTS_SERVICE, PaymentsService } from "./payments.service.js";
import { SplitPaymentService, SPLIT_PAYMENT_SERVICE, type TenderInput } from "./split-payment.service.js";
import { assertDto, PAYMENT_METHOD_DTO, SPLIT_PAYMENT_DTO } from "../security/validate.js";

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

// Payments endpoints — admin-guarded, tenant-scoped.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    @Inject(PAYMENTS_SERVICE) private readonly paymentsSvc: PaymentsService,
    @Inject(SPLIT_PAYMENT_SERVICE) private readonly splitSvc: SplitPaymentService,
  ) {}

  /** POST /admin/orders/:id/payments — record a payment on an order.
   *  Legacy body (single tender) OR N2 split body: { idempotencyKey, tenders: [...] }. */
  @Post("orders/:id/payments")
  async recordPayment(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { method?: "cash" | "credit" | "cod_collected"; amountMinor?: number; changeMinor?: number; note?: string; idempotencyKey?: string; tenders?: TenderInput[] },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);

    // N2: a split payment carries an explicit tender list — one transaction, many methods.
    if (Array.isArray(body?.tenders)) {
      const dto = assertDto<{ idempotencyKey: string; tenders: TenderInput[]; note?: string }>(body, SPLIT_PAYMENT_DTO);
      const result = await this.splitSvc.recordTenders(storeId, user.sub, id, dto);
      if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
      await cacheBust(cacheKey("orders", storeId));
      return result.value;
    }

    const result = await this.paymentsSvc.recordPayment({ orderId: id, storeId, method: body.method as never, amountMinor: body.amountMinor as never, changeMinor: body.changeMinor, note: body.note, createdBy: user.sub });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/orders/:id/receipt — printable receipt view. */
  @Get("orders/:id/receipt")
  async receipt(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const receipt = await this.paymentsSvc.receipt(id, storeId);
    if (!receipt) throw new HttpException({ type: "not_found", message: "Order not found" }, HttpStatus.NOT_FOUND);
    return receipt;
  }

  /** GET /admin/orders/:id/payments — payment history + DERIVED settlement (N2). */
  @Get("orders/:id/payments")
  async payments(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const rows = await this.paymentsSvc.paymentsFor(id, storeId);
    if (!rows) throw new HttpException({ type: "not_found", message: "Order not found" }, HttpStatus.NOT_FOUND);
    // N2: outstanding/settlement are computed from the rows, never stored.
    const summary = await this.splitSvc.summaryFor(storeId, id);
    return { payments: rows, summary };
  }

  /** GET /admin/payment-methods — the store's tender methods (seeded on first use). */
  @Get("payment-methods")
  async paymentMethods(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const methods = await this.splitSvc.listMethods(storeId);
    return { storeId, methods };
  }

  /** POST /admin/payment-methods — create/update a tender method (manager+). */
  @Post("payment-methods")
  async upsertPaymentMethod(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { code: string; label: string; kind?: string; requiresReference?: boolean; enabled?: boolean; sortOrder?: number },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const dto = assertDto<{ code: string; label: string; kind?: string; requiresReference?: boolean; enabled?: boolean; sortOrder?: number }>(body, PAYMENT_METHOD_DTO);
    const result = await this.splitSvc.upsertMethod(storeId, dto);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { storeId, method: result.value };
  }

  /** PATCH /admin/orders/:id/void — void an unfulfilled POS sale. */
  @Patch("orders/:id/void")
  async voidOrder(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    await cacheBust(cacheKey("orders", storeId));
    const result = await this.paymentsSvc.voidOrder(id, storeId, user.sub, body.reason);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/orders/:id/refund — refund a collected sale. */
  @Patch("orders/:id/refund")
  async refundOrder(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { amountMinor?: number; reason?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    await cacheBust(cacheKey("orders", storeId));
    const result = await this.paymentsSvc.refundOrder(id, storeId, user.sub, body.amountMinor, body.reason);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}
import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { loadActor } from "../people/people.service.js";
import { DELIVERY_SERVICE, DeliveryService } from "./delivery.service.js";

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

// Delivery endpoints — DELIVERY role only, tenant-scoped to the courier's store.

@Controller("delivery")
@UseGuards(JwtAuthGuard)
export class DeliveryController {
  constructor(@Inject(DELIVERY_SERVICE) private readonly deliverySvc: DeliveryService) {}

  /** GET /delivery/orders — all OUT_FOR_DELIVERY orders for the courier's store. */
  @Get("orders")
  async myDeliveries(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.DELIVERY);
    return { deliveries: await this.deliverySvc.myDeliveries(storeId), storeId };
  }

  /** GET /delivery/recent — last 10 delivered/failed (courier recall). */
  @Get("recent")
  async recent(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.DELIVERY);
    return { recent: await this.deliverySvc.recentDeliveries(storeId), storeId };
  }

  /** PATCH /delivery/orders/:id/status — DELIVERED | FAILED_DELIVERY (+ reason). */
  @Patch("orders/:id/status")
  async markStatus(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { toStatus: "DELIVERED" | "FAILED_DELIVERY"; reason?: string; cashCollectedMinor?: unknown; receivedBy?: unknown; signature?: unknown },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    if (!["DELIVERED", "FAILED_DELIVERY"].includes(body?.toStatus ?? "")) {
      throw new HttpException({ type: "validation", errors: ["toStatus must be DELIVERED or FAILED_DELIVERY"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const cash = body.cashCollectedMinor;
    if (cash !== undefined && (typeof cash !== "number" || !Number.isInteger(cash) || cash < 0 || cash > 100_000_000)) {
      throw new HttpException({ type: "validation", errors: ["cashCollectedMinor must be a whole number of centavos"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.DELIVERY);
    const proof = {
      actor: await loadActor(storeId, user!.sub, role),
      cashCollectedMinor: cash as number | undefined,
      receivedBy: typeof body.receivedBy === "string" ? body.receivedBy : undefined,
      signaturePng: typeof body.signature === "string" && body.signature ? body.signature : undefined,
    };
    const result = await this.deliverySvc.markStatus(storeId, id, body.toStatus, body.reason, proof);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /delivery/orders/:id/retry — re-dispatch a FAILED_DELIVERY order. */
  @Post("orders/:id/retry")
  async retryDelivery(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.DELIVERY);
    const result = await this.deliverySvc.retryDelivery(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** DELETE /delivery/orders/:id — cancel a post-dispatch order (30m window). */
  @Delete("orders/:id")
  async cancelPostDispatch(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Headers("x-store-id") headerStoreId?: string,
    @Body() body?: { reason?: string },
  ) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.DELIVERY);
    const result = await this.deliverySvc.cancelPostDispatch(storeId, id, body?.reason);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}
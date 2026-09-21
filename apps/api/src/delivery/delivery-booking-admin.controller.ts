import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { DeliveryBookingService, COURIER_STATUSES } from "./delivery-booking.service.js";

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

// P5b: courier bookings + COD remittance — admin-guarded, tenant-scoped.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class DeliveryBookingsAdminController {
  private readonly bookings = new DeliveryBookingService();

  /** GET /admin/delivery/bookings?orderId= — bookings with events + remittances. */
  @Get("delivery/bookings")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Query("orderId") orderId?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, bookings: await this.bookings.list(storeId, orderId) };
  }

  /** POST /admin/orders/:id/delivery/booking — book a courier (or owner-run delivery). */
  @Post("orders/:id/delivery/booking")
  async create(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { courier: string; codMinor?: number; pickupNote?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.bookings.createBooking(storeId, id, body?.courier ?? "owner", { codMinor: body?.codMinor, pickupNote: body?.pickupNote });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("orders", storeId));
    return result.value;
  }

  /** POST /admin/delivery/bookings/:id/event — advance booking status. */
  @Post("delivery/bookings/:id/event")
  async event(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { status: string; note?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.bookings.addEvent(storeId, id, body?.status ?? "", body?.note);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("orders", storeId));
    return result.value;
  }

  /** POST /admin/delivery/bookings/:id/remit — record a COD remittance. */
  @Post("delivery/bookings/:id/remit")
  async remit(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { amountMinor: number; note?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.bookings.remit(storeId, id, body?.amountMinor ?? 0, user.sub, body?.note);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("orders", storeId));
    return result.value;
  }
}
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheGet, cacheSet, cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { AUTH_SERVICE, AuthService } from "../auth/auth.service.js";
import { ProductAdminService } from "./product-admin.service.js";
import { OrderAdminService } from "./order-admin.service.js";
import { StoreSettingsService } from "./store-settings.service.js";
import { rotateStoreLinkToken, revokeStoreLink } from "./store-settings.service.js";
import { VoucherAdminService } from "./voucher-admin.service.js";
import { StoreAdminService } from "./store-admin.service.js";
import { AnalyticsService } from "./analytics.service.js";
import { TeamService } from "./team.service.js";
import { WarehouseService } from "./warehouse.service.js";
import { loadActor, locationRefusal } from "../people/people.service.js";
import { signaturesFrom } from "../people/signature-input.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { CartRecoveryService } from "../cart/recovery.service.js";
import { PrivacyRetentionService } from "../privacy/retention.service.js";
import { NOTIFICATIONS_SERVICE, type NotificationsService } from "../notifications/notifications.service.js";
import { type OrderState, ORDER_STATES } from "../domain/order-state.js";

function statusFor(error: ApiError): HttpStatus {
  switch (error.type) {
    case "unauthorized": return HttpStatus.UNAUTHORIZED;
    case "forbidden": return HttpStatus.FORBIDDEN;
    case "validation": return HttpStatus.UNPROCESSABLE_ENTITY;
    case "not_found": return HttpStatus.NOT_FOUND;
    case "conflict": return HttpStatus.CONFLICT;
    case "rate_limited": return HttpStatus.TOO_MANY_REQUESTS;
  }
}

// Admin endpoints — JWT-protected, tenant-scoped via the ACTIVE per-store
// membership role (NOT the global JWT role). See ../auth/tenant-context.ts.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class AdminController {
  private readonly productsAdmin = new ProductAdminService();
  private readonly ordersAdmin: OrderAdminService;
  private readonly settingsAdmin = new StoreSettingsService();
  private readonly vouchersAdmin = new VoucherAdminService();
  private readonly storesAdmin = new StoreAdminService();
  private readonly analytics = new AnalyticsService();
  private readonly team = new TeamService();
  private readonly warehouses = new WarehouseService();
  private readonly loyalty = new LoyaltyService();
  private readonly cartsRecovery = new CartRecoveryService();
  private readonly privacyRetention = new PrivacyRetentionService();

  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(NOTIFICATIONS_SERVICE) notifications: NotificationsService,
  ) {
    this.ordersAdmin = new OrderAdminService(notifications);
  }

  /**
   * GET /admin/me — current user summary (no tenant resolution).
   */
  @Get("me")
  async me(@Req() req: Request & { user?: AuthPrincipal }) {
    const user = req.user;
    requireUser(user);
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    return { id: user.sub, email: user.email, role: user.role, storeId: user.storeId ?? null };
  }

  /** GET /admin/stores/mine — the user's stores (for the switcher). */
  @Get("stores/mine")
  async myStores(@Req() req: Request & { user?: AuthPrincipal }) {
    const user = req.user;
    requireUser(user);
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const memberships = await prisma.userStore.findMany({
      where: { userId: user.sub, status: "ACTIVE" },
      include: { store: { select: { id: true, name: true, slug: true } } },
    });
    return { stores: memberships.map((m) => ({ id: m.store.id, name: m.store.name, slug: m.store.slug, role: m.role })) };
      }

      // ─────────────────────────────── v6: store status & data (platform admin) ───────────────────────────────

      /** Platform admin only — cross-store management routes. */
            private requirePlatformAdmin(user: AuthPrincipal | undefined): asserts user is AuthPrincipal {
              if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
              if (user.role !== "PLATFORM_ADMIN") {
                throw new HttpException({ type: "forbidden", message: "Platform admin only" }, HttpStatus.FORBIDDEN);
              }
            }

      /** A1 — PATCH /admin/stores/:id/status — suspend/reinstate/archive/close a store (audited). */
      @Patch("stores/:id/status")
      async setStoreStatus(
        @Req() req: Request & { user?: AuthPrincipal },
        @Param("id") id: string,
        @Body() body: { status: string; reason?: string },
      ) {
        const user = req.user;
    requireUser(user);
        this.requirePlatformAdmin(user);
        const result = await this.storesAdmin.setStatus(id, null, body.status, body.reason, user.sub);
        if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
        return result.value;
      }

      /** C — GET /admin/stores/:id/summary — per-store data summary (platform admin). */
      @Get("stores/:id/summary")
      async storeSummary(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string) {
        const user = req.user;
    requireUser(user);
        this.requirePlatformAdmin(user);
        return { ...(await this.storesAdmin.getDataSummary(id)), storeId: id };
      }

      /** C — GET /admin/stores/:id/probe — cross-store isolation probe (platform admin). */
      @Get("stores/:id/probe")
      async storeProbe(
        @Req() req: Request & { user?: AuthPrincipal },
        @Param("id") id: string,
        @Headers("authorization") authHeader?: string,
      ) {
        const user = req.user;
    requireUser(user);
        this.requirePlatformAdmin(user);
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
        return { ...(await this.storesAdmin.isolationProbe(id, token)), storeId: id };
      }

      // ─────────────────────────────── v6: store access & user management ───────────────────────────────

  /**
   * User-management surface (B1–B3, A3): platform admin OR that store's ACTIVE OWNER.
   * Unknown store → 404 (no enumeration); anyone else → 403.
   */
  private async requireStoreManager(user: AuthPrincipal | undefined, storeId: string): Promise<void> {
      if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
      const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
      if (!store) throw new HttpException({ type: "not_found", message: "Store not found" }, HttpStatus.NOT_FOUND);
      if (user.role === "PLATFORM_ADMIN") return;
      const m = await prisma.userStore.findUnique({ where: { userId_storeId: { userId: user.sub, storeId } } });
      if (m && m.status === "ACTIVE" && m.role === "OWNER") return;
      throw new HttpException({ type: "forbidden", message: "Platform admin or store owner only" }, HttpStatus.FORBIDDEN);
    }

  /** B1 — GET /admin/stores/:id/users — members directory for a store. */
  @Get("stores/:id/users")
  async storeUsers(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") storeId: string) {
    const user = req.user;
    requireUser(user);
    await this.requireStoreManager(user, storeId);
    const rows = await prisma.userStore.findMany({
      where: { storeId },
      include: { user: { select: { id: true, email: true, name: true, role: true, mustChangePassword: true } } },
      orderBy: { createdAt: "asc" },
    });
    return {
          members: rows.map((m) => ({
            userId: m.user.id,
            email: m.user.email,
            name: m.user.name,
            role: m.role,
            status: m.status,
            mustChangePassword: m.user.mustChangePassword,
            joinedAt: m.createdAt,
          })),
          storeId,
        };
      }

      /** POST /admin/stores/:id/users — PLATFORM_ADMIN (or that store's owner) adds a user to a store.
       *  Reuses the team-invite logic (creates user + temp password + membership). */
      @Post("stores/:id/users")
      async addStoreUser(
        @Req() req: Request & { user?: AuthPrincipal },
        @Param("id") storeId: string,
        @Body() body: { email: string; name?: string; role?: string },
      ) {
        const user = req.user;
    requireUser(user);
        await this.requireStoreManager(user, storeId);
        const result = await this.team.invite(storeId, body?.email ?? "", body?.name ?? null, body?.role ?? "STAFF");
        if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
        return result.value;
      }

  /** B2 — PATCH /admin/stores/:id/users/:userId/role — change a member's role. */
  @Patch("stores/:id/users/:userId/role")
  async changeStoreUserRole(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") storeId: string,
    @Param("userId") userId: string,
    @Body() body: { role: string },
  ) {
    const user = req.user;
    requireUser(user);
    await this.requireStoreManager(user, storeId);
    if (userId === user.sub) {
      throw new HttpException({ type: "forbidden", message: "Cannot change your own membership role" }, HttpStatus.FORBIDDEN);
    }
    const result = await this.auth.changeRole({ storeId, userId, role: body.role });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /**
   * B3 — POST /admin/stores/:id/users/:userId/reset-password — reset a member's
   * password. Returns the temp password exactly once; the user must change it on
   * next login. Records a PasswordResetHistory audit row.
   */
  @Post("stores/:id/users/:userId/reset-password")
    async resetStoreUserPassword(
      @Req() req: Request & { user?: AuthPrincipal },
      @Param("id") storeId: string,
      @Param("userId") userId: string,
      @Body() body: { newPassword?: string },
    ) {
      const user = req.user;
    requireUser(user);
      // Access rule (operator decision 2026-09-08): platform admin may reset ONLY the
      // store's OWNER account. The store's owner resets their own team via /admin/team/... 
      if (user.role === "PLATFORM_ADMIN") {
        const target = await prisma.userStore.findUnique({ where: { userId_storeId: { userId, storeId } }, include: { user: { select: { id: true } } } });
        if (!target) throw new HttpException({ type: "not_found", message: "Member not part of this store" }, HttpStatus.NOT_FOUND);
        if (target.role !== "OWNER") {
          throw new HttpException({ type: "forbidden", message: "Platform admin can only reset a store owner's password. The owner resets their own team." }, HttpStatus.FORBIDDEN);
        }
        if (target.userId === user.sub) {
          throw new HttpException({ type: "forbidden", message: "Use your own password change to update your credentials" }, HttpStatus.FORBIDDEN);
        }
      } else {
        // Store owner path: must be that store's OWNER (requireStoreManager already limits to OWNER/platform).
        await this.requireStoreManager(user, storeId);
        if (user.sub === userId) {
          throw new HttpException({ type: "forbidden", message: "Use your own password change to update your credentials" }, HttpStatus.FORBIDDEN);
        }
      }
      const result = await this.auth.resetPassword({ userId, storeId, resetBy: user.sub, newPassword: body.newPassword, byPlatformAdmin: user.role === "PLATFORM_ADMIN" });
      if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
      return result.value;
    }

  /**
   * B3 must-change flow — POST /admin/auth/change-password — the user proves the
   * current (temp) password, sets a new one, and receives a fresh token.
   */
  @Post("auth/change-password")
    async changePassword(
      @Req() req: Request & { user?: AuthPrincipal },
      @Body() body: { email?: string; currentPassword: string; newPassword: string },
    ) {
      // The must-change user has NO token (login returns 403 + mustChangePassword).
      // Proving the current password IS the authentication here — no token required.
      const email = (req.user?.email ?? body.email ?? "").trim().toLowerCase();
      const result = await this.auth.changePassword({
        email,
        currentPassword: body.currentPassword ?? "",
        newPassword: body.newPassword ?? "",
      });
      if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
      return result.value;
    }

  /** PATCH /admin/auth/profile — logged-in user edits their own profile (name/email). */
  @Patch("auth/profile")
  async updateOwnProfile(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { email?: string; name?: string | null },
  ) {
    const user = req.user;
    requireUser(user);
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const result = await this.auth.updateProfile({
      userId: user.sub,
      email: body?.email ?? "",
      name: typeof body?.name === "string" ? body.name : null,
    });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** A3 — PATCH /admin/stores/:id/users/:userId/access — per-user access within a store. */
  @Patch("stores/:id/users/:userId/access")
  async setStoreUserAccess(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") storeId: string,
    @Param("userId") userId: string,
    @Body() body: { status: "ACTIVE" | "DEACTIVATED" },
  ) {
    const user = req.user;
    requireUser(user);
    await this.requireStoreManager(user, storeId);
    if (body.status !== "ACTIVE" && body.status !== "DEACTIVATED") {
      throw new HttpException({ type: "validation", errors: ["status must be ACTIVE or DEACTIVATED"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const result = await this.auth.setUserAccess({ storeId, userId, status: body.status });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/stores — all stores (platform admin only). */
  @Get("stores")
  async listStores(@Req() req: Request & { user?: AuthPrincipal }) {
    const user = req.user;
        requireUser(user);
        if (user.role !== "PLATFORM_ADMIN") {
      throw new HttpException({ type: "forbidden", message: "Platform admin only" }, HttpStatus.FORBIDDEN);
    }
    return { stores: await this.storesAdmin.listAll() };
  }

  /** POST /admin/stores — create a store + bind owner (platform admin only). */
  @Post("stores")
  async createStore(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name: string; slug: string; currencyCode?: string; timezone?: string; ownerEmail: string; ownerPhone: string },
  ) {
    const user = req.user;
        requireUser(user);
        if (user.role !== "PLATFORM_ADMIN") {
      throw new HttpException({ type: "forbidden", message: "Platform admin only" }, HttpStatus.FORBIDDEN);
    }
    const result = await this.storesAdmin.create(body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/users — create a user and optionally bind them to a store (platform admin only). */
  @Post("users")
  @HttpCode(HttpStatus.CREATED)
  async createPlatformUser(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name?: string | null; email: string; phone?: string | null; storeId?: string | null; role: string },
  ) {
    const user = req.user;
    requireUser(user);
    this.requirePlatformAdmin(user);
    const result = await this.auth.createPlatformUser({
      name: body?.name ?? null,
      email: body?.email ?? "",
      phone: body?.phone ?? null,
      storeId: body?.storeId ?? null,
      role: body?.role ?? "",
      actorId: user.sub,
    });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/orders — list orders (tenant-scoped). Filters (V1): status, from, to, customer, source, payment, fulfillment. */
    @Get("orders")
    async orders(
      @Req() req: Request & { user?: AuthPrincipal },
      @Query("status") status?: string,
      @Query("from") from?: string,
      @Query("to") to?: string,
      @Query("customer") customer?: string,
      @Query("source") source?: string,
      @Query("payment") payment?: string,
      @Query("fulfillment") fulfillment?: string,
      @Headers("x-store-id") headerStoreId?: string,
    ) {
      const user = req.user;
    requireUser(user);
          const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
          // Date hardening: non-parseable dates → 422 (never 500).
          for (const [key, val] of [["from", from], ["to", to]] as const) {
            if (val !== undefined && Number.isNaN(Date.parse(val))) {
              throw new HttpException({ type: "validation", errors: [`${key} must be an ISO date`] }, HttpStatus.UNPROCESSABLE_ENTITY);
            }
          }
          const cacheKeyStr = cacheKey("orders", storeId, status ?? "", from ?? "", to ?? "", customer ?? "", source ?? "", payment ?? "", fulfillment ?? "");
                  const hit = await cacheGet<unknown[]>(cacheKeyStr);
                  if (hit) return { orders: hit, storeId };
                  const where: Record<string, unknown> = { storeId };
              if (status) {
                // Validate against the OrderStatus enum — invalid values → empty result, never a 500.
                const statuses = status.split(",").filter((s) => ORDER_STATES.includes(s as OrderState));
                if (statuses.length === 0) return { orders: [], storeId };
                where.status = { in: statuses };
              }
      if (from || to) {
        where.createdAt = {};
        if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from);
        if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to);
      }
      if (customer) {
            where.OR = [
              { customerName: { contains: customer, mode: "insensitive" } },
              { customerPhone: { contains: customer, mode: "insensitive" } },
              { orderNumber: { contains: customer, mode: "insensitive" } },
            ];
          }
          // Source / payment / fulfillment facets (V2 pipeline filters).
                    if (source) where.source = source; // online | pos | PRE_ORDER
                    if (payment) where.paymentMethod = payment; // cod | credit
                    // M8: the fulfillment facet now filters the EXPLICIT fulfillmentType enum.
                    if (fulfillment) where.fulfillmentType = fulfillment === "pickup" ? "PICKUP" : "DELIVERY";
      const list = await prisma.order.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: 200,
            select: {
                        id: true, orderNumber: true, status: true, totalMinor: true, currencyCode: true,
                        customerName: true, customerPhone: true, createdAt: true, paymentStatus: true, source: true,
                        deliveryType: true, deliveryAddressLine1: true, fulfillmentType: true,
                                                paymentMethod: true, signatureData: true, signatureAt: true,
                      },
          });
          await cacheSet(cacheKeyStr, list, 5_000);
                  return { orders: list, storeId };
            }

          /** GET /admin/orders/counts — per-status order counts (for tab badges). Cached 5s.
                        Accepts the SAME range/customer filters as the list so badges match the visible rows. */
                    @Get("orders/counts")
                    async orderCounts(@Req() req: Request & { user?: AuthPrincipal }, @Query("status") status?: string, @Query("from") from?: string, @Query("to") to?: string, @Query("customer") customer?: string, @Query("source") source?: string, @Query("payment") payment?: string, @Query("fulfillment") fulfillment?: string, @Headers("x-store-id") headerStoreId?: string) {
                                          const user = req.user;
    requireUser(user);
                                          const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
                                          for (const [key, val] of [["from", from], ["to", to]] as const) {
                                            if (val !== undefined && Number.isNaN(Date.parse(val))) {
                                              throw new HttpException({ type: "validation", errors: [`${key} must be an ISO date`] }, HttpStatus.UNPROCESSABLE_ENTITY);
                                            }
                                          }
                                          const key = cacheKey("orders-counts", storeId, status ?? "", from ?? "", to ?? "", customer ?? "", source ?? "", payment ?? "", fulfillment ?? "");
                                          const hit = await cacheGet<unknown>(key);
                                          if (hit) return { counts: hit, storeId };
                                          const where: Record<string, unknown> = { storeId };
                                          if (from || to) {
                                            where.createdAt = {};
                                            if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from);
                                            if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to);
                                          }
                                          if (customer) {
                                            where.OR = [
                                              { customerName: { contains: customer, mode: "insensitive" } },
                                              { customerPhone: { contains: customer, mode: "insensitive" } },
                                              { orderNumber: { contains: customer, mode: "insensitive" } },
                                            ];
                                          }
                                          if (source) where.source = source;
                                                                                                          if (payment) where.paymentMethod = payment;
                                                                                                          if (fulfillment) where.fulfillmentType = fulfillment === "pickup" ? "PICKUP" : "DELIVERY"; // M8
                                                                if (status) {
                                                                  const statuses = status.split(",").filter((s) => ORDER_STATES.includes(s as OrderState));
                                                                  if (statuses.length === 0) return { counts: {}, storeId };
                                                                  where.status = { in: statuses };
                                                                }
                                                                const groups = await prisma.order.groupBy({ by: ["status"], where, _count: { _all: true } });
                                          const counts: Record<string, number> = {};
                                          for (const g of groups) counts[g.status] = g._count._all;
                                          await cacheSet(key, counts, 5_000);
                                          return { counts, storeId };
                                        }

          /** GET /admin/orders/:id — full detail (items + history). */
  @Get("orders/:id")
  async orderDetail(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const detail = await this.ordersAdmin.detail(storeId, id);
    if (!detail) throw new HttpException({ type: "not_found", message: "Order not found" }, HttpStatus.NOT_FOUND);
    return detail;
  }

  /** PATCH /admin/orders/:id/status — transition with reason for manual overrides. */
  @Patch("orders/:id/status")
  async transitionOrder(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { toStatus: OrderState; reason?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
        const ctx = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
        const storeId = ctx.storeId;
        // Role-based transition permissions: sales agents may only move delivery states.
        const AGENT_ALLOWED = ["OUT_FOR_DELIVERY", "DELIVERED", "FAILED_DELIVERY"];
        if (ctx.role === "SALES_AGENT" && !AGENT_ALLOWED.includes(body.toStatus)) {
          throw new HttpException(
            { type: "forbidden", message: "Sales agents may only update delivery states" },
            HttpStatus.FORBIDDEN,
          );
        }
        const result = await this.ordersAdmin.transition(storeId, id, body.toStatus, body.reason, {
          type: ctx.role,
          id: user.sub,
        });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** GET /admin/products — tenant-scoped product list with stock. Filters: search, categoryId, minPrice, maxPrice, active. */
  @Get("products")
  async listProducts(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query("search") search?: string,
    @Query("categoryId") categoryId?: string,
    @Query("minPrice") minPrice?: string,
    @Query("maxPrice") maxPrice?: string,
    @Query("active") active?: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
        const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
        const unfiltered = !search && !categoryId && minPrice === undefined && maxPrice === undefined && active === undefined;
        if (unfiltered) {
          const hit = await cacheGet<unknown[]>(cacheKey("products", storeId));
          if (hit) return { products: hit, storeId };
        }
        const items = await this.productsAdmin.listFiltered(storeId, {
          search,
          categoryId,
          minPriceMinor: minPrice ? Math.round(parseFloat(minPrice) * 100) : undefined,
          maxPriceMinor: maxPrice ? Math.round(parseFloat(maxPrice) * 100) : undefined,
          active: active === undefined ? undefined : active === "true",
        });
        if (unfiltered) await cacheSet(cacheKey("products", storeId), items, 30_000);
        return { products: items, storeId };
  }

  /** GET /admin/products/categories — store categories. */
  @Get("products/categories")
  async listCategories(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { categories: await this.productsAdmin.listCategories(storeId) };
  }

  /** POST /admin/products — create product. */
  @Post("products")
  async createProduct(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name: string; sku: string; priceMinor: number; costMinor?: number; stock?: number; categorySlug?: string; categoryName?: string; stockBaseUnit?: string | null; stockBaseQuantity?: number | null; stockConversionFamily?: string | null; description?: string; barcode?: string | null; unit?: string | null; soldByWeight?: boolean; trackStock?: boolean; featured?: boolean; tags?: string[]; reorderThreshold?: number },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.create(storeId, body, user.sub);
        if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
        await cacheBust(cacheKey("products", storeId));
        await cacheBust(cacheKey("inventory", storeId));
        return result.value;
  }

  /** PATCH /admin/products/:id — update product + stock. */
  @Patch("products/:id")
  async updateProduct(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: Partial<{ name: string; sku: string; priceMinor: number; costMinor: number; stock?: number; categorySlug?: string; stockBaseUnit?: string | null; stockBaseQuantity?: number | null; stockConversionFamily?: string | null; description?: string; isActive?: boolean; barcode?: string | null; unit?: string | null; soldByWeight?: boolean; trackStock?: boolean; featured?: boolean; tags?: string[]; relatedProductIds?: string[]; upsellProductIds?: string[]; reorderThreshold?: number }>,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.update(storeId, id, body, user.sub);
        if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
        await cacheBust(cacheKey("products", storeId));
        await cacheBust(cacheKey("inventory", storeId));
        return result.value;
      }

  /** GET /admin/products/:id/price-history — every cost and price change, newest first. */
  @Get("products/:id/price-history")
  async productPriceHistory(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.priceHistory(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** DELETE /admin/products/:id — soft delete. */
  @Delete("products/:id")
  async removeProduct(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.remove(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("inventory", storeId));
    return result.value;
  }

  // ─────────────────────────────── Variants + add-ons (P2c admin) ───────────────────────────────

  /** POST /admin/products/:id/variants — create a variant on a product. */
  @Post("products/:id/variants")
  async addVariant(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: { name: string; sku: string; priceMinor: number; costMinor?: number; stockBaseQuantity?: number; quantityOnHand?: number }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.addVariant(storeId, id, body, user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("inventory", storeId));
    return result.value;
  }

  /** PATCH /admin/products/variants/:variantId — update a variant (incl. set on-hand stock). */
  @Patch("products/variants/:variantId")
  async updateVariant(@Req() req: Request & { user?: AuthPrincipal }, @Param("variantId") variantId: string, @Body() body: Partial<{ name: string; sku: string; priceMinor: number; costMinor: number; stockBaseQuantity: number | null; isActive: boolean; quantityOnHand: number }>, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.updateVariant(storeId, variantId, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("inventory", storeId));
    return result.value;
  }

  /** DELETE /admin/products/variants/:variantId — delete a variant (refused while reserved). */
  @Delete("products/variants/:variantId")
  async deleteVariant(@Req() req: Request & { user?: AuthPrincipal }, @Param("variantId") variantId: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.deleteVariant(storeId, variantId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("inventory", storeId));
    return result.value;
  }

  /** POST /admin/products/:id/addons — create an add-on group with options. */
  @Post("products/:id/addons")
  async addAddon(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: { name: string; required?: boolean; options?: { name: string; priceMinor: number }[] }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.addAddon(storeId, id, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    return result.value;
  }

  /** PATCH /admin/products/addons/options/:optionId — update an add-on option. */
  @Patch("products/addons/options/:optionId")
  async updateAddonOption(@Req() req: Request & { user?: AuthPrincipal }, @Param("optionId") optionId: string, @Body() body: Partial<{ name: string; priceMinor: number; isActive: boolean }>, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.updateAddonOption(storeId, optionId, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    return result.value;
  }

  /** PATCH /admin/products/addons/:addonId — update an add-on group (name / required). */
  @Patch("products/addons/:addonId")
  async updateAddon(@Req() req: Request & { user?: AuthPrincipal }, @Param("addonId") addonId: string, @Body() body: Partial<{ name: string; required: boolean }>, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.updateAddon(storeId, addonId, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    return result.value;
  }

  /** POST /admin/products/addons/:addonId/options — add an option to an existing group. */
  @Post("products/addons/:addonId/options")
  async addAddonOption(@Req() req: Request & { user?: AuthPrincipal }, @Param("addonId") addonId: string, @Body() body: { name: string; priceMinor: number }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.addAddonOption(storeId, addonId, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    return result.value;
  }

  /** DELETE /admin/products/addons/:addonId — delete an add-on group (cascades options). */
  @Delete("products/addons/:addonId")
  async deleteAddon(@Req() req: Request & { user?: AuthPrincipal }, @Param("addonId") addonId: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.deleteAddon(storeId, addonId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    return result.value;
  }

  /** DELETE /admin/products/addons/options/:optionId — delete one option. */
  @Delete("products/addons/options/:optionId")
  async deleteAddonOption(@Req() req: Request & { user?: AuthPrincipal }, @Param("optionId") optionId: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.productsAdmin.deleteAddonOption(storeId, optionId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("products", storeId));
    return result.value;
  }

  /** GET /admin/counter-settings — the few switches counter staff may change (today: the shift rule). */
  @Get("counter-settings")
  async getCounterSettings(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const row = await prisma.storeSettings.findUnique({ where: { storeId }, select: { requireOpenShift: true } });
    return { storeId, requireOpenShift: row?.requireOpenShift ?? false };
  }

  /** PATCH /admin/counter-settings — change a counter switch. Only the listed keys are accepted. */
  @Patch("counter-settings")
  async updateCounterSettings(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { requireOpenShift?: boolean },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    if (typeof body?.requireOpenShift !== "boolean") throw new HttpException({ type: "validation", errors: ["requireOpenShift must be true or false"] }, HttpStatus.BAD_REQUEST);
    await prisma.storeSettings.upsert({
      where: { storeId },
      update: { requireOpenShift: body.requireOpenShift },
      create: { storeId, requireOpenShift: body.requireOpenShift },
    });
    await cacheBust(cacheKey("settings", storeId));
    return { storeId, requireOpenShift: body.requireOpenShift };
  }

  /** GET /admin/settings — store + settings + public link. */
  @Get("settings")
  async getSettings(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
        const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
        const hit = await cacheGet<unknown>(cacheKey("settings", storeId));
        if (hit) return { ...(hit as object), storeId };
        const settings = await this.settingsAdmin.get(storeId);
        if (!settings) throw new HttpException({ type: "not_found", message: "Store not found" }, HttpStatus.NOT_FOUND);
        await cacheSet(cacheKey("settings", storeId), settings, 60_000);
        return { ...settings, storeId };
  }

  /** PATCH /admin/settings — update store settings. */
  @Patch("settings")
  async updateSettings(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: {
      allowGuestOrders?: boolean; orderingPaused?: boolean; closedStoreMessage?: string | null;
      minOrderAmountMinor?: number; deliveryFeeMinor?: number; deliveryEnabled?: boolean;
      pickupEnabled?: boolean; orderCutoff?: string | null; maxOpenOrdersPerCustomer?: number;
      seniorPwdDiscountEnabled?: boolean;
      messengerConnected?: boolean; messengerPageId?: string | null;
      loyaltyPointsPerPeso?: number; loyaltyWelcomeBonusPoints?: number; loyaltyExpiryMonths?: number;
      orderNumberPrefix?: string | null;
      privacyRetentionDays?: number;
    },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    if (role === "STAFF") throw new HttpException({ type: "forbidden", message: "Store settings are for the owner or manager — use Counter settings" }, HttpStatus.FORBIDDEN);
    const result = await this.settingsAdmin.update(storeId, body);
        if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
        await cacheBust(cacheKey("settings", storeId));
        return { ...result.value, storeId };
  }

  /** GET /admin/privacy/retention — dry-run preview. */
  @Get("privacy/retention")
  async retentionPreview(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const result = await this.privacyRetention.preview(storeId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { storeId, ...result.value };
  }

  /** POST /admin/privacy/retention/purge — explicit, audited purge. */
  @Post("privacy/retention/purge")
  async retentionPurge(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.privacyRetention.purge(storeId, user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/store-link — update store link branding (P8). */
  @Patch("store-link")
  async updateStoreLink(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { accentColor?: string; bannerText?: string | null; shareMessage?: string | null; logoUrl?: string | null },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await this.settingsAdmin.updateLink(storeId, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** POST /admin/store-link/rotate — rotate the public-link access token (revokes old, reactivates). */
  @Post("store-link/rotate")
  async rotateStoreLink(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await rotateStoreLinkToken(storeId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** POST /admin/store-link/revoke — revoke the public link (storefront 404s until rotated). */
  @Post("store-link/revoke")
  async revokeStoreLink(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await revokeStoreLink(storeId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** GET /admin/vouchers — list store vouchers with redemption counts. */
  @Get("vouchers")
  async listVouchers(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { vouchers: await this.vouchersAdmin.list(storeId), storeId };
  }

  /** POST /admin/vouchers — create a voucher. */
  @Post("vouchers")
  async createVoucher(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: {
      code: string; discountMinor?: number; type?: "fixed" | "percent" | "free_delivery"; percentBp?: number;
      minOrderMinor?: number; maxRedemptions?: number | null; perCustomerLimit?: number | null;
      firstOrderOnly?: boolean; scopeType?: "all" | "product" | "category"; scopeSku?: string; scopeCategorySlug?: string;
      stackable?: boolean; startsAt?: string | null; expiresAt?: string | null; description?: string | null;
    },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.vouchersAdmin.create(storeId, {
      code: body.code,
      discountMinor: body.discountMinor,
      type: body.type,
      percentBp: body.percentBp,
      minOrderMinor: body.minOrderMinor,
      maxRedemptions: body.maxRedemptions,
      perCustomerLimit: body.perCustomerLimit,
      firstOrderOnly: body.firstOrderOnly,
      scopeType: body.scopeType,
      scopeSku: body.scopeSku,
      scopeCategorySlug: body.scopeCategorySlug,
      stackable: body.stackable,
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      description: body.description,
    });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/vouchers/:id — toggle active or edit discount. */
  @Patch("vouchers/:id")
  async updateVoucher(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: Partial<{ isActive: boolean; discountMinor: number; maxRedemptions: number | null; type: "fixed" | "percent" | "free_delivery"; percentBp: number; perCustomerLimit: number | null; firstOrderOnly: boolean; scopeType: "all" | "product" | "category"; scopeSku: string; scopeCategorySlug: string; stackable: boolean; minOrderMinor: number; description: string | null; startsAt: string | null; expiresAt: string | null }>,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const { startsAt, expiresAt, ...rest } = body;
    const result = await this.vouchersAdmin.update(storeId, id, {
      ...rest,
      ...(startsAt !== undefined ? { startsAt: startsAt ? new Date(startsAt) : null } : {}),
      ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
    });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/customers — store customers. Filters: search, approvalStatus, onlyUtang. */
  @Get("customers")
  async listCustomers(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query("search") search?: string,
    @Query("approvalStatus") approvalStatus?: string,
    @Query("onlyUtang") onlyUtang?: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const customers = await this.loyalty.adminCustomers(storeId, {
      search,
      approvalStatus,
      onlyUtang: onlyUtang === "true",
    });
    return {
      customers: customers.map((sc) => {
              const row = LoyaltyService.toAdminRow(sc);
              return { ...row, loyaltyPoints: sc.loyaltyBalancePoints };
            }),
      storeId,
    };
  }

  /** POST /admin/customers — create a customer (find-or-create global by phone/email, then store profile). */
  @Post("customers")
  async createCustomer(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name: string; phone?: string; email?: string; address?: string; creditApproved?: boolean; creditLimitMinor?: number; creditUnlimited?: boolean },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    // Anyone on the counter can add a customer on credit (no limit); only the owner/manager sets a limit.
    if (body?.creditLimitMinor !== undefined && !(["OWNER", "STORE_OWNER", "MANAGER", "PLATFORM_ADMIN"] as string[]).includes(role)) {
      throw new HttpException({ type: "forbidden", message: "Only the owner or manager can set a credit limit" }, HttpStatus.FORBIDDEN);
    }
    const result = await this.loyalty.createCustomer(storeId, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("customers", storeId));
    return { ...result.value, storeId };
  }

  /** GET /admin/customers/export.csv — customer list + balances (owner/manager). (Must precede customers/:id.) */
  @Get("customers/export.csv")
  async exportCustomersCsv(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string, @Res() res?: any) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const customers = await this.loyalty.adminCustomers(storeId, {});
    const rows = customers.map((sc) => ({
      name: sc.customer.name ?? "",
      email: sc.customer.email ?? "",
      phone: sc.customer.phone ?? "",
      approvalStatus: sc.approvalStatus,
      loyaltyPoints: sc.loyaltyBalancePoints,
      creditApproved: sc.creditApproved,
      creditLimitPesos: (sc.creditLimitMinor / 100).toFixed(2),
      utangBalancePesos: (sc.creditBalanceMinor / 100).toFixed(2),
      joinedAt: sc.createdAt.toISOString(),
    }));
    const esc = (v: string | number | boolean) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["name", "email", "phone", "approvalStatus", "loyaltyPoints", "creditApproved", "creditLimitPesos", "utangBalancePesos", "joinedAt"];
    const csv = [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h as keyof typeof r])).join(","))].join("\n");
    res?.setHeader?.("Content-Type", "text/csv; charset=utf-8");
    res?.setHeader?.("Content-Disposition", `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res?.send?.(csv) ?? csv;
  }

  /** GET /admin/customers/:id — full profile (orders, utang, loyalty). */
  @Get("customers/:id")
  async customerProfile(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const profile = await this.loyalty.adminCustomerProfile(storeId, id);
    if (!profile) throw new HttpException({ type: "not_found", message: "Customer not found" }, HttpStatus.NOT_FOUND);
    return profile;
  }

  /** GET /admin/customers/:id/loyalty — ledger for one customer. */
  @Get("customers/:id/loyalty")
  async customerLoyalty(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const sc = await prisma.storeCustomer.findFirst({ where: { id, storeId } });
    if (!sc) throw new HttpException({ type: "not_found", message: "Customer not found" }, HttpStatus.NOT_FOUND);
    const ledger = await this.loyalty.customerLedger(storeId, sc.customerId);
    return ledger;
  }

  /** PATCH /admin/customers/:id — update name/phone/email + credit limit. */
  @Patch("customers/:id")
  async updateCustomer(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { name?: string; phone?: string; email?: string; address?: string; creditLimitMinor?: number; creditUnlimited?: boolean },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    if ((body?.creditLimitMinor !== undefined || body?.creditUnlimited !== undefined) && !(["OWNER", "STORE_OWNER", "MANAGER", "PLATFORM_ADMIN"] as string[]).includes(role)) {
      throw new HttpException({ type: "forbidden", message: "Only the owner or manager can change a credit limit" }, HttpStatus.FORBIDDEN);
    }
    const result = await this.loyalty.updateCustomer(storeId, id, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("customers", storeId));
    return { ...result.value, storeId };
  }

  /** POST /admin/customers/:id/loyalty/adjust — manual points adjustment (never below 0). */
  @Post("customers/:id/loyalty/adjust")
  async adjustPoints(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { delta: number; note: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.loyalty.adjustPoints(storeId, id, body.delta, body.note);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/loyalty/expire - P3h: FIFO-expire points older than the store's window
   *  (loyaltyExpiryMonths). A scheduler/cron should call this daily; returns counts. */
  @Post("loyalty/expire")
  async expireLoyaltyPoints(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.loyalty.expirePoints(storeId);
    await cacheBust(cacheKey("customers", storeId));
    return result;
  }

  /** POST /admin/carts/expire - P3j: abandoned-cart recovery. Marks expired OPEN carts
   *  ABANDONED and enqueues a cart.abandoned outbox event per cart. Cron-able. */
  @Post("carts/expire")
  async expireCarts(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return this.cartsRecovery.expireAbandoned(storeId);
  }

  /** PATCH /admin/orders/:id/items — W1: stock-delta item edit (RECEIVED/CONFIRMED/ON_HOLD). */
  @Patch("orders/:id/items")
  async orderItems(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { items: { productId: string; quantity: number }[] },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const result = await this.ordersAdmin.replaceOrderItems(storeId, id, body?.items ?? [], user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** POST /admin/orders/:id/send-for-delivery — W1: one-tap advance to OUT_FOR_DELIVERY. */
  @Post("orders/:id/send-for-delivery")
  async orderSendForDelivery(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const result = await this.ordersAdmin.sendForDelivery(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** POST /admin/orders/:id/complete-now — W1: pickup/POS → COMPLETED directly. */
  @Post("orders/:id/complete-now")
  async orderCompleteNow(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const result = await this.ordersAdmin.completeNow(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** GET /admin/analytics/summary — dashboard KPIs. */
  @Get("analytics/summary")
  async analyticsSummary(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { ...(await this.analytics.summary(storeId)), storeId };
  }

  /** GET /admin/analytics/status — order status funnel. */
  @Get("analytics/status")
  async analyticsStatus(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { rows: await this.analytics.statusBreakdown(storeId), storeId };
  }

  /** GET /admin/analytics/daily?days=14 — revenue + orders per day. */
  @Get("analytics/daily")
  async analyticsDaily(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string, @Query("days") days?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const n = Math.min(Math.max(parseInt(days ?? "14", 10) || 14, 3), 90);
    return { ...(await this.analytics.dailyRevenue(storeId, n)), storeId };
  }

  /** GET /admin/analytics/products — top products. */
  @Get("analytics/products")
  async analyticsProducts(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { products: await this.analytics.topProducts(storeId), storeId };
  }

  /** GET /admin/analytics/vouchers — voucher usage. */
  @Get("analytics/vouchers")
  async analyticsVouchers(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { vouchers: await this.analytics.voucherUsage(storeId), storeId };
  }

  /** GET /admin/maintenance/stats — cart/order counts (real DB numbers). */
  @Get("maintenance/stats")
  async maintenanceStats(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const [openCarts, expiredCarts, orders] = await Promise.all([
      prisma.cart.count({ where: { storeId, status: "OPEN" } }),
      prisma.cart.count({ where: { storeId, status: "OPEN", expiresAt: { lt: new Date() } } }),
      prisma.order.count({ where: { storeId } }),
    ]);
    return { openCarts, expiredCarts, orders, storeId };
  }

  /** POST /admin/maintenance/sweep-expired-carts — mark expired OPEN carts ABANDONED. */
  @Post("maintenance/sweep-expired-carts")
  async sweepExpiredCarts(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await prisma.cart.updateMany({
      where: { storeId, status: "OPEN", expiresAt: { lt: new Date() } },
      data: { status: "ABANDONED" },
    });
    return { marked: result.count, storeId };
  }

  // ─────────────────────────────── Warehouses / transfers ───────────────────────────────

  /** GET /admin/warehouses — list warehouses. */
  @Get("warehouses")
  async listWarehouses(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { warehouses: await this.warehouses.list(storeId), storeId };
  }

  /** POST /admin/warehouses — create a location (first = default). Rice Ops M1: type/code/address. */
  @Post("warehouses")
  async createWarehouse(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name: string; type?: string; code?: string | null; address?: string | null },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.warehouses.create(storeId, {
      name: body?.name,
      type: body?.type,
      code: body?.code,
      address: body?.address,
    });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/locations/quick — counter staff add a place on the spot; it is flagged for the owner to check. */
  @Post("locations/quick")
  async quickLocation(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name?: string; type?: string; address?: string | null },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.warehouses.create(storeId, { name: body?.name, type: body?.type, address: body?.address, needsReview: true });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/warehouses/:id — Rice Ops M1: rename, code, address, type, active, default. */
  @Patch("warehouses/:id")
  async updateWarehouse(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { name?: string; type?: string; code?: string | null; address?: string | null; isActive?: boolean; isDefault?: boolean; needsReview?: boolean },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.warehouses.update(storeId, id, {
      name: body?.name,
      type: body?.type,
      code: body?.code,
      address: body?.address,
      isActive: typeof body?.isActive === "boolean" ? body.isActive : undefined,
      isDefault: typeof body?.isDefault === "boolean" ? body.isDefault : undefined,
      needsReview: typeof body?.needsReview === "boolean" ? body.needsReview : undefined,
    });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /**
   * POST /admin/warehouses/:id/stock — set a product's COUNTED stock at a location.
   * Rice Ops M1: owner/manager only, a reason is required, and the change is an
   * actor-attributed ADJUST in the ledger (no silent overwrite).
   */
  @Post("warehouses/:id/stock")
  async setWarehouseStock(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { productId: string; quantityOnHand: number; reason: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.warehouses.setStock(storeId, id, body?.productId, body?.quantityOnHand, user.sub, body?.reason);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/warehouses/:id/prices — Rice Ops M1: main vs this location's selling prices. */
  @Get("warehouses/:id/prices")
  async listLocationPrices(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.warehouses.listPrices(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { prices: result.value, storeId };
  }

  /** PUT /admin/warehouses/:id/prices/:productId — set (or null to clear) a location's own price. */
  @Put("warehouses/:id/prices/:productId")
  async setLocationPrice(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Param("productId") productId: string,
    @Body() body: { priceMinor: number | null },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const priceMinor = body?.priceMinor === null ? null : Number(body?.priceMinor);
    const result = await this.warehouses.setPrice(storeId, id, productId, priceMinor, user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/transfers — request a stock transfer. */
  @Post("transfers")
  async requestTransfer(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { fromWarehouseId: string; toWarehouseId: string; productId: string; quantity: number; reason?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    // Rice Ops M3: staff ask for stock for THEIR location (owner/manager: any).
    const refusal = locationRefusal(await loadActor(storeId, user.sub, role), body?.toWarehouseId);
    if (refusal) throw new HttpException({ type: "forbidden", message: refusal }, HttpStatus.FORBIDDEN);
    const result = await this.warehouses.requestTransfer(storeId, body.fromWarehouseId, body.toWarehouseId, body.productId, body.quantity, user.sub, body.reason);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/transfers/:id/approve — owner/manager approves. */
  @Patch("transfers/:id/approve")
  async approveTransfer(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await this.warehouses.approveTransfer(storeId, id, user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/transfers/:id/complete — moves the stock (owner/manager). */
  @Patch("transfers/:id/complete")
  async completeTransfer(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { signatures?: unknown },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    // Rice Ops M2: the receiver signs; signatures travel in the same request.
    const actor = await loadActor(storeId, user.sub, role);
    const result = await this.warehouses.completeTransfer(storeId, id, actor, signaturesFrom(body?.signatures));
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/transfers/:id/cancel — Rice Ops M1: cancel before any stock moved. */
  @Patch("transfers/:id/cancel")
  async cancelTransfer(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const result = await this.warehouses.cancelTransfer(storeId, id, user.sub, body?.reason);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/transfers — list transfers. */
  @Get("transfers")
  async listTransfers(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { transfers: await this.warehouses.listTransfers(storeId), storeId };
  }

  // ─────────────────────────────── Team (roles) ───────────────────────────────

  /** GET /admin/team — active store members. */
  @Get("team")
  async listTeam(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
        requireUser(user);
        const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW); // everyone in the store can see who's on the team
        return { members: await this.team.list(storeId), storeId };
  }

  /** POST /admin/team/invite — invite MANAGER / STAFF / SALES_AGENT. */
  @Post("team/invite")
  async inviteMember(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { email?: string; phone?: string; name?: string; role: string; homeLocationId?: string | null },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await this.team.invite(
      storeId,
      typeof body?.email === "string" ? body.email : "",
      body?.name ?? null,
      body?.role,
      typeof body?.phone === "string" ? body.phone : null,
      typeof body?.homeLocationId === "string" ? body.homeLocationId : undefined,
    );
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/team/:userId/role — change a member's role. */
  @Patch("team/:userId/role")
  async changeMemberRole(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("userId") userId: string,
    @Body() body: { role: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await this.team.changeRole(storeId, userId, body.role);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/team/:userId/reset-password — store OWNER resets their own team member's password (temp shown once, must change next login). */
  @Post("team/:userId/reset-password")
  async resetTeamPassword(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("userId") userId: string,
    @Body() body: { newPassword?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    // OWNER (or platform) of this store only — same rule as stores/:id reset, team-scoped.
    await this.requireStoreManager(user, storeId);
    if (user.sub === userId) {
      throw new HttpException({ type: "forbidden", message: "Use your own password change to update your credentials" }, HttpStatus.FORBIDDEN);
    }
    if (user.role === "PLATFORM_ADMIN") {
      const target = await prisma.userStore.findUnique({ where: { userId_storeId: { userId, storeId } } });
      if (!target) throw new HttpException({ type: "not_found", message: "Member not part of this store" }, HttpStatus.NOT_FOUND);
      if (target.role !== "OWNER") {
        throw new HttpException({ type: "forbidden", message: "Platform admin can only reset a store owner's password. The owner resets their own team." }, HttpStatus.FORBIDDEN);
      }
    }
    const result = await this.auth.resetPassword({ userId, storeId, resetBy: user.sub, newPassword: body.newPassword, byPlatformAdmin: user.role === "PLATFORM_ADMIN" });
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** DELETE /admin/team/:userId — deactivate a member. */
  @Delete("team/:userId")
  async deactivateMember(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("userId") userId: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.MANAGE);
    const result = await this.team.deactivate(storeId, userId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  // ─────────────────────────────── Customer approval (CRM) ───────────────────────────────

  /** PATCH /admin/customers/:id/approval — approve/reject/suspend a store customer (audited). */
  @Patch("customers/:id/approval")
  async setCustomerApproval(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param("id") id: string,
    @Body() body: { status: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED"; reason?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
        const ctx = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
        const storeId = ctx.storeId;
        const sc = await prisma.storeCustomer.findFirst({ where: { id, storeId } });
        if (!sc) throw new HttpException({ type: "not_found", message: "Customer not found" }, HttpStatus.NOT_FOUND);

        const updated = await prisma.storeCustomer.update({
          where: { id },
          data: { approvalStatus: body.status },
        });
        await prisma.auditLog.create({
          data: {
            storeId,
            actorType: ctx.role,
        actorId: user.sub,
        action: "CUSTOMER_APPROVAL",
        entityType: "StoreCustomer",
        entityId: id,
        after: { status: body.status, reason: body.reason ?? null },
      },
    });
    return { id, approvalStatus: updated.approvalStatus };
  }
}

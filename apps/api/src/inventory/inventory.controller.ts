import { Controller, Get, Headers, HttpException, HttpStatus, Inject, Post, Body, Query, Req, UseGuards } from "@nestjs/common";
import { redactCost, seesCost } from "../domain/cost-redact.js";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheGet, cacheKey, cacheSet } from "../persistence/ttl-cache.js";
import { assertDto, STOCK_ADJUST_DTO, STOCK_CONVERSION_DTO } from "../security/validate.js";
import { INVENTORY_SERVICE, InventoryService, type InventoryConversionInput } from "./inventory.service.js";

function statusFor(error: { type: string }): HttpStatus {
  switch (error.type) {
    case "validation": return HttpStatus.UNPROCESSABLE_ENTITY;
    case "not_found": return HttpStatus.NOT_FOUND;
    case "conflict": return HttpStatus.CONFLICT;
    case "forbidden": return HttpStatus.FORBIDDEN;
    default: return HttpStatus.BAD_REQUEST;
  }
}

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class InventoryController {
  constructor(@Inject(INVENTORY_SERVICE) private readonly inventorySvc: InventoryService) {}

  /** GET /admin/inventory?search=&categoryId=&warehouseId=&status=in|low|out */
  @Get("inventory")
  async list(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query("search") search?: string,
    @Query("categoryId") categoryId?: string,
    @Query("warehouseId") warehouseId?: string,
    @Query("status") status?: "in" | "low" | "out",
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const shownTo = <T,>(d: T): T => (seesCost(role) ? d : redactCost(d));
    // The inventory list aggregates every product's stock levels (expensive) and the admin
    // dashboard fires ~10 queries in parallel — a saturated Prisma pool turns that into 10s
    // pool waits and 500s. A short store-scoped cache keeps the panel cheap; adjustments bust it.
    const key = cacheKey("inventory", storeId, search ?? "", categoryId ?? "", warehouseId ?? "", status ?? "");
    const hit = await cacheGet<Record<string, unknown>>(key);
    if (hit) return shownTo(hit);
    const data = await this.inventorySvc.list(storeId, { search, categoryId, warehouseId, status });
    const warehouses = await prisma.warehouse.findMany({ where: { storeId }, select: { id: true, name: true, isDefault: true } });
    const categories = await prisma.category.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true } });
    const payload = { ...data, warehouses, categories };
    await cacheSet(key, payload, 15_000);
    return shownTo(payload);
  }

  /** POST /admin/stock/adjust — reasoned stock adjustment (manager+). */
  @Post("stock/adjust")
  async adjust(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { productId?: string; warehouseId?: string; delta?: number; setTo?: number; reason?: string; allowNegative?: boolean },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const dto = assertDto<{ productId: string; warehouseId?: string; delta?: number; setTo?: number; reason: string; allowNegative?: boolean }>(body ?? {}, STOCK_ADJUST_DTO);
    const result = await this.inventorySvc.adjust(storeId, user.sub, dto);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    await cacheBust(cacheKey("inventory", storeId)); // the panel must not show the pre-adjust balance
    return result.value;
  }

  /** POST /admin/stock/conversions — atomically consume one SKU/variant and produce another. */
  @Post("stock/conversions")
  async convert(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: InventoryConversionInput,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.OWNER_MANAGER);
    const dto = assertDto<InventoryConversionInput>(body ?? {}, STOCK_CONVERSION_DTO);
    const result = await this.inventorySvc.convert(storeId, user.sub, dto);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { ...result.value, storeId };
  }

  /** GET /admin/stock/movements — the raw stock ledger (any type), newest first. */
  @Get("stock/movements")
  async movements(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query("productId") productId?: string,
    @Query("type") type?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return this.inventorySvc.movements(storeId, {
      productId, type, from, to,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  /** GET /admin/stock/adjustments — adjustment history only (ADJUST movements). */
  @Get("stock/adjustments")
  async adjustments(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query("productId") productId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return this.inventorySvc.adjustments(storeId, {
      productId, from, to,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }
}

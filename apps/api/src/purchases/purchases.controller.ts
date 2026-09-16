import {
  Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Post, Req, UseGuards,
} from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { PURCHASES_SERVICE, PurchasesService } from "./purchases.service.js";
import { SUPPLIERS_SERVICE, SuppliersService } from "./suppliers.service.js";

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

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class PurchasesController {
  constructor(
    @Inject(PURCHASES_SERVICE) private readonly purchasesSvc: PurchasesService,
    @Inject(SUPPLIERS_SERVICE) private readonly suppliersSvc: SuppliersService,
  ) {}

  @Get("suppliers")
  async listSuppliers(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { suppliers: await this.suppliersSvc.list(storeId) };
  }

  @Post("suppliers")
  async createSupplier(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { name: string; contactPerson?: string; phone?: string; email?: string }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.suppliersSvc.create(storeId, body.name, body.contactPerson, body.phone, body.email);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  @Post("purchases")
  async create(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { vendor?: string; supplierId?: string; note?: string; items: { productId: string; quantity: number; costMinor: number }[] }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.purchasesSvc.create(storeId, user.sub, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  @Get("purchases")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { purchases: await this.purchasesSvc.list(storeId) };
  }

  @Get("purchases/replenishment")
  async replenishment(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { items: await this.purchasesSvc.replenishmentList(storeId) };
  }
}
import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { CustomerAuthService, CUSTOMER_AUTH_SERVICE, type ConsentInput, type SavedAddressInput } from "./customer-auth.service.js";

function statusFor(error: ApiError): HttpStatus {
  switch (error.type) {
    case "validation": return HttpStatus.UNPROCESSABLE_ENTITY;
    case "conflict": return HttpStatus.CONFLICT;
    case "unauthorized": return HttpStatus.UNAUTHORIZED;
    case "not_found": return HttpStatus.NOT_FOUND;
    case "forbidden": return HttpStatus.FORBIDDEN;
    case "rate_limited": return HttpStatus.TOO_MANY_REQUESTS;
  }
}

function throwUnless<T>(r: { ok: true; value: T } | { ok: false; error: ApiError }): T {
  if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
  return r.value;
}

@Controller("auth/customer")
export class CustomerAuthController {
  constructor(@Inject(CUSTOMER_AUTH_SERVICE) private readonly auth: CustomerAuthService) {}

  /** POST /auth/customer/register */
  @Post("register")
  async register(@Body() body: { email: string; password: string; name?: string; phone?: string; consent?: ConsentInput }) {
    return throwUnless(await this.auth.register(body));
  }

  /** POST /auth/customer/login */
  @Post("login")
  async login(@Body() body: { email: string; password: string }) {
    return throwUnless(await this.auth.login(body));
  }

  /** GET /auth/customer/me?storeId= — loyalty, credit, recent orders (U6). */
  @Get("me")
  async me(@Headers("authorization") authorization?: string, @Query("storeId") storeId?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return throwUnless(await this.auth.me(token, storeId));
  }

  // ─────────── Saved addresses (P1.portal) ───────────

  /** GET /auth/customer/addresses?storeId= */
  @Get("addresses")
  async listAddresses(@Headers("authorization") authorization?: string, @Query("storeId") storeId?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return throwUnless(await this.auth.listAddresses(token, storeId ?? ""));
  }

  /** POST /auth/customer/addresses — body: { storeId, label?, addressLine1?, …, regionCode?…, isDefault? } */
  @Post("addresses")
  async createAddress(@Body() body: { storeId: string } & SavedAddressInput, @Headers("authorization") authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return throwUnless(await this.auth.createAddress(token, body.storeId ?? "", body));
  }

  /** PATCH /auth/customer/addresses/:id — body: { storeId, ...partial } */
  @Patch("addresses/:id")
  async updateAddress(@Param("id") id: string, @Body() body: { storeId: string } & SavedAddressInput, @Headers("authorization") authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return throwUnless(await this.auth.updateAddress(token, body.storeId ?? "", id, body));
  }

  /** DELETE /auth/customer/addresses/:id?storeId= */
  @Delete("addresses/:id")
  async deleteAddress(@Param("id") id: string, @Query("storeId") storeId?: string, @Headers("authorization") authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return throwUnless(await this.auth.deleteAddress(token, storeId ?? "", id));
  }

  // ─────────── Consent (DPA / RA 10173) ───────────

  /** POST /auth/customer/consent — body: { scope, channel?, granted?, version? } */
  @Post("consent")
  async recordConsent(@Body() body: ConsentInput, @Headers("authorization") authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return throwUnless(await this.auth.recordConsent(token, body));
  }

  /** GET /auth/customer/consents */
  @Get("consents")
  async listConsents(@Headers("authorization") authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return throwUnless(await this.auth.listConsents(token));
  }
}
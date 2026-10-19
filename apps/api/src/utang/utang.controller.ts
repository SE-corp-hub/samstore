// Rice Ops M6 — Utang routes: customer list and limits, Bayad sa utang, texts, reminders.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { IdempotencyInterceptor } from "../security/idempotency.interceptor.js";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor } from "../people/people.service.js";
import { signaturesFrom } from "../people/signature-input.js";
import { listSms, logOpenedText, resendSms } from "../sms/sms.service.js";
import { UtangService } from "./utang.service.js";

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

@Controller("admin")
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class UtangController {
  private readonly utang = new UtangService();

  private async ctx(req: Req_, headerStoreId: string | undefined) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  /** GET /admin/utang/customers?search= — the customer list with balances, limits and the last text. */
  @Get("utang/customers")
  async customers(@Req() req: Req_, @Query("search") search?: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    return { storeId, customers: await this.utang.customers(storeId, { search }) };
  }

  /** POST /admin/utang/customers — { name, phone, limitMinor? (owner/manager only) } */
  @Post("utang/customers")
  async addCustomer(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.utang.addCustomer(storeId, actor, { name: str(body?.name), phone: str(body?.phone), limitMinor: body?.limitMinor }));
  }

  /** POST /admin/utang/customers/:id/limit — { limitMinor } or { unlimited: true } (owner/manager; 0 = no utang). */
  @Post("utang/customers/:id/limit")
  async setLimit(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.utang.setLimit(storeId, actor, id, body?.limitMinor, body?.unlimited === true));
  }

  /** POST /admin/utang/payments — Bayad sa utang: { customerId, amountMinor, method:"cash"|"gcash", tenderedMinor?, reference?, locationId?, signatures } */
  @Post("utang/payments")
  async collect(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return unwrap(await this.utang.collect(storeId, actor, {
      customerId: str(body?.customerId), amountMinor: body?.amountMinor, method: str(body?.method), tenderedMinor: body?.tenderedMinor,
      reference: str(body?.reference), locationId: str(body?.locationId), signatures: signaturesFrom(body?.signatures),
    }));
  }

  /** GET /admin/sms?customerId=&status= — the texts, newest first. */
  @Get("sms")
  async sms(@Req() req: Req_, @Query("customerId") customerId?: string, @Query("status") status?: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    return { storeId, messages: await listSms(storeId, { storeCustomerId: customerId, status }) };
  }

  /** POST /admin/sms/opened — log that a text was opened in the phone's SMS app (never "sent"). */
  @Post("sms/opened")
  async opened(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    const template = str(body?.template);
    const text = str(body?.text);
    if (!template || !text) throw new HttpException({ type: "validation", errors: ["template and text are required"] }, HttpStatus.BAD_REQUEST);
    try {
      return await logOpenedText(storeId, {
        storeCustomerId: str(body?.storeCustomerId) ?? null, phone: str(body?.phone) ?? null, template, text,
        documentType: str(body?.documentType) ?? null, documentId: str(body?.documentId) ?? null, createdById: actor.userId,
      });
    } catch (e) {
      throw new HttpException({ type: "not_found", message: e instanceof Error ? e.message : "Could not log the text" }, HttpStatus.NOT_FOUND);
    }
  }

  /** POST /admin/sms/:id/resend — Ipadala ulit. */
  @Post("sms/:id/resend")
  async resend(@Req() req: Req_, @Param("id") id: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    return unwrap(await resendSms(storeId, id));
  }

  /** GET /admin/utang/settings · POST /admin/utang/settings (owner/manager) — texts and reminders on/off. */
  @Get("utang/settings")
  async settings(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h);
    return { storeId, settings: await this.utang.settings(storeId) };
  }

  @Post("utang/settings")
  async updateSettings(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    return { storeId, settings: unwrap(await this.utang.updateSettings(storeId, actor, body ?? {})) };
  }

  /** POST /admin/utang/reminders/run — queue the reminders due now (idempotent; the worker also runs it hourly). */
  @Post("utang/reminders/run")
  async reminders(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h);
    if (!["OWNER", "MANAGER", "STORE_OWNER"].includes(actor.role)) throw new HttpException({ type: "forbidden", message: "Owner only" }, HttpStatus.FORBIDDEN);
    return { storeId, ...(await this.utang.runReminders(storeId)) };
  }
}

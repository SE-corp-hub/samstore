import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { CrmService, type SegmentRule } from "./crm.service.js";

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

// P8: CRM — customer aggregates + segmentation + campaigns. Tenant-scoped.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class CrmAdminController {
  private readonly crm = new CrmService();

  /** GET /admin/crm/customers — enriched aggregates (LTV/AOV/recency/favorite/tags/psid). */
  @Get("crm/customers")
  async customers(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, customers: await this.crm.aggregates(storeId) };
  }

  /** POST /admin/crm/customers/:id/tags — set CRM tags. */
  @Post("crm/customers/:id/tags")
  async setTags(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: { tags: string[] }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.crm.setTags(storeId, id, Array.isArray(body?.tags) ? body.tags : []);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/crm/segment — evaluate a rule live; returns matching customers. */
  @Post("crm/segment")
  async segment(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { rule: SegmentRule }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const matches = this.crm.segment(await this.crm.aggregates(storeId), body?.rule ?? {});
    return { storeId, count: matches.length, customers: matches };
  }

  /** GET /admin/crm/campaigns. */
  @Get("crm/campaigns")
  async campaigns(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, campaigns: await this.crm.listCampaigns(storeId) };
  }

  /** POST /admin/crm/campaigns — create a draft campaign. */
  @Post("crm/campaigns")
  async createCampaign(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { name: string; rule: SegmentRule; message: string }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.crm.createCampaign(storeId, body?.name ?? "", body?.rule ?? {}, body?.message ?? "");
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/crm/campaigns/:id/run — evaluate the segment and enqueue campaign.send events. */
  @Post("crm/campaigns/:id/run")
  async runCampaign(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.crm.runCampaign(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** DELETE /admin/crm/campaigns/:id. */
  @Delete("crm/campaigns/:id")
  async deleteCampaign(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.crm.deleteCampaign(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}
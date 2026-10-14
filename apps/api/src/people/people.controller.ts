// Rice Ops M2 — people (home location, PIN), kargadors, signatures, approvals inbox
// ("Para sa iyo") and drafts ("Tapusin"). All routes are tenant-scoped through
// resolveTenant; the store role it returns (not the JWT role) is the actor's role.

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { loadActor, PeopleService } from "./people.service.js";
import { badRequest, signaturesFrom } from "./signature-input.js";

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

function unwrap<T>(r: R<T>): T {
  if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
  return r.value;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const optNullStr = (v: unknown): string | null | undefined => (v === null ? null : typeof v === "string" ? v : undefined);



@Controller("admin")
@UseGuards(JwtAuthGuard)
export class PeopleController {
  private readonly people = new PeopleService();

  private async ctx(req: Req_, headerStoreId: string | undefined, roles: readonly string[]) {
    const user = req.user;
    requireUser(user);
    const { storeId, role } = await resolveTenant(user, headerStoreId, roles);
    return { storeId, actor: await loadActor(storeId, user.sub, role) };
  }

  // ── me ──

  /** GET /admin/me/rice — the home screen's facts: role, home location, approvals waiting. */
  @Get("me/rice")
  async me(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.VIEW);
    return { storeId, userId: actor.userId, role: actor.role, homeLocationId: actor.homeLocationId, pendingApprovals: await this.people.countPending(storeId, actor.role) };
  }

  /** POST /admin/me/pin — change your own PIN (prove the current PIN, or your password if none yet). */
  @Post("me/pin")
  async changePin(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { actor } = await this.ctx(req, h, TENANT_ROLES.VIEW);
    return unwrap(await this.people.changeOwnPin(actor.userId, str(body?.current) ?? "", str(body?.newPin) ?? ""));
  }

  // ── people ──

  /** GET /admin/people — members with home location and PIN status. */
  @Get("people")
  async listPeople(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return { storeId, members: await this.people.listMembers(storeId) };
  }

  /** PATCH /admin/people/:userId — owner sets home location, PIN, or unlocks a locked PIN. */
  @Patch("people/:userId")
  async updatePerson(@Req() req: Req_, @Param("userId") userId: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.MANAGE);
    return unwrap(await this.people.updateMember(storeId, userId, {
      homeLocationId: optNullStr(body?.homeLocationId),
      pin: str(body?.pin),
      unlock: body?.unlock === true,
    }, actor.userId));
  }

  // ── kargadors ──

  /** GET /admin/kargadors — active kargadors (?all=1 includes inactive). Staff need it to pick who signs. */
  @Get("kargadors")
  async listKargadors(@Req() req: Req_, @Query("all") all?: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return { storeId, kargadors: await this.people.listKargadors(storeId, all === "1") };
  }

  /** POST /admin/kargadors — add a kargador (not a login account). */
  @Post("kargadors")
  async createKargador(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.OWNER_MANAGER);
    return unwrap(await this.people.saveKargador(storeId, null, {
      name: str(body?.name), phone: optNullStr(body?.phone), photoUrl: optNullStr(body?.photoUrl), homeLocationId: optNullStr(body?.homeLocationId),
    }, actor.userId));
  }

  /** PATCH /admin/kargadors/:id — rename, phone, photo, home location, on/off. */
  @Patch("kargadors/:id")
  async updateKargador(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.OWNER_MANAGER);
    return unwrap(await this.people.saveKargador(storeId, id, {
      name: str(body?.name), phone: optNullStr(body?.phone), photoUrl: optNullStr(body?.photoUrl), homeLocationId: optNullStr(body?.homeLocationId),
      isActive: typeof body?.isActive === "boolean" ? body.isActive : undefined,
    }, actor.userId));
  }

  // ── signatures ──

  /** POST /admin/signatures — add signatures to a step (when the step is finished on another phone). */
  @Post("signatures")
  async addSignatures(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    const documentType = str(body?.documentType) ?? "";
    const documentId = str(body?.documentId) ?? "";
    const step = str(body?.step) ?? "";
    if (!documentType || !documentId || !step) badRequest("documentType, documentId and step are required");
    return unwrap(await this.people.addSignatures(storeId, actor, { documentType, documentId, step, locationId: str(body?.locationId) ?? null }, signaturesFrom(body?.signatures)));
  }

  /** GET /admin/signatures?documentType=&documentId= — the signature trail of one document. */
  @Get("signatures")
  async listSignatures(@Req() req: Req_, @Query("documentType") documentType?: string, @Query("documentId") documentId?: string, @Headers("x-store-id") h?: string) {
    const { storeId } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    if (!documentType || !documentId) badRequest("documentType and documentId are required");
    return { storeId, signatures: await this.people.listSignatures(storeId, documentType, documentId) };
  }

  // ── approvals ("Para sa iyo") ──

  /** GET /admin/approvals?status=PENDING|APPROVED|DECLINED|ALL */
  @Get("approvals")
  async listApprovals(@Req() req: Req_, @Query("status") status?: string, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.OWNER_MANAGER);
    const s = (status ?? "PENDING").toUpperCase();
    if (!["PENDING", "APPROVED", "DECLINED", "CANCELLED", "ALL"].includes(s)) badRequest("unknown status");
    return { storeId, approvals: await this.people.listApprovals(storeId, s, actor.role) };
  }

  /** POST /admin/approvals/:id/decide — { decision: APPROVE|DECLINE, note, pin }. */
  @Post("approvals/:id/decide")
  async decide(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.OWNER_MANAGER);
    return unwrap(await this.people.decideApproval(storeId, id, actor, { decision: str(body?.decision), note: str(body?.note), pin: str(body?.pin) }));
  }

  // ── drafts ("Tapusin") ──

  @Get("drafts")
  async listDrafts(@Req() req: Req_, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return { storeId, drafts: await this.people.listDrafts(storeId, actor) };
  }

  @Post("drafts")
  async createDraft(@Req() req: Req_, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.people.saveDraft(storeId, actor, null, {
      flow: str(body?.flow), locationId: optNullStr(body?.locationId), step: typeof body?.step === "number" ? body.step : undefined, data: body?.data,
    }));
  }

  @Patch("drafts/:id")
  async updateDraft(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.people.saveDraft(storeId, actor, id, {
      step: typeof body?.step === "number" ? body.step : undefined, data: body?.data, version: typeof body?.version === "number" ? body.version : undefined,
    }));
  }

  @Post("drafts/:id/close")
  async closeDraft(@Req() req: Req_, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-store-id") h?: string) {
    const { storeId, actor } = await this.ctx(req, h, TENANT_ROLES.ADMIN);
    return unwrap(await this.people.closeDraft(storeId, actor, id, str(body?.status) ?? ""));
  }
}

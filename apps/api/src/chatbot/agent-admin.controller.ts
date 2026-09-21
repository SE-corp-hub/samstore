import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { ChatAgentService } from "./agent.service.js";

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

// P7b: agent dashboard — conversations, assignment, takeover, replies, canned replies, metrics.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class ChatAgentAdminController {
  private readonly agent = new ChatAgentService();

  /** GET /admin/chatbot/conversations?status= — list with last message + assignee. */
  @Get("chatbot/conversations")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Query("status") status?: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, conversations: await this.agent.list(storeId, status) };
  }

  /** GET /admin/chatbot/conversations/:id/messages — full thread. */
  @Get("chatbot/conversations/:id/messages")
  async thread(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { conversationId: id, messages: await this.agent.thread(storeId, id) };
  }

  /** POST /admin/chatbot/conversations/:id/assign — assign/unassign an agent. */
  @Post("chatbot/conversations/:id/assign")
  async assign(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: { agentId?: string | null }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.agent.assign(storeId, id, body?.agentId ?? null);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/chatbot/conversations/:id/takeover — agent takes over (bot paused). */
  @Post("chatbot/conversations/:id/takeover")
  async takeover(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.agent.takeover(storeId, id, user.sub);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/chatbot/conversations/:id/resolve. */
  @Post("chatbot/conversations/:id/resolve")
  async resolve(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.agent.resolve(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** POST /admin/chatbot/conversations/:id/reply — agent reply (mode → AGENT, unread reset). */
  @Post("chatbot/conversations/:id/reply")
  async reply(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: { text: string }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.agent.reply(storeId, id, user.sub, body?.text ?? "");
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/chatbot/canned-replies. */
  @Get("chatbot/canned-replies")
  async listCanned(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, replies: await this.agent.listCanned(storeId) };
  }

  /** POST /admin/chatbot/canned-replies — create. */
  @Post("chatbot/canned-replies")
  async createCanned(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: { label: string; body: string }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.agent.upsertCanned(storeId, null, body?.label ?? "", body?.body ?? "");
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** PATCH /admin/chatbot/canned-replies/:id — update. */
  @Patch("chatbot/canned-replies/:id")
  async updateCanned(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Body() body: { label: string; body: string }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.agent.upsertCanned(storeId, id, body?.label ?? "", body?.body ?? "");
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** DELETE /admin/chatbot/canned-replies/:id. */
  @Delete("chatbot/canned-replies/:id")
  async deleteCanned(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.ADMIN);
    const result = await this.agent.deleteCanned(storeId, id);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }

  /** GET /admin/chatbot/metrics — per-agent response-time + counts. */
  @Get("chatbot/metrics")
  async metrics(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    return { storeId, metrics: await this.agent.metrics(storeId) };
  }
}
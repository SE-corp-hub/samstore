import { Body, Controller, Headers, HttpException, HttpStatus, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { requireUser, resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { ChatbotService } from "./chatbot.service.js";

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

// P7: chatbot — a customer message entry (test/compose point; the production entry is
// the Messenger webhook, PENDING_CREDENTIALS). Tenant-scoped for now.

@Controller("admin")
@UseGuards(JwtAuthGuard)
export class ChatbotAdminController {
  private readonly chatbot = new ChatbotService();

  /** POST /admin/chatbot/message — send a customer message through the chatbot. */
  @Post("chatbot/message")
  async message(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { psid?: string | null; customerId?: string | null; text: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    requireUser(user);
    const { storeId } = await resolveTenant(user, headerStoreId, TENANT_ROLES.VIEW);
    const result = await this.chatbot.handleCustomerMessage(storeId, { psid: body?.psid ?? null, customerId: body?.customerId ?? null }, body?.text ?? "");
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return result.value;
  }
}
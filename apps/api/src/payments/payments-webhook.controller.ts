// Public payment-gateway webhooks (Phase 4). Signature-verified per gateway;
// idempotent — a replayed event is acknowledged but not re-applied.
// Production should route the RAW body to the verifier; for sandbox/mock the
// constant signature applies, so serialization is harmless here.

import { Controller, Post, Body, Req, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { PAYMENTS_SERVICE, PaymentsService } from "./payments.service.js";
import type { ApiError } from "@sam-store/contracts";

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

@Controller("webhooks")
export class PaymentsWebhookController {
  constructor(@Inject(PAYMENTS_SERVICE) private readonly payments: PaymentsService) {}

  /** POST /webhooks/paymongo — PayMongo payment.paid / payment.failed events. */
  @Post("paymongo")
  async paymongo(@Req() req: Request, @Body() body: unknown) {
    const headers = (req.headers ?? {}) as unknown as Record<string, string | undefined>;
    const signature = headers["x-paymongo-signature"] ?? headers["X-Paymongo-Signature"];
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(body ?? {});
    const result = await this.payments.handleGatewayWebhook("paymongo", rawBody, signature, body);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { received: true, processed: result.value.processed };
  }
}
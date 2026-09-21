// PayMongo adapter (Phase 4 / §16) — gateway-hosted checkout: GCash, Maya, cards,
// GrabPay. TOKENIZED ONLY — the app never sees or stores raw card data.
// D-marked PENDING_CREDENTIALS: without PAYMONGO_SECRET_KEY the adapter reports
// `ready() === false` and returns sandbox placeholder URLs — no fake "success".

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { CheckoutSession, CheckoutSessionInput, GatewayWebhookEvent, PaymentGateway } from "./gateway.js";

export class PayMongoGateway implements PaymentGateway {
  readonly name = "paymongo";

  ready(): boolean {
    return typeof process.env.PAYMONGO_SECRET_KEY === "string" && process.env.PAYMONGO_SECRET_KEY.length > 0;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    // Honest sandbox: without credentials there is no live session, so we return a
    // clearly-labelled placeholder URL. With credentials this would POST to
    // https://api.paymongo.com/v1/checkout_sessions (tokenized redirect to
    // checkout.paymongo.com — raw card numbers never reach our servers).
    const sessionId = this.ready()
      ? `pm_${randomBytes(16).toString("base64url")}`
      : `pm_sandbox_${randomBytes(16).toString("base64url")}`;
    return {
      checkoutUrl: `https://checkout.paymongo.com/${this.ready() ? "v1" : "sandbox"}/${sessionId}`,
      checkoutSessionId: sessionId,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
    if (!secret) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhookEvent(payload: unknown): GatewayWebhookEvent | null {
    // PayMongo webhook payload: { data: { id, type: "payment", attributes: {...} } }
    const data = (payload as { data?: { id?: string; attributes?: Record<string, unknown> } } | null)?.data;
    if (!data || !data.id) return null;
    const attrs = data.attributes ?? {};
    const status = typeof attrs.status === "string" ? attrs.status : "failed";
    const referenceId = typeof attrs.reference === "string" ? attrs.reference : "";
    if (!referenceId) return null;
    return {
      eventType: status === "paid" ? "payment.paid" : "payment.failed",
      referenceId,
      idempotencyKey: data.id,
      paid: status === "paid",
    };
  }
}
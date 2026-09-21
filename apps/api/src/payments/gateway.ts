// Payment gateway abstraction (Phase 4 / §16).
// NO raw card data ever touches the app — gateway-hosted checkout only (tokenized).
// Real providers are D-marked PENDING_CREDENTIALS until the operator supplies keys;
// the mock powers tests and demos. Honest status everywhere (AGENTS.md).

import { randomBytes } from "node:crypto";

export interface CheckoutSessionInput {
  amountMinor: number;
  currency: string;
  /** Our idempotency key — replaying a webhook with the same key never double-charges. */
  idempotencyKey: string;
  /** Our order id (or payment-link id) embedded in the session. */
  referenceId: string;
  description?: string;
}

export interface CheckoutSession {
  checkoutUrl: string;
  checkoutSessionId: string;
}

export interface GatewayWebhookEvent {
  /** "payment.paid" | "payment.failed" */
  eventType: string;
  referenceId: string;
  idempotencyKey: string;
  paid: boolean;
}

export interface PaymentGateway {
  readonly name: string;
  /** Credentials present → ready for live traffic? (honest status) */
  ready(): boolean;
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean;
  parseWebhookEvent(payload: unknown): GatewayWebhookEvent | null;
}

/** Deterministic in-memory gateway for tests/demos — records sessions, never the network. */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = "mock";
  private readonly sessions: { sessionId: string; input: CheckoutSessionInput }[] = [];

  ready(): boolean {
    return true;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const sessionId = `mock_sess_${randomBytes(8).toString("base64url")}`;
    this.sessions.push({ sessionId, input });
    return { checkoutUrl: `https://checkout.mock.test/${sessionId}`, checkoutSessionId: sessionId };
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    return signature === "test-sig";
  }

  parseWebhookEvent(payload: unknown): GatewayWebhookEvent | null {
    const p = payload as { event?: string; referenceId?: string; idempotencyKey?: string; status?: string } | null;
    if (!p || typeof p.referenceId !== "string" || typeof p.idempotencyKey !== "string") return null;
    return {
      eventType: p.event ?? (p.status === "paid" ? "payment.paid" : "payment.failed"),
      referenceId: p.referenceId,
      idempotencyKey: p.idempotencyKey,
      paid: (p.status ?? "paid") === "paid",
    };
  }

  sessionsForTests(): { sessionId: string; input: CheckoutSessionInput }[] {
    return [...this.sessions];
  }
}

const registry: Record<string, () => PaymentGateway> = {
  mock: () => new MockPaymentGateway(),
  paymongo: () => new (require("./paymongo.adapter.js").PayMongoGateway)(),
};

export function getGateway(name: string): PaymentGateway {
  const factory = registry[name];
  if (!factory) throw new Error(`Unknown payment gateway: ${name}`);
  return factory();
}
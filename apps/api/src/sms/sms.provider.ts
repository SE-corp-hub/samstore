// Rice Ops M6 — SMS providers behind one interface.
//
//   mock       (default) records the text as sent by "mock" — no network call. Used
//              until the operator approves a live SMS account (AGENTS.md: no live
//              provider calls before approval).
//   semaphore  Semaphore (PH). Only when SMS_PROVIDER=semaphore AND SEMAPHORE_API_KEY
//              are set on the server. The key is read from the environment, never
//              stored, logged or sent anywhere but Semaphore.

export interface SmsSendResult {
  providerMessageId: string | null;
}

export interface SmsProvider {
  readonly name: string;
  /** Throws on failure (the caller records the error and retries). */
  send(toE164: string, text: string, senderName?: string | null): Promise<SmsSendResult>;
}

export class MockSmsProvider implements SmsProvider {
  readonly name = "mock";
  readonly sent: { to: string; text: string }[] = [];
  async send(toE164: string, text: string): Promise<SmsSendResult> {
    this.sent.push({ to: toE164, text });
    return { providerMessageId: `mock-${Date.now().toString(36)}-${this.sent.length}` };
  }
}

/** Semaphore (https://semaphore.co) — POST /api/v4/messages. Not enabled unless configured. */
export class SemaphoreSmsProvider implements SmsProvider {
  readonly name = "semaphore";
  constructor(private readonly apiKey: string, private readonly defaultSender: string | null = null) {}

  async send(toE164: string, text: string, senderName?: string | null): Promise<SmsSendResult> {
    const body = new URLSearchParams({ apikey: this.apiKey, number: toE164.replace(/^\+/, ""), message: text });
    const sender = senderName ?? this.defaultSender;
    if (sender) body.set("sendername", sender);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", body, signal: ctrl.signal });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Semaphore HTTP ${res.status}`);
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("Semaphore: unexpected reply");
      }
      const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
      if (!first || typeof first.message_id === "undefined") throw new Error("Semaphore: message not accepted");
      if (typeof first.status === "string" && /fail|refund/i.test(first.status)) throw new Error(`Semaphore: ${first.status}`);
      return { providerMessageId: String(first.message_id) };
    } finally {
      clearTimeout(timer);
    }
  }
}

let override: SmsProvider | null = null;
let fromEnv: SmsProvider | null = null;

/** The provider the server uses: Semaphore only when explicitly configured, else mock. */
export function smsProvider(): SmsProvider {
  if (override) return override;
  if (!fromEnv) {
    const key = process.env.SEMAPHORE_API_KEY?.trim();
    fromEnv = process.env.SMS_PROVIDER === "semaphore" && key ? new SemaphoreSmsProvider(key, process.env.SMS_SENDER_NAME?.trim() || null) : new MockSmsProvider();
  }
  return fromEnv;
}

/** Tests (and only tests) swap the provider. */
export function setSmsProviderForTests(p: SmsProvider | null): void {
  override = p;
}

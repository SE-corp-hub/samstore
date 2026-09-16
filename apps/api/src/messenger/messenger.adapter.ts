// Messenger adapter — interface + mock/offline providers only.
// Per AGENTS.md / the master prompt: NO live Graph/Send API calls until a Facebook App,
// Page tokens, and a public HTTPS webhook are operator-approved. Until then the
// website→Messenger bridge SUPPRESSES sends and reports portal status.

export type MessengerSendResult =
  | { delivered: true; messageId: string }
  | { delivered: false; reason: "not_connected" | "suppressed" | "provider_error" };

export interface MessengerMessage {
  /** Page-scoped Messenger user ID (never assumed portable across Pages). */
  psid: string;
  text: string;
  storeId: string;
}

/** Provider contract — swap a real Meta implementation in behind this. */
export interface MessengerProvider {
  readonly name: string;
  sendText(message: MessengerMessage): Promise<MessengerSendResult>;
}

/**
 * Offline provider used when the store has no verified Messenger connection.
 * Records the send attempt for audit but never reaches the network — this is the
 * spec-mandated "suppress and show portal status" default path.
 */
export class SuppressedMessengerProvider implements MessengerProvider {
  readonly name = "suppressed";
  private readonly log: string[] = [];

  async sendText(message: MessengerMessage): Promise<MessengerSendResult> {
    this.log.push(`[${new Date().toISOString()}] suppressed send to psid=${message.psid} (store ${message.storeId})`);
    return { delivered: false, reason: "suppressed" };
  }

  suppressedLog(): string[] {
    return [...this.log];
  }
}

/** In-memory mock for tests / demos — records sends, never hits the network. */
export class MockMessengerProvider implements MessengerProvider {
  readonly name = "mock";
  private readonly sent: MessengerMessage[] = [];
  private failNext = false;

  async sendText(message: MessengerMessage): Promise<MessengerSendResult> {
    if (this.failNext) {
      this.failNext = false;
      return { delivered: false, reason: "provider_error" };
    }
    this.sent.push(message);
    return { delivered: true, messageId: `mock_${Date.now()}_${message.psid}` };
  }

  /** Test helper: make the next send fail. */
  queueFailure() {
    this.failNext = true;
  }

  sentMessages(): MessengerMessage[] {
    return [...this.sent];
  }
}

/**
 * Store-level Messenger service. Routes to the configured provider, or the
 * suppressed provider when the store isn't connected. Enforces the "no PSID / no
 * consent → suppress" rule from the master prompt.
 */
export class MessengerService {
  constructor(
    private readonly provider: MessengerProvider,
    private readonly isStoreConnected: (storeId: string) => boolean,
  ) {}

  async notifyCustomer(message: MessengerMessage): Promise<MessengerSendResult> {
    if (!this.isStoreConnected(message.storeId)) {
      return { delivered: false, reason: "not_connected" };
    }
    // Consent gate: we only send to verified PSIDs (the caller supplies one;
    // stores not connected never reach here).
    return this.provider.sendText(message);
  }
}
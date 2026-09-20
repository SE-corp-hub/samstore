// Website→Messenger bridge — portal status + suppress-send default.
// Per AGENTS.md / the master prompt: NO live Graph/Send API calls until a Facebook
// App, Page tokens, and a public HTTPS webhook are operator-approved. Until then every
// bridge send is SUPPRESSED and the storefront + admin portals show honest status.
// "Never guess a token": an opt-in without a caller-supplied PSID is recorded as
// not_connected and NEVER fabricated.

import { prisma } from "../persistence/prisma-repositories.js";
import {
  MessengerService,
  SuppressedMessengerProvider,
  type MessengerProvider,
  type MessengerSendResult,
} from "./messenger.adapter.js";

export interface MessengerBridgeStatus {
  connected: boolean;
  pageId: string | null;
  /** "suppressed" | "mock" — never "live" until an operator approves a real provider. */
  provider: string;
  suppressed: boolean;
}

export class MessengerBridgeService {
  constructor(private readonly provider: MessengerProvider = new SuppressedMessengerProvider()) {}

  /** Portal status — reads the store's recorded connection intent. */
  async status(storeId: string): Promise<MessengerBridgeStatus> {
    const settings = await prisma.storeSettings.findUnique({ where: { storeId } });
    return {
      connected: settings?.messengerConnected ?? false,
      pageId: settings?.messengerPageId ?? null,
      provider: this.provider.name,
      suppressed: this.provider.name === "suppressed",
    };
  }

  /**
   * Record a website→Messenger opt-in intent. Without a caller-supplied PSID this is
   * NOT a delivery — it is logged as not_connected (never guessed). With a PSID the
   * message still routes through the provider, which defaults to suppressed.
   */
  async bridgeOptIn(
    storeId: string,
    opts: { psid?: string; text?: string } = {},
  ): Promise<{ ok: true; value: { status: MessengerBridgeStatus; result: MessengerSendResult } } | { ok: false; error: { type: string; message: string } }> {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };
    const status = await this.status(storeId);
    const text = opts.text?.trim() ?? "You're connected to updates from this store — we'll message you here.";

    if (!opts.psid) {
      // Never guess a token: no caller-supplied PSID → suppress + record the intent.
      await prisma.notificationLog.create({
        data: { storeId, template: "messenger.bridge.optin", channel: "messenger", recipient: null, text, delivered: false },
      });
      return {
        ok: true,
        value: { status, result: { delivered: false, reason: status.connected ? "suppressed" : "not_connected" } },
      };
    }

    const svc = new MessengerService(this.provider, (id) => id === storeId && status.connected);
    const result = await svc.notifyCustomer({ psid: opts.psid, text, storeId });
    await prisma.notificationLog.create({
      data: { storeId, template: "messenger.bridge.optin", channel: "messenger", recipient: opts.psid, text, delivered: result.delivered },
    });
    return { ok: true, value: { status, result } };
  }
}
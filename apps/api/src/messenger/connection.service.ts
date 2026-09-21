// P6a: Messenger connection + messenger-user identity mapping.
// Only token HASHES are stored (sha256) — never the page token or webhook verify
// token in plaintext. Live Graph/Send calls stay gated behind operator-approved
// credentials; the admin records the Page config as intent (honest PENDING_CREDENTIALS).

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type MessengerResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class MessengerConnectionService {
  /** Portal status: recorded page config + whether sends are suppressed (they are, until approved). */
  async getConnection(storeId: string) {
    const settings = await prisma.storeSettings.findUnique({ where: { storeId } });
    const page = await prisma.messengerPage.findUnique({ where: { storeId } });
    return {
      connected: settings?.messengerConnected ?? false,
      pageId: page?.pageId ?? settings?.messengerPageId ?? null,
      pageName: page?.pageName ?? null,
      connectedAt: page?.connectedAt.toISOString() ?? null,
      webhookTokenConfigured: page?.webhookVerifyTokenHash != null,
      // Honest: no live provider is ever engaged from this codebase without approval.
      provider: "suppressed",
      suppressed: true,
    };
  }

  /** Record a Messenger Page connection. Token is hashed; never stored or returned. */
  async connect(storeId: string, input: { pageId: string; pageName: string; accessToken: string }): Promise<MessengerResult<{ connected: boolean; pageId: string }>> {
    const pageId = input.pageId?.trim();
    const pageName = input.pageName?.trim();
    const accessToken = input.accessToken?.trim();
    if (!pageId || pageId.length > 64) return { ok: false, error: { type: "validation", errors: ["pageId is required (max 64)"] } };
    if (!pageName || pageName.length > 80) return { ok: false, error: { type: "validation", errors: ["pageName is required (max 80)"] } };
    if (!accessToken || accessToken.length < 16) return { ok: false, error: { type: "validation", errors: ["accessToken is required (min 16 chars)"] } };

    const accessTokenHash = hashSecret(accessToken);
    await prisma.$transaction(async (tx) => {
      await tx.messengerPage.upsert({
        where: { storeId },
        update: { pageId, pageName, accessTokenHash },
        create: { storeId, pageId, pageName, accessTokenHash },
      });
      await tx.storeSettings.upsert({
        where: { storeId },
        update: { messengerConnected: true, messengerPageId: pageId },
        create: { storeId, messengerConnected: true, messengerPageId: pageId },
      });
    });
    return { ok: true, value: { connected: true, pageId } };
  }

  /** Disconnect the Page: clears the recorded config and the connected flag. */
  async disconnect(storeId: string): Promise<MessengerResult<{ connected: boolean }>> {
    await prisma.$transaction(async (tx) => {
      await tx.messengerPage.deleteMany({ where: { storeId } });
      await tx.storeSettings.upsert({
        where: { storeId },
        update: { messengerConnected: false, messengerPageId: null },
        create: { storeId, messengerConnected: false, messengerPageId: null },
      });
    });
    return { ok: true, value: { connected: false } };
  }

  /** Rotate the webhook verify token — returns the plaintext ONCE (only the hash is stored). */
  async rotateWebhookToken(storeId: string): Promise<MessengerResult<{ webhookVerifyToken: string }>> {
    const page = await prisma.messengerPage.findUnique({ where: { storeId } });
    if (!page) return { ok: false, error: { type: "not_found", message: "No Messenger page connected" } };
    const token = randomBytes(24).toString("base64url");
    await prisma.messengerPage.update({ where: { id: page.id }, data: { webhookVerifyTokenHash: hashSecret(token) } });
    return { ok: true, value: { webhookVerifyToken: token } };
  }

  /** Link a Messenger PSID to a customer (identity mapping for the journey). */
  async mapUser(storeId: string, psid: string, customerId: string | null, optedIn = true): Promise<MessengerResult<{ id: string; psid: string }>> {
    const clean = psid?.trim();
    if (!clean || clean.length > 200) return { ok: false, error: { type: "validation", errors: ["psid is required"] } };
    if (customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: customerId } });
      if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    }
    const user = await prisma.messengerUser.upsert({
      where: { storeId_psid: { storeId, psid: clean } },
      update: { customerId: customerId ?? undefined, optedIn, lastSeenAt: new Date() },
      create: { storeId, psid: clean, customerId: customerId ?? undefined, optedIn, lastSeenAt: new Date() },
    });
    return { ok: true, value: { id: user.id, psid: user.psid } };
  }

  async listUsers(storeId: string) {
    return prisma.messengerUser.findMany({
      where: { storeId },
      orderBy: { lastSeenAt: "desc" },
      take: 200,
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
  }

  /** Deep link for the storefront: https://m.me/<pageId>?ref=<slug> (messenger.com ref deep-link). */
  async deepLink(storeId: string, storeSlug: string): Promise<MessengerResult<{ deepLink: string; ref: string }>> {
    const page = await prisma.messengerPage.findUnique({ where: { storeId } });
    if (!page) return { ok: false, error: { type: "conflict", message: "No Messenger page connected" } };
    const ref = storeSlug.trim();
    return { ok: true, value: { deepLink: `https://m.me/${page.pageId}?ref=${encodeURIComponent(ref)}`, ref } };
  }
}
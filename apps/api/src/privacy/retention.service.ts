import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type RetentionResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export class PrivacyRetentionService {
  async policy(storeId: string) {
    const settings = await prisma.storeSettings.findUnique({ where: { storeId }, select: { privacyRetentionDays: true } });
    return { retentionDays: settings?.privacyRetentionDays ?? 0, enabled: (settings?.privacyRetentionDays ?? 0) > 0 };
  }

  async preview(storeId: string): Promise<RetentionResult<{ retentionDays: number; cutoff: string | null; conversations: number; messages: number }>> {
    const policy = await this.policy(storeId);
    if (!policy.enabled) return { ok: true, value: { retentionDays: 0, cutoff: null, conversations: 0, messages: 0 } };
    const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000);
    const conversations = await prisma.conversation.count({ where: { storeId, lastActivityAt: { lt: cutoff } } });
    const messages = await prisma.message.count({ where: { storeId, createdAt: { lt: cutoff } } });
    return { ok: true, value: { retentionDays: policy.retentionDays, cutoff: cutoff.toISOString(), conversations, messages } };
  }

  /** Explicit operator-triggered purge. ConsentRecord rows are intentionally retained. */
  async purge(storeId: string, actorId: string): Promise<RetentionResult<{ deletedConversations: number; deletedMessages: number; cutoff: string }>> {
    const policy = await this.policy(storeId);
    if (!policy.enabled) return { ok: false, error: { type: "conflict", message: "Privacy retention is disabled (retentionDays is 0)" } };
    const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000);
    const oldConversations = await prisma.conversation.findMany({ where: { storeId, lastActivityAt: { lt: cutoff } }, select: { id: true } });
    const ids = oldConversations.map((x) => x.id);
    const oldMessages = await prisma.message.count({ where: { storeId, createdAt: { lt: cutoff } } });
    await prisma.$transaction(async (tx) => {
      if (ids.length) await tx.conversation.deleteMany({ where: { storeId, id: { in: ids } } });
      await tx.message.deleteMany({ where: { storeId, createdAt: { lt: cutoff } } });
      await tx.auditLog.create({
        data: {
          storeId,
          actorType: "store_owner",
          actorId,
          action: "privacy.retention.purge",
          entityType: "Conversation",
          entityId: storeId,
          after: { cutoff: cutoff.toISOString(), deletedConversations: ids.length, deletedMessages: oldMessages },
        },
      });
    });
    return { ok: true, value: { deletedConversations: ids.length, deletedMessages: oldMessages, cutoff: cutoff.toISOString() } };
  }
}

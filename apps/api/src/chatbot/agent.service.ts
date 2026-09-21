// P7b: agent dashboard operations — conversations, assignment, takeover, replies,
// canned replies, metrics. Tenant-scoped; every agent action is audited via Message
// rows (sender "agent") and bumps lastActivityAt.

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const CANNED_DEFAULTS = [
  { label: "Greeting", body: "Hi! Thanks for messaging. How can we help you today?" },
  { label: "Order tracking", body: "Paste your order token and we'll check the status for you." },
  { label: "We'll check", body: "We'll look into that and reply shortly." },
  { label: "Store hours", body: "We're open Monday to Saturday, 7am to 7pm." },
];

export class ChatAgentService {
  /** List conversations (filter by status), with last message + assignee + unread. */
  async list(storeId: string, status?: string) {
    await this.seedCanned(storeId);
    return prisma.conversation.findMany({
      where: { storeId, ...(status ? { status } : {}) },
      orderBy: { lastActivityAt: "desc" },
      take: 200,
      include: {
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        assignedAgent: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async thread(storeId: string, conversationId: string) {
    return prisma.message.findMany({
      where: { conversationId, storeId },
      orderBy: { createdAt: "asc" },
    });
  }

  /** Assign (or unassign) an agent to a conversation. */
  async assign(storeId: string, conversationId: string, agentId: string | null): Promise<AgentResult<{ id: string; assignedAgentId: string | null }>> {
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, storeId } });
    if (!conv) return { ok: false, error: { type: "not_found", message: "Conversation not found" } };
    if (agentId) {
      const agent = await prisma.user.findUnique({ where: { id: agentId } });
      if (!agent) return { ok: false, error: { type: "not_found", message: "Agent not found" } };
    }
    await prisma.conversation.update({ where: { id: conversationId }, data: { assignedAgentId: agentId ?? null } });
    return { ok: true, value: { id: conversationId, assignedAgentId: agentId ?? null } };
  }

  /** Take over the conversation (bot paused → AGENT mode). */
  async takeover(storeId: string, conversationId: string, agentId: string | null): Promise<AgentResult<{ id: string; mode: string }>> {
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, storeId } });
    if (!conv) return { ok: false, error: { type: "not_found", message: "Conversation not found" } };
    await prisma.conversation.update({ where: { id: conversationId }, data: { mode: "AGENT", ...(agentId ? { assignedAgentId: agentId } : {}) } });
    return { ok: true, value: { id: conversationId, mode: "AGENT" } };
  }

  /** Resolve a conversation. */
  async resolve(storeId: string, conversationId: string): Promise<AgentResult<{ id: string; status: string }>> {
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, storeId } });
    if (!conv) return { ok: false, error: { type: "not_found", message: "Conversation not found" } };
    await prisma.conversation.update({ where: { id: conversationId }, data: { status: "RESOLVED", unreadCount: 0 } });
    return { ok: true, value: { id: conversationId, status: "RESOLVED" } };
  }

  /** Agent reply: appends a message, flips mode to AGENT, resets unread. */
  async reply(storeId: string, conversationId: string, agentId: string, text: string): Promise<AgentResult<{ id: string }>> {
    const body = text?.trim() ?? "";
    if (!body) return { ok: false, error: { type: "validation", errors: ["reply text is required"] } };
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, storeId } });
    if (!conv) return { ok: false, error: { type: "not_found", message: "Conversation not found" } };
    if (conv.status === "RESOLVED") return { ok: false, error: { type: "conflict", message: "Conversation is resolved" } };
    await prisma.$transaction(async (tx) => {
      await tx.message.create({ data: { storeId, conversationId, sender: "agent", senderId: agentId, body } });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { mode: "AGENT", unreadCount: 0, lastActivityAt: new Date(), status: conv.status === "AGENT" ? "AGENT" : "OPEN" },
      });
    });
    return { ok: true, value: { id: conversationId } };
  }

  // ─────────────────────────────── Canned replies ───────────────────────────────

  private async seedCanned(storeId: string) {
    const existing = await prisma.cannedReply.count({ where: { storeId } });
    if (existing > 0) return;
    await prisma.cannedReply.createMany({
      data: CANNED_DEFAULTS.map((c, i) => ({ storeId, label: c.label, body: c.body, sortOrder: i })),
    });
  }

  async listCanned(storeId: string) {
    await this.seedCanned(storeId);
    return prisma.cannedReply.findMany({ where: { storeId }, orderBy: { sortOrder: "asc" } });
  }

  async upsertCanned(storeId: string, id: string | null, label: string, body: string): Promise<AgentResult<{ id: string }>> {
    const l = label?.trim();
    const b = body?.trim();
    if (!l || l.length > 40) return { ok: false, error: { type: "validation", errors: ["label is required (max 40)"] } };
    if (!b || b.length > 500) return { ok: false, error: { type: "validation", errors: ["body is required (max 500)"] } };
    if (id) {
      const existing = await prisma.cannedReply.findFirst({ where: { id, storeId } });
      if (!existing) return { ok: false, error: { type: "not_found", message: "Canned reply not found" } };
      await prisma.cannedReply.update({ where: { id }, data: { label: l, body: b } });
      return { ok: true, value: { id } };
    }
    const created = await prisma.cannedReply.create({ data: { storeId, label: l, body: b, sortOrder: 0 } });
    return { ok: true, value: { id: created.id } };
  }

  async deleteCanned(storeId: string, id: string): Promise<AgentResult<{ ok: true }>> {
    const existing = await prisma.cannedReply.findFirst({ where: { id, storeId } });
    if (!existing) return { ok: false, error: { type: "not_found", message: "Canned reply not found" } };
    await prisma.cannedReply.delete({ where: { id } });
    return { ok: true, value: { ok: true } };
  }

  /** Per-agent metrics: open/handled counts + avg first-response time (minutes). */
  async metrics(storeId: string) {
    const conversations = await prisma.conversation.findMany({ where: { storeId }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    const byAgent = new Map<string, { open: number; handled: number; totalMs: number; replies: number }>();
    let openUnassigned = 0;
    for (const c of conversations) {
      const agentId = c.assignedAgentId;
      if (c.status === "OPEN" || c.status === "AGENT") {
        if (agentId) {
          const m = byAgent.get(agentId) ?? { open: 0, handled: 0, totalMs: 0, replies: 0 };
          m.open += 1;
          byAgent.set(agentId, m);
        } else {
          openUnassigned += 1;
        }
      }
      if (c.status === "RESOLVED" && agentId) {
        const m = byAgent.get(agentId) ?? { open: 0, handled: 0, totalMs: 0, replies: 0 };
        m.handled += 1;
        byAgent.set(agentId, m);
      }
      // First-response: first AGENT message after a customer message.
      const customerAt = c.messages.find((m) => m.sender === "customer")?.createdAt;
      const firstAgent = c.messages.find((m) => m.sender === "agent");
      if (customerAt && firstAgent) {
        const agentId2 = c.assignedAgentId;
        if (agentId2) {
          const m = byAgent.get(agentId2)!;
          m.totalMs += Math.max(0, firstAgent.createdAt.getTime() - customerAt.getTime());
          m.replies += 1;
        }
      }
    }
    const agentIds = [...byAgent.keys()];
    const agents = agentIds.length
      ? await prisma.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, email: true } })
      : [];
    return {
      openUnassigned,
      agents: agents.map((a) => {
        const m = byAgent.get(a.id)!;
        return {
          id: a.id,
          name: a.name ?? a.email,
          open: m.open,
          handled: m.handled,
          avgFirstResponseMinutes: m.replies > 0 ? Math.round(m.totalMs / m.replies / 60_000) : null,
        };
      }),
    };
  }
}
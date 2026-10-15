// P7: chatbot service — wires the pure engine to live catalog/order data, keeps a
// Conversation + Message audit trail, and on fallback bumps unread + flags AGENT
// (handoff: "I'll ask our staff"). Live-data-only, honest.

import { prisma } from "../persistence/prisma-repositories.js";
import { claimSecret } from "../security/secrets.js";
import { verifyClaimToken, InvalidClaimTokenError } from "../domain/claim-token.js";
import {
  classify,
  answer,
  answerProducts,
  isFallback,
  FALLBACK_REPLY,
  type ChatContext,
  type ChatIntent,
} from "./engine.js";
import type { ApiError } from "@sam-store/contracts";

const CLAIM_SECRET = claimSecret(); // M11: no committed fallback

export type ChatbotResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export class ChatbotService {
  /** Handle a customer message: append, classify, answer (live data) or fall back to an agent. */
  async handleCustomerMessage(
    storeId: string,
    contact: { psid?: string | null; customerId?: string | null },
    text: string,
  ): Promise<ChatbotResult<{ conversationId: string; intent: ChatIntent; confidence: number; reply: string; handedOff: boolean }>> {
    const body = text?.trim() ?? "";
    if (!body) return { ok: false, error: { type: "validation", errors: ["message text is required"] } };
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };

    const psid = contact.psid ?? null;
    const customerId = contact.customerId ?? null;
    let conversation;
    if (psid) {
      conversation = await prisma.conversation.upsert({
        where: { storeId_contactPsid: { storeId, contactPsid: psid } },
        update: {},
        create: { storeId, contactPsid: psid, customerId, channel: "messenger" },
      });
    } else {
      conversation = await prisma.conversation.findFirst({
        where: { storeId, customerId, status: { in: ["OPEN", "AGENT"] } },
        orderBy: { lastActivityAt: "desc" },
      });
      if (!conversation) {
        conversation = await prisma.conversation.create({ data: { storeId, customerId, channel: "web" } });
      }
    }

    const classified = classify(body);
    const ctx = await this.buildContext(store.id, store.name);
    let reply: string;
    let handedOff = false;
    if (isFallback(classified)) {
      reply = FALLBACK_REPLY;
      handedOff = true;
    } else if (classified.intent === "product_search") {
      const found = answerProducts(body, ctx);
      if (found === null) {
        reply = FALLBACK_REPLY;
        handedOff = true;
      } else {
        reply = found;
      }
    } else {
      const a = await answer(classified, ctx);
      reply = a?.reply ?? FALLBACK_REPLY;
      handedOff = a === null;
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: { storeId, conversationId: conversation.id, sender: "customer", senderId: psid, body, createdAt: now },
      });
      await tx.message.create({
        data: {
          storeId,
          conversationId: conversation.id,
          sender: "bot",
          senderId: "bot",
          body: reply,
          intent: classified.intent,
          confidence: classified.confidence,
          createdAt: now,
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastActivityAt: now,
          status: handedOff ? "AGENT" : conversation.status,
          ...(handedOff ? { unreadCount: { increment: 1 } } : {}),
          ...(psid ? { title: body.slice(0, 40) } : {}),
        },
      });
    });
    return {
      ok: true,
      value: { conversationId: conversation.id, intent: classified.intent, confidence: classified.confidence, reply, handedOff },
    };
  }

  private async buildContext(storeId: string, storeName: string): Promise<ChatContext> {
    const categories = await prisma.category.findMany({ where: { storeId, isActive: true }, orderBy: { sortOrder: "asc" } });
    const products = await prisma.product.findMany({
      where: { storeId, isActive: true },
      include: { images: true, stockLevels: true, category: { select: { name: true } } },
      take: 200,
    });
    return {
      storeName,
      storeHours: null,
      categories: categories.map((c) => c.name),
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        priceMinor: p.priceMinor,
        availableQuantity: p.stockLevels.reduce((s, l) => s + (l.quantityOnHand - l.quantityReserved), 0),
        description: p.description,
        categoryName: p.category?.name ?? null,
      })),
      loyaltyInfo: "1 point per ₱1 spent; 100 points = ₱1 off at checkout.",
      lookupOrder: async (token: string) => {
        try {
          const orderId = verifyClaimToken(token, CLAIM_SECRET);
          const order = await prisma.order.findUnique({
            where: { id: orderId, storeId },
            select: { orderNumber: true, status: true, totalMinor: true },
          });
          return order ? { orderNumber: order.orderNumber, status: order.status, totalMinor: order.totalMinor } : null;
        } catch (e) {
          if (e instanceof InvalidClaimTokenError) return null;
          throw e;
        }
      },
    };
  }
}
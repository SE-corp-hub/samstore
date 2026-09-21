// P6b: Messenger journey dispatch — wires the pure state machine to live catalog
// data + order lookup, and routes reply templates through the (suppressed/mock)
// provider. LIVE-DATA-ONLY: the engine never invents stock, price, or order status.
// No live Meta calls are ever made here.

import { prisma } from "../persistence/prisma-repositories.js";
import { verifyClaimToken, InvalidClaimTokenError } from "../domain/claim-token.js";
import { MessengerService, SuppressedMessengerProvider, type MessengerProvider } from "./messenger.adapter.js";
import { journeyTurn, startJourney, type JourneyContext, type JourneyOrderLookup, type JourneyState } from "./journey.js";
import { type ReplyTemplate } from "./templates.js";
import type { ApiError } from "@sam-store/contracts";

const CLAIM_SECRET = process.env.CLAIM_SIGNING_SECRET ?? "dev-only-in-memory-secret-0123456789";

export type JourneyDispatchResult = { ok: true; value: { sent: number; templates: ReplyTemplate[] } } | { ok: false; error: ApiError };

/** Flatten a reply template to a single message text for the (text-only) provider. */
export function flattenTemplate(t: ReplyTemplate): string {
  switch (t.type) {
    case "text": {
      const qr = t.quickReplies?.length ? `\n\n${t.quickReplies.map((r) => `[${r.title}]`).join(" · ")}` : "";
      return `${t.text}${qr}`;
    }
    case "button":
      return `${t.text}\n\n${t.buttons.map((b) => `[${b.title}]`).join(" · ")}`;
    case "carousel":
      return t.elements.map((e) => `• ${e.title} — ${e.subtitle}`).join("\n");
    case "image":
      return `📷 ${t.imageUrl}`;
  }
}

export class MessengerJourneyService {
  private readonly session = new Map<string, JourneyState>(); // in-memory session per psid

  constructor(private readonly provider: MessengerProvider = new SuppressedMessengerProvider()) {}

  async dispatch(storeId: string, psid: string, incoming: { text?: string; payload?: string }): Promise<JourneyDispatchResult> {
    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };

    // Live catalog data only.
    const products = await prisma.product.findMany({
      where: { storeId, isActive: true },
      include: { images: { orderBy: { sortOrder: "asc" } }, category: { select: { name: true } }, stockLevels: true },
      take: 200,
    });
    const categories = await prisma.category.findMany({ where: { storeId, isActive: true }, orderBy: { sortOrder: "asc" } });

    const ctx: JourneyContext = {
      storeName: store.name,
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        priceMinor: p.priceMinor,
        availableQuantity: p.stockLevels.reduce((s, l) => s + (l.quantityOnHand - l.quantityReserved), 0),
        categoryName: p.category?.name ?? null,
        images: p.images.map((i) => i.url),
      })),
      lookupOrder: async (claimToken: string): Promise<JourneyOrderLookup | null> => {
        try {
          const orderId = verifyClaimToken(claimToken, CLAIM_SECRET);
          const order = await prisma.order.findUnique({
            where: { id: orderId, storeId },
            select: { orderNumber: true, status: true, totalMinor: true, customerName: true },
          });
          if (!order) return null;
          return { orderNumber: order.orderNumber, status: order.status, totalMinor: order.totalMinor, customerName: order.customerName };
        } catch (e) {
          if (e instanceof InvalidClaimTokenError) return null;
          throw e;
        }
      },
    };

    // Session state (per psid) drives the machine.
    const key = `${storeId}:${psid}`;
    const state = this.session.get(key) ?? startJourney();
    const turn = await journeyTurn(state, incoming, ctx);
    this.session.set(key, turn.state);
    // Touch the identity mapping (upsert, mark lastSeenAt).
    await prisma.messengerUser.upsert({
      where: { storeId_psid: { storeId, psid } },
      update: { lastSeenAt: new Date(), optedIn: true },
      create: { storeId, psid, lastSeenAt: new Date(), optedIn: true },
    });

    // Route replies through the provider (suppressed/mock) + audit log.
    const messenger = new MessengerService(this.provider, () => true);
    let sent = 0;
    for (const template of turn.replies) {
      const text = flattenTemplate(template);
      const result = await messenger.notifyCustomer({ psid, text, storeId });
      void result; // suppressed/mock: delivery outcome recorded in the log row
      await prisma.notificationLog.create({
        data: { storeId, template: "messenger.journey", channel: "messenger", recipient: psid, text, delivered: result.delivered },
      });
      sent += 1;
    }
    return { ok: true, value: { sent, templates: turn.replies } };
  }
}
// P7: chatbot engine + service — live-data-only, Taglish, fallback→handoff, audit trail.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { classify, answer, answerProducts, isFallback, FALLBACK_REPLY, type ChatContext } from "./engine.js";
import { ChatbotService } from "./chatbot.service.js";

const run = `P7A${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE", settings: { create: {} } },
  });
  createdStoreIds.push(s.id);
  const cat = await prisma.category.create({ data: { storeId: s.id, name: "Drinks", slug: `drinks-${run}-${slugSeq}`, sortOrder: 0 } });
  const p = await prisma.product.create({ data: { storeId: s.id, sku: `${run}-p${slugSeq}`, name: "Kape Barako", priceMinor: 12000, categoryId: cat.id } });
  await prisma.stockLevel.create({ data: { storeId: s.id, productId: p.id, quantityOnHand: 5, quantityReserved: 0 } });
  return { store: s, product: p };
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      await prisma.message.deleteMany({ where: { storeId } });
      await prisma.conversation.deleteMany({ where: { storeId } });
      await prisma.stockLevel.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.category.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("classify detects Taglish intents with confidence", () => {
  assert.equal(classify("hello po").intent, "greeting");
  assert.equal(classify("ano meron kayo").intent, "menu");
  assert.equal(classify("saan na order ko").intent, "order_status");
  assert.equal(classify("anong oras kayo bukas").intent, "store_hours");
  assert.equal(classify("saan kayo located").intent, "store_info");
  assert.equal(classify("magkano points ko").intent, "loyalty");
  assert.equal(classify("meron ba voucher").intent, "voucher");
  // Unknown text is a plausible product query; the SERVICE hands off when nothing matches.
  assert.equal(classify("xyzzy nonsense plorble").intent, "product_search");
  const tok = classify("track my order token abcdefghijklmnop");
  assert.equal(tok.intent, "order_token");
  assert.equal(tok.token, "abcdefghijklmnop");
});

test("answers are LIVE-DATA-ONLY; unknown data is never invented", async () => {
  const ctx: ChatContext = {
    storeName: "Kape PH",
    categories: ["Drinks", "Pastries"],
    products: [{ id: "p1", name: "Kape Barako", priceMinor: 12000, availableQuantity: 10, description: "Strong coffee", categoryName: "Drinks" }],
    storeHours: "Mon–Sat 7am–7pm",
    loyaltyInfo: "1 pt per ₱1",
  };
  const menu = await answer({ intent: "menu", confidence: 0.9 }, ctx);
  assert.ok(menu?.reply.includes("Drinks"));

  const hours = await answer({ intent: "store_hours", confidence: 0.9 }, ctx);
  assert.ok(hours?.reply.includes("7am"));

  const order = await answer({ intent: "order_token", confidence: 0.95, token: "bad-token-123456789" }, { ...ctx, lookupOrder: async () => null });
  assert.match(order?.reply ?? "", /couldn't find/i, "unknown order is not invented");

  const details = answerProducts("kape", ctx);
  assert.ok(details);
  if (details) assert.ok(details.includes("₱120.00"));
  if (details) assert.ok(details.includes("10 in stock"));

  const missing = answerProducts("lechon", ctx);
  assert.equal(missing, null, "no match → hand off to an agent, never invented");
});

test("fallback hands off: conversation → AGENT, unread bumped, audit trail written", async () => {
  const { store } = await makeStore();
  const svc = new ChatbotService();

  const ok = await svc.handleCustomerMessage(store.id, { psid: "PSID-CHAT" }, "xyzzy nonsense plorble");
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.handedOff, true);
  assert.equal(ok.value.reply, FALLBACK_REPLY);
  assert.equal(ok.value.intent, "product_search", "a plausible query that matches nothing is handed off");

  const conv = await prisma.conversation.findUnique({ where: { id: ok.value.conversationId } });
  assert.equal(conv?.status, "AGENT", "awaiting an agent");
  assert.equal(conv?.unreadCount, 1);

  const msgs = await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
  assert.equal(msgs.length, 2, "customer + bot messages");
  assert.equal(msgs[0]?.sender, "customer");
  assert.equal(msgs[1]?.sender, "bot");
  assert.equal(msgs[1]?.intent, "product_search", "the detected intent is audited even on handoff");
  assert.ok(msgs[1]?.confidence !== undefined, "confidence audit trail");
});

test("a real product query is answered from live catalog with intent audit", async () => {
  const { store } = await makeStore();
  const svc = new ChatbotService();
  const ok = await svc.handleCustomerMessage(store.id, { psid: "PSID-CHAT2" }, "kape");
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.handedOff, false);
  assert.equal(ok.value.intent, "product_search");
  assert.ok(ok.value.reply.includes("Kape Barako"));
  assert.ok(ok.value.reply.includes("₱120.00"), "live price");

  const msgs = await prisma.message.findMany({ where: { conversationId: ok.value.conversationId } });
  assert.equal(msgs[1]?.intent, "product_search");
});
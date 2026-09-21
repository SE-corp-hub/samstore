// P7b: agent dashboard — conversations, assign/takeover/reply/resolve, canned replies, metrics.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ChatbotService } from "./chatbot.service.js";
import { ChatAgentService } from "./agent.service.js";

const bot = new ChatbotService();
const agent = new ChatAgentService();
const run = `P7B${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE", settings: { create: {} } },
  });
  createdStoreIds.push(s.id);
  return s;
}

async function makeAgent(storeId: string, name = `Agent ${slugSeq}`) {
  const u = await prisma.user.create({
    data: { name, phone: `+63919111${String(slugSeq).padStart(5, "0")}`, email: null, phoneVerified: true, passwordHash: "x" },
  });
  await prisma.userStore.create({ data: { userId: u.id, storeId, role: "MANAGER", status: "ACTIVE" } });
  return u;
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      await prisma.message.deleteMany({ where: { storeId } });
      await prisma.conversation.deleteMany({ where: { storeId } });
      await prisma.cannedReply.deleteMany({ where: { storeId } });
      const userIds = (await prisma.userStore.findMany({ where: { storeId }, select: { userId: true } })).map((x) => x.userId);
      await prisma.userStore.deleteMany({ where: { storeId } });
      if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("fallback → AGENT conversation → assign → takeover → agent reply → resolve", async () => {
  const store = await makeStore();
  const a = await makeAgent(store.id);

  // Bot hands off on an unanswered query.
  const r = await bot.handleCustomerMessage(store.id, { psid: "PSID-AGENT" }, "totally unknown thing");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const convId = r.value.conversationId;

  const list = await agent.list(store.id);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.status, "AGENT");
  assert.equal(list[0]?.unreadCount, 1);

  const assigned = await agent.assign(store.id, convId, a.id);
  assert.equal(assigned.ok, true);
  const taken = await agent.takeover(store.id, convId, a.id);
  assert.equal(taken.ok, true);
  if (!taken.ok) return;
  assert.equal(taken.value.mode, "AGENT");

  const replied = await agent.reply(store.id, convId, a.id, "Hi! How can we help?");
  assert.equal(replied.ok, true);
  const conv = await prisma.conversation.findUnique({ where: { id: convId } });
  assert.equal(conv?.mode, "AGENT");
  assert.equal(conv?.unreadCount, 0);

  const thread = await agent.thread(store.id, convId);
  assert.equal(thread.length, 3, "customer + bot + agent");
  assert.equal(thread[2]?.sender, "agent");

  const resolved = await agent.resolve(store.id, convId);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.value.status, "RESOLVED");

  const afterResolve = await agent.reply(store.id, convId, a.id, "hello?");
  assert.equal(afterResolve.ok, false, "resolved conversations reject replies");
});

test("canned replies are seeded, editable, and tenant-isolated", async () => {
  const store = await makeStore();
  const other = await makeStore();

  const seeded = await agent.listCanned(store.id);
  assert.ok(seeded.length >= 4, "defaults seeded");

  const created = await agent.upsertCanned(store.id, null, "Thanks", "Salamat po!");
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const updated = await agent.upsertCanned(store.id, created.value.id, "Thanks", "Salamat po — anything else?");
  assert.equal(updated.ok, true);

  const list = await agent.listCanned(store.id);
  assert.ok(list.some((c) => c.label === "Thanks"));

  // Tenant isolation.
  const cross = await agent.deleteCanned(other.id, created.value.id);
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.error.type, "not_found");
});

test("metrics: open/handled counts and avg first-response minutes", async () => {
  const store = await makeStore();
  const a = await makeAgent(store.id);

  // Handoff then quick agent reply → handled + response time.
  const r = await bot.handleCustomerMessage(store.id, { psid: "PSID-M1" }, "zzz unknown one");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  await agent.takeover(store.id, r.value.conversationId, a.id);
  await agent.reply(store.id, r.value.conversationId, a.id, "On it!");
  await agent.resolve(store.id, r.value.conversationId);

  // An open, unassigned conversation.
  const r2 = await bot.handleCustomerMessage(store.id, { psid: "PSID-M2" }, "qqq unknown two");
  assert.equal(r2.ok, true);

  const metrics = await agent.metrics(store.id);
  assert.equal(metrics.openUnassigned, 1);
  assert.equal(metrics.agents.length, 1);
  assert.equal(metrics.agents[0]?.handled, 1);
  assert.equal(metrics.agents[0]?.open, 0);
  assert.ok(typeof metrics.agents[0]?.avgFirstResponseMinutes === "number");
});
// P3g: Website→Messenger bridge — portal status + suppress-send default.
// Status reflects the store's recorded connection intent; sends never reach a live
// provider; a PSID is never guessed (no-psid opt-in → not_connected, recipient null).
// Real Prisma, run-scoped fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { MessengerBridgeService } from "./bridge.service.js";
import { SuppressedMessengerProvider, MockMessengerProvider } from "./messenger.adapter.js";

const run = `P3G${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore(over: { connected?: boolean; pageId?: string | null } = {}) {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: {
      name: `${run} store`,
      slug: `${run}-${slugSeq}`.toLowerCase(),
      status: "ACTIVE",
      settings: {
        create: { messengerConnected: over.connected ?? false, messengerPageId: over.pageId ?? null },
      },
    },
  });
  createdStoreIds.push(s.id);
  return s;
}

after(async () => {
  for (const storeId of createdStoreIds) {
    await prisma.notificationLog.deleteMany({ where: { storeId } });
    await prisma.storeSettings.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

test("default status is suppressed and not connected", async () => {
  const store = await makeStore();
  const status = await new MessengerBridgeService().status(store.id);
  assert.deepEqual(status, { connected: false, pageId: null, provider: "suppressed", suppressed: true });
});

test("recorded connection intent shows in status but provider stays suppressed", async () => {
  const store = await makeStore();
  const svc = new MessengerBridgeService();
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { messengerConnected: true, messengerPageId: "fb-page-123" } });
  const status = await svc.status(store.id);
  assert.equal(status.connected, true);
  assert.equal(status.pageId, "fb-page-123");
  assert.equal(status.provider, "suppressed");
  assert.equal(status.suppressed, true);
});

test("opt-in without a PSID is not_connected and NEVER fabricates a recipient", async () => {
  const store = await makeStore();
  const r = await new MessengerBridgeService().bridgeOptIn(store.id, {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.result.delivered, false);
  assert.equal(r.value.result.reason, "not_connected");
  assert.equal(r.value.status.connected, false);

  const log = await prisma.notificationLog.findFirst({ where: { storeId: store.id, channel: "messenger" }, orderBy: { createdAt: "desc" } });
  assert.ok(log, "intent recorded in the audit log");
  assert.equal(log?.recipient, null, "no PSID is ever fabricated");
  assert.equal(log?.delivered, false);
});

test("opt-in with a PSID routes through the (suppressed) provider", async () => {
  const store = await makeStore({ connected: true });
  const r = await new MessengerBridgeService().bridgeOptIn(store.id, { psid: "PSID-REAL-123" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Connected but provider is suppressed → the send is suppressed, not delivered.
  assert.equal(r.value.result.delivered, false);
  assert.equal(r.value.result.reason, "suppressed");
  assert.equal(r.value.status.connected, true);

  const log = await prisma.notificationLog.findFirst({ where: { storeId: store.id, channel: "messenger" }, orderBy: { createdAt: "desc" } });
  assert.equal(log?.recipient, "PSID-REAL-123");
  assert.equal(log?.delivered, false);
});

test("a mock provider (demos only) delivers and records the message", async () => {
  const store = await makeStore({ connected: true });
  const mock = new MockMessengerProvider();
  const r = await new MessengerBridgeService(mock).bridgeOptIn(store.id, { psid: "PSID-DEMO", text: "Order on the way!" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.result.delivered, true);
  assert.equal(mock.sentMessages().length, 1);
  assert.equal(mock.sentMessages()[0]?.psid, "PSID-DEMO");
  const log = await prisma.notificationLog.findFirst({ where: { storeId: store.id, channel: "messenger" }, orderBy: { createdAt: "desc" } });
  assert.equal(log?.delivered, true);
});

test("unknown store is not_found; status is tenant-scoped", async () => {
  const a = await makeStore();
  const b = await makeStore({ connected: true });
  const svc = new MessengerBridgeService();
  const missing = await svc.bridgeOptIn("does-not-exist", {});
  assert.equal(missing.ok, false);

  const sb = await svc.status(b.id);
  assert.equal(sb.connected, true);
  const sa = await svc.status(a.id);
  assert.equal(sa.connected, false, "store A does not inherit store B's connection");
});
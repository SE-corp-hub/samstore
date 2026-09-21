// P6a: Messenger connection — token HASHED never stored, webhook token returned once,
// PSID→customer mapping, deep link, tenant isolation. Real Prisma fixtures.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { MessengerConnectionService, hashSecret } from "./connection.service.js";

const svc = new MessengerConnectionService();
const run = `P6A${Date.now()}${Math.floor(Math.random() * 1000)}`;
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

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      await prisma.messengerUser.deleteMany({ where: { storeId } });
      await prisma.messengerPage.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("connect hashes the token (never stored), sets connected; disconnect clears it", async () => {
  const store = await makeStore();
  const c = await svc.connect(store.id, { pageId: "1029384756", pageName: "Kape PH", accessToken: "EAAG-abcdefghijklmnop" });
  assert.equal(c.ok, true);

  const page = await prisma.messengerPage.findUnique({ where: { storeId: store.id } });
  assert.ok(page);
  assert.equal(page?.accessTokenHash, hashSecret("EAAG-abcdefghijklmnop"));
  assert.equal(page?.pageId, "1029384756");
  assert.ok(!page?.accessTokenHash.includes("EAAG-"), "token is never stored in plaintext");

  const status = await svc.getConnection(store.id);
  assert.equal(status.connected, true);
  assert.equal(status.pageId, "1029384756");
  assert.equal(status.provider, "suppressed", "sends stay suppressed until operator approval");

  const d = await svc.disconnect(store.id);
  assert.equal(d.ok, true);
  assert.equal((await svc.getConnection(store.id)).connected, false);
  assert.equal(await prisma.messengerPage.count({ where: { storeId: store.id } }), 0);
});

test("webhook verify token is returned once and only its hash is stored", async () => {
  const store = await makeStore();
  await svc.connect(store.id, { pageId: "p1", pageName: "Store", accessToken: "token-abcdefghijkl" });
  const r = await svc.rotateWebhookToken(store.id);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const token = r.value.webhookVerifyToken;
  assert.ok(token.length >= 20, "high-entropy token");
  const page = await prisma.messengerPage.findUnique({ where: { storeId: store.id } });
  assert.equal(page?.webhookVerifyTokenHash, hashSecret(token));
  assert.ok(!page?.webhookVerifyTokenHash.includes(token), "plaintext never stored");
});

test("PSID→customer mapping upserts and lists messenger users", async () => {
  const store = await makeStore();
  const customer = await prisma.customer.create({ data: { name: "Maria", phone: "+63919999" + String(slugSeq).padStart(4, "0"), email: null, passwordHash: null } });

  const m1 = await svc.mapUser(store.id, "PSID-1", customer.id);
  assert.equal(m1.ok, true);
  const m2 = await svc.mapUser(store.id, "PSID-1", customer.id, false); // same PSID → upsert (opted out)
  assert.equal(m2.ok, true);

  const users = await svc.listUsers(store.id);
  assert.equal(users.length, 1);
  assert.equal(users[0]?.psid, "PSID-1");
  assert.equal(users[0]?.customer?.id, customer.id);
  assert.equal(users[0]?.optedIn, false, "opt-out respected on re-map");

  await prisma.customer.delete({ where: { id: customer.id } });
});

test("deep link requires a connection and reflects the store slug", async () => {
  const store = await makeStore();
  const before = await svc.deepLink(store.id, "kape-ph");
  assert.equal(before.ok, false);
  if (!before.ok) assert.equal(before.error.type, "conflict");

  await svc.connect(store.id, { pageId: "1029384756", pageName: "Kape PH", accessToken: "token-abcdefghijkl" });
  const link = await svc.deepLink(store.id, "kape-ph");
  assert.equal(link.ok, true);
  if (!link.ok) return;
  assert.equal(link.value.deepLink, "https://m.me/1029384756?ref=kape-ph");
});

test("tenant isolation: store B cannot touch store A's page or users", async () => {
  const a = await makeStore();
  const b = await makeStore();
  await svc.connect(a.id, { pageId: "pA", pageName: "A", accessToken: "token-abcdefghijkl" });
  await svc.mapUser(a.id, "PSID-A", null);

  // store B has no page → rotate/status reflect only B's own state.
  const bStatus = await svc.getConnection(b.id);
  assert.equal(bStatus.connected, false);
  assert.equal(bStatus.pageId, null);

  // store B's deep link cannot use A's page.
  const bLink = await svc.deepLink(b.id, "b-slug");
  assert.equal(bLink.ok, false);

  const bUsers = await svc.listUsers(b.id);
  assert.equal(bUsers.length, 0, "store B does not see store A's users");
});
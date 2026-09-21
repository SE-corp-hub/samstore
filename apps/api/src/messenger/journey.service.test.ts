// P6b: journey DISPATCH — live catalog + order lookup through the mock provider.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { MessengerJourneyService } from "./journey.service.js";
import { MockMessengerProvider } from "./messenger.adapter.js";

const run = `P6B${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE", settings: { create: {} } },
  });
  createdStoreIds.push(s.id);
  const cat = await prisma.category.create({ data: { storeId: s.id, name: "Drinks", slug: `drinks-${run}-${slugSeq}`, sortOrder: 0 } });
  const p = await prisma.product.create({ data: { storeId: s.id, sku: `${run}-p${slugSeq}`, name: "Kape", priceMinor: 12000, categoryId: cat.id } });
  await prisma.stockLevel.create({ data: { storeId: s.id, productId: p.id, quantityOnHand: 5, quantityReserved: 0 } });
  return { store: s, product: p };
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      await prisma.messengerUser.deleteMany({ where: { storeId } });
      await prisma.notificationLog.deleteMany({ where: { storeId } });
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

test("dispatch runs the journey and routes replies through the (mock) provider", async () => {
  const { store, product } = await makeStore();
  const mock = new MockMessengerProvider();
  const svc = new MessengerJourneyService(mock);

  const welcome = await svc.dispatch(store.id, "PSID-1", { text: "" });
  assert.equal(welcome.ok, true);
  if (!welcome.ok) return;
  assert.ok(welcome.value.sent >= 1);
  assert.ok(mock.sentMessages().length >= 1, "provider received the reply");

  const cat = await prisma.category.findFirst({ where: { storeId: store.id } });
  const catTurn = await svc.dispatch(store.id, "PSID-1", { payload: `category:${cat!.id}` });
  assert.equal(catTurn.ok, true);
  if (!catTurn.ok) return;
  const carousel = catTurn.value.templates.find((r) => r.type === "carousel");
  assert.ok(carousel, "carousel sent for the category");

  const identity = await prisma.messengerUser.findUnique({ where: { storeId_psid: { storeId: store.id, psid: "PSID-1" } } });
  assert.ok(identity, "identity mapping upserted");
  assert.equal(identity?.optedIn, true);

  const logs = await prisma.notificationLog.count({ where: { storeId: store.id, channel: "messenger" } });
  assert.ok(logs >= 1, "reply audit rows written (suppressed side effect)");
});
// P3j: abandoned-cart recovery — expired OPEN carts are marked ABANDONED and a
// cart.abandoned outbox event is enqueued (worker → suppressed NotificationLog row).
// Real Prisma, run-scoped fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { CartRecoveryService } from "./recovery.service.js";
import { OutboxWorker } from "../notifications/outbox.service.js";

const svc = new CartRecoveryService();
const run = `P3J${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({ data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE" } });
  createdStoreIds.push(s.id);
  return s;
}

async function makeProduct(storeId: string) {
  return prisma.product.create({ data: { storeId, sku: `${run}-p${slugSeq}`, name: "P3J", priceMinor: 1000 } });
}

async function makeCart(storeId: string, productId: string, status: "OPEN" | "CONVERTED", expiresAt: Date, withItems = true) {
  const cart = await prisma.cart.create({
    data: { storeId, token: `${run}-c${Math.floor(Math.random() * 1e12)}`, status, expiresAt },
  });
  if (withItems) {
    await prisma.cartItem.create({ data: { cartId: cart.id, storeId, productId, quantity: 2, unitPriceMinor: 1000 } });
  }
  return cart;
}

after(async () => {
  for (const storeId of createdStoreIds) {
    await prisma.cartItem.deleteMany({ where: { storeId } });
    await prisma.cart.deleteMany({ where: { storeId } });
    await prisma.outboxEvent.deleteMany({ where: { storeId } });
    await prisma.notificationLog.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

test("expired OPEN cart with items is abandoned + outbox event enqueued + worker logs it", async () => {
  const store = await makeStore();
  const product = await makeProduct(store.id);
  const old = await makeCart(store.id, product.id, "OPEN", new Date(Date.now() - 86_400_000));

  const r = await svc.expireAbandoned(store.id);
  assert.deepEqual(r, { expired: 1, enqueued: 1 });

  const cart = await prisma.cart.findUnique({ where: { id: old.id } });
  assert.equal(cart?.status, "ABANDONED");

  const ev = await prisma.outboxEvent.findFirst({ where: { storeId: store.id, eventType: "cart.abandoned" } });
  assert.ok(ev, "outbox event enqueued");
  assert.equal(ev?.status, "PENDING");
  assert.equal((ev?.payload as Record<string, unknown>).itemCount, 2);

  // The worker drains it into a (suppressed) NotificationLog row.
  const processed = await new OutboxWorker().poll(20);
  assert.equal(processed, 1);
  const log = await prisma.notificationLog.findFirst({ where: { storeId: store.id, template: "cart.abandoned" } });
  assert.ok(log, "notification log row written (suppressed side effect)");
  assert.equal(log?.delivered, false);
});

test("fresh, converted, and item-less carts are untouched; run is idempotent", async () => {
  const store = await makeStore();
  const product = await makeProduct(store.id);
  const fresh = await makeCart(store.id, product.id, "OPEN", new Date(Date.now() + 86_400_000));
  const converted = await makeCart(store.id, product.id, "CONVERTED", new Date(Date.now() - 86_400_000));
  const empty = await makeCart(store.id, product.id, "OPEN", new Date(Date.now() - 86_400_000), false);

  const r = await svc.expireAbandoned(store.id);
  assert.deepEqual(r, { expired: 0, enqueued: 0 }, "no eligible carts");

  for (const [id, expect] of [[fresh.id, "OPEN"], [converted.id, "CONVERTED"], [empty.id, "OPEN"]] as [string, string][]) {
    const c = await prisma.cart.findUnique({ where: { id } });
    assert.equal(c?.status, expect);
  }

  // An eligible one IS processed, then the second run is a no-op.
  const old = await makeCart(store.id, product.id, "OPEN", new Date(Date.now() - 86_400_000));
  assert.deepEqual(await svc.expireAbandoned(store.id), { expired: 1, enqueued: 1 });
  assert.deepEqual(await svc.expireAbandoned(store.id), { expired: 0, enqueued: 0 }, "idempotent");
});
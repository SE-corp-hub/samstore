// P3h: loyalty depth — welcome bonus on first profile, store-configurable earn rate,
// reversal on refund/void (idempotent), FIFO expiry. Real Prisma, run-scoped fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { LoyaltyService } from "./loyalty.service.js";

const svc = new LoyaltyService();
const run = `P3H${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];
const createdCustomerIds: string[] = [];

let slugSeq = 0;
async function makeStore(over: { welcome?: number; rate?: number; expiryMonths?: number } = {}) {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: {
      name: `${run} store`,
      slug: `${run}-${slugSeq}`.toLowerCase(),
      status: "ACTIVE",
      settings: {
        create: {
          loyaltyWelcomeBonusPoints: over.welcome ?? 0,
          loyaltyPointsPerPeso: over.rate ?? 1,
          loyaltyExpiryMonths: over.expiryMonths ?? 0,
        },
      },
    },
  });
  createdStoreIds.push(s.id);
  return s;
}

async function makeCustomer(storeId: string) {
  const c = await prisma.customer.create({ data: { name: `Buyer ${slugSeq}`, phone: `+63919999${String(slugSeq).padStart(4, "0")}`, email: null, passwordHash: null } });
  createdCustomerIds.push(c.id);
  const profile = await svc.ensureProfile(storeId, c.id);
  return { customerId: c.id, storeCustomerId: profile.storeCustomerId };
}

async function makeOrder(storeId: string, storeCustomerId: string, totalMinor: number) {
  const seq = await prisma.storeCounter.upsert({
    where: { storeId_kind: { storeId, kind: "ORDER_SEQ" } },
    update: { value: { increment: 1 } },
    create: { storeId, kind: "ORDER_SEQ", value: 1 },
  });
  return prisma.order.create({
    data: {
      orderNumber: `${run}-${storeId.slice(-5)}-${seq.value}`.toUpperCase(),
      storeId,
      status: "COMPLETED",
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: totalMinor,
      deliveryFeeMinor: 0,
      discountMinor: 0,
      totalMinor,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: "COLLECTED",
      idempotencyKey: `p3h-${run}-${slugSeq}-${seq.value}`,
      cartToken: "",
      customerName: "Buyer",
      customerPhone: "+63",
      deliveryAddressLine1: "",
      storeCustomerId,
    },
  });
}

after(async () => {
  for (const storeId of createdStoreIds) {
    await prisma.loyaltyEntry.deleteMany({ where: { storeId } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.storeCustomer.deleteMany({ where: { storeId } });
    await prisma.storeSettings.deleteMany({ where: { storeId } });
    await prisma.storeCounter.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  if (createdCustomerIds.length > 0) {
    await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
  }
  await prisma.$disconnect();
});

test("welcome bonus is granted once on first profile", async () => {
  const store = await makeStore({ welcome: 50 });
  const first = await makeCustomer(store.id);
  const sc = await prisma.storeCustomer.findUnique({ where: { id: first.storeCustomerId } });
  assert.equal(sc?.loyaltyBalancePoints, 50);
  const welcomes = await prisma.loyaltyEntry.count({ where: { storeCustomerId: first.storeCustomerId, type: "WELCOME" } });
  assert.equal(welcomes, 1);

  // ensureProfile on an existing profile must NOT re-grant.
  await svc.ensureProfile(store.id, first.customerId);
  const again = await prisma.loyaltyEntry.count({ where: { storeCustomerId: first.storeCustomerId, type: "WELCOME" } });
  assert.equal(again, 1, "no double welcome bonus");
});

test("no welcome bonus when not configured", async () => {
  const store = await makeStore();
  const p = await makeCustomer(store.id);
  const sc = await prisma.storeCustomer.findUnique({ where: { id: p.storeCustomerId } });
  assert.equal(sc?.loyaltyBalancePoints, 0);
});

test("earn uses the store's configured rate", async () => {
  const store = await makeStore({ rate: 2 });
  const p = await makeCustomer(store.id);
  const order = await makeOrder(store.id, p.storeCustomerId, 10000); // ₱100
  await svc.earnForDeliveredOrder(order.id);
  const sc = await prisma.storeCustomer.findUnique({ where: { id: p.storeCustomerId } });
  assert.equal(sc?.loyaltyBalancePoints, 200, "2 pts per ₱1 → 200 pts");
});

test("reversal is idempotent and never drops the balance below zero", async () => {
  const store = await makeStore();
  const p = await makeCustomer(store.id);
  const order = await makeOrder(store.id, p.storeCustomerId, 3000); // ₱30 → 30 pts
  await svc.earnForDeliveredOrder(order.id);

  await svc.reverseForOrder(order.id, "order voided");
  const after1 = await prisma.storeCustomer.findUnique({ where: { id: p.storeCustomerId } });
  assert.equal(after1?.loyaltyBalancePoints, 0);
  const reverses = await prisma.loyaltyEntry.count({ where: { orderId: order.id, type: "REVERSE" } });
  assert.equal(reverses, 1);

  await svc.reverseForOrder(order.id, "order voided"); // second call
  const after2 = await prisma.storeCustomer.findUnique({ where: { id: p.storeCustomerId } });
  assert.equal(after2?.loyaltyBalancePoints, 0, "no double clawback");
  assert.equal(await prisma.loyaltyEntry.count({ where: { orderId: order.id, type: "REVERSE" } }), 1);
});

test("reversal on an order with no earned points is a no-op", async () => {
  const store = await makeStore();
  const p = await makeCustomer(store.id);
  const order = await makeOrder(store.id, p.storeCustomerId, 500);
  await svc.reverseForOrder(order.id, "refunded");
  const sc = await prisma.storeCustomer.findUnique({ where: { id: p.storeCustomerId } });
  assert.equal(sc?.loyaltyBalancePoints, 0);
});

test("expiry removes only points older than the window (FIFO)", async () => {
  const store = await makeStore({ expiryMonths: 2 });
  const p = await makeCustomer(store.id);
  const sc = await prisma.storeCustomer.findUnique({ where: { id: p.storeCustomerId } });

  const oldDate = new Date(Date.now() - 90 * 86_400_000);
  const recentDate = new Date(Date.now() - 10 * 86_400_000);

  // 100 pts earned 90 days ago (aged) + 50 pts earned 10 days ago (fresh) = balance 150.
  await prisma.loyaltyEntry.createMany({
    data: [
      { storeId: store.id, customerId: p.customerId, storeCustomerId: sc!.id, type: "EARN", points: 100, balanceAfter: 100, createdAt: oldDate, description: "old" },
      { storeId: store.id, customerId: p.customerId, storeCustomerId: sc!.id, type: "EARN", points: 50, balanceAfter: 150, createdAt: recentDate, description: "fresh" },
    ],
  });
  await prisma.storeCustomer.update({ where: { id: sc!.id }, data: { loyaltyBalancePoints: 150 } });

  const result = await svc.expirePoints(store.id);
  assert.equal(result.expiredPoints, 100, "only the aged 100 expire");
  assert.equal(result.customers, 1);

  const after = await prisma.storeCustomer.findUnique({ where: { id: sc!.id } });
  assert.equal(after?.loyaltyBalancePoints, 50, "fresh points kept");
  const expired = await prisma.loyaltyEntry.findFirst({ where: { storeCustomerId: sc!.id, type: "EXPIRED" } });
  assert.ok(expired);
  assert.equal(expired?.points, -100);
  assert.equal(expired?.balanceAfter, 50);

  // Second run expires nothing new.
  const second = await svc.expirePoints(store.id);
  assert.equal(second.expiredPoints, 0);
});

test("expiry is skipped when the store disables it", async () => {
  const store = await makeStore(); // expiryMonths 0
  const p = await makeCustomer(store.id);
  const r = await svc.expirePoints(store.id);
  assert.deepEqual(r, { expiredPoints: 0, customers: 0 });
});
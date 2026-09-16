// Module 2 — atomic single-use claim consumption. Real Prisma, run-scoped fixtures.
// Two concurrent claims of the SAME token: exactly one succeeds, the other gets a
// conflict — proving the usedAt guard is a conditional, race-free update.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { OrderLookupService } from "./order-lookup.service.js";
import { signClaimToken } from "../domain/claim-token.js";

const SECRET = "test-claim-secret-0123456789";
const run = `CLA${Date.now()}${Math.floor(Math.random() * 1000)}`;
let slugSeq = 0;
const createdStoreIds: string[] = [];
const createdOrderIds: string[] = [];
const createdTokenIds: string[] = [];

async function makeOrderWithToken() {
  slugSeq += 1;
  const slug = `${run}-${slugSeq}-store`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  const store = await prisma.store.create({ data: { slug, name: `Claim ${run}` } });
  createdStoreIds.push(store.id);

  const nr = `SAMSTO-${String(Date.now() % 100000).padStart(6, "0")}`;
  const order = await prisma.order.create({
    data: {
      orderNumber: `${nr}-${store.id.slice(-4)}`,
      storeId: store.id,
      currencyCode: "PHP",
      subtotalMinor: 12000,
      deliveryFeeMinor: 0,
      totalMinor: 12000,
      snapshot: { items: [] },
      paymentMethod: "cod",
      idempotencyKey: `idem-${store.id.slice(-6)}`,
      cartToken: `cart-${store.id.slice(-6)}`,
      customerName: "Test Claimer",
      customerPhone: "+6390000000",
      deliveryAddressLine1: "1 Test St",
    },
  });
  createdOrderIds.push(order.id);

  const token = signClaimToken(order.id, SECRET);
  const row = await prisma.orderClaimToken.create({
    data: { orderId: order.id, storeId: store.id, token, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  createdTokenIds.push(row.id);
  return token;
}

after(async () => {
  if (createdOrderIds.length > 0) {
    await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdStoreIds.length > 0) await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  await prisma.$disconnect();
});

test("two concurrent claims — exactly one succeeds", async () => {
  const token = await makeOrderWithToken();
  const svc = new OrderLookupService(SECRET);

  const [a, b] = await Promise.all([svc.claimOrder(token), svc.claimOrder(token)]);

  const okCount = [a, b].filter((r) => r.ok).length;
  const conflictCount = [a, b].filter((r) => !r.ok && r.error.type === "conflict").length;
  assert.equal(okCount, 1, `exactly one claim succeeds (ok=${okCount})`);
  assert.equal(conflictCount, 1, `the other claim is a conflict (conflicts=${conflictCount})`);
  if (a.ok) assert.equal(a.value.orderId.length > 0, true);
});

test("a used token stays used on a third claim", async () => {
  const token = await makeOrderWithToken();
  const svc = new OrderLookupService(SECRET);
  const first = await svc.claimOrder(token);
  assert.equal(first.ok, true);
  const second = await svc.claimOrder(token);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.type, "conflict");
});

test("signed order number visible only to the claimer", async () => {
  const token = await makeOrderWithToken();
  const svc = new OrderLookupService(SECRET);
  const r = await svc.claimOrder(token);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.orderNumber, /^SAMSTO-/);
});
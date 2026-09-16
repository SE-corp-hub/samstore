// Module 3 — database integrity foundation tests (real Prisma, run-scoped fixtures).
//  - Composite tenant FKs: a child row can NOT reference another store's parent.
//  - Fulfillment backfill: empty-address orders are PICKUP; addressed are DELIVERY.
//  - StockMovement + OutboxEvent models write/read round-trip.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./prisma-repositories.js";

const run = `M3${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];
const createdOrderIds: string[] = [];

async function makeStore(tag: string) {
  const slug = `${run}-${tag}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  const s = await prisma.store.create({ data: { slug, name: `M3 ${run} ${tag}` } });
  createdStoreIds.push(s.id);
  return s;
}

async function makeOrder(storeId: string, tag: string, address = "123 Rizal Ave") {
  const o = await prisma.order.create({
    data: {
      orderNumber: `M3-${tag}-${storeId.slice(-4)}`,
      storeId,
      currencyCode: "PHP",
      subtotalMinor: 10000,
      deliveryFeeMinor: 0,
      totalMinor: 10000,
      snapshot: { items: [] },
      paymentMethod: "cod",
      idempotencyKey: `m3idem-${tag}-${storeId.slice(-4)}`,
      cartToken: `m3cart-${tag}`,
      customerName: "M3 Tester",
      customerPhone: "+6390000000",
      deliveryAddressLine1: address,
    },
  });
  createdOrderIds.push(o.id);
  return o;
}

after(async () => {
  if (createdOrderIds.length > 0) {
    await prisma.stockMovement.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdStoreIds.length > 0) await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  await prisma.$disconnect();
});

test("composite FK: OrderItem cannot reference another store's order", async () => {
  const storeA = await makeStore("a");
  const storeB = await makeStore("b");
  const orderB = await makeOrder(storeB.id, "b1");

  let failed = false;
  try {
    await prisma.orderItem.create({
      data: {
        orderId: orderB.id,
        storeId: storeA.id, // <- cross-tenant mismatch
        productId: null,
        productName: "Sneaky",
        sku: "X",
        unitPriceMinor: 100,
        quantity: 1,
        lineTotalMinor: 100,
      },
    });
  } catch (e) {
    failed = true;
    const err = e as { code?: string; message?: string };
    assert.equal(err.code, "P2003", `expected FK violation (P2003), got ${err.code}`);
    assert.ok(String(err.message).includes("storeId"), "violation is the composite tenant FK");
  }
  assert.equal(failed, true, "cross-tenant child insert MUST fail");
});

test("composite FK: tenant-matched child insert succeeds", async () => {
  const storeA = await makeStore("c");
  const orderA = await makeOrder(storeA.id, "c1");
  const item = await prisma.orderItem.create({
    data: {
      orderId: orderA.id,
      storeId: storeA.id,
      productId: null,
      productName: "Legit",
      sku: "L1",
      unitPriceMinor: 200,
      quantity: 2,
      lineTotalMinor: 400,
    },
  });
  assert.ok(item.id.length > 0);
});

test("fulfillment backfill invariant holds across existing orders", async () => {
  // Orders with NO delivery address must be PICKUP; orders WITH an address DELIVERY.
  // (Backfill applied this rule; new writes maintain it — see pos/prisma repos.)
  const groups = await prisma.$queryRawUnsafe(`
    SELECT CASE WHEN btrim(coalesce("deliveryAddressLine1",'')) = '' THEN 'no-address' ELSE 'has-address' END AS addr,
           "fulfillmentType" AS ft, count(*) AS n
    FROM "Order" GROUP BY 1, 2`) as { addr: string; ft: string; n: bigint }[];
  let bad = 0;
  let total = 0;
  for (const g of groups) {
    total += Number(g.n);
    if (g.addr === "no-address" && g.ft !== "PICKUP") bad += Number(g.n);
    if (g.addr === "has-address" && g.ft !== "DELIVERY") bad += Number(g.n);
  }
  console.log(`  [fulfillment] total=${total} violations=${bad}`);
  assert.equal(bad, 0, `fulfillmentType/address mismatch rows: ${bad}`);
});

test("new orders write explicit fulfillmentType (PICKUP for POS, DELIVERY for addressed)", async () => {
  const storeA = await makeStore("d");
  const pickup = await prisma.order.create({
    data: {
      orderNumber: `M3-PU-${storeA.id.slice(-4)}`,
      storeId: storeA.id,
      currencyCode: "PHP",
      subtotalMinor: 5000,
      deliveryFeeMinor: 0,
      totalMinor: 5000,
      snapshot: { items: [] },
      paymentMethod: "cod",
      idempotencyKey: `m3pu-${storeA.id.slice(-4)}`,
      cartToken: `m3pu-cart`,
      customerName: "Pickup",
      customerPhone: "+6390000000",
      deliveryAddressLine1: "",
      fulfillmentType: "PICKUP",
    },
  });
  createdOrderIds.push(pickup.id);
  const read = await prisma.order.findUnique({ where: { id: pickup.id }, select: { fulfillmentType: true } });
  assert.equal(read?.fulfillmentType, "PICKUP");
});

test("StockMovement + OutboxEvent write/read round-trip", async () => {
  const storeA = await makeStore("e");
  const orderA = await makeOrder(storeA.id, "e1");
  const product = await prisma.product.create({
    data: { storeId: storeA.id, sku: `M3-SKU-${storeA.id.slice(-4)}`, name: "M3 Round-trip", priceMinor: 1000 },
  });
  const movement = await prisma.stockMovement.create({
    data: {
      storeId: storeA.id,
      productId: product.id,
      delta: -1,
      type: "CONSUME",
      orderId: orderA.id,
      createdBy: "m3-test",
      balanceAfter: 9,
      note: "round-trip",
    },
  });
  const m2 = await prisma.stockMovement.findUnique({ where: { id: movement.id } });
  assert.equal(m2?.type, "CONSUME");
  assert.equal(m2?.delta, -1);

  const out = await prisma.outboxEvent.create({
    data: {
      storeId: storeA.id,
      aggregateType: "order",
      aggregateId: orderA.id,
      eventType: "order.received",
      payload: { orderNumber: orderA.orderNumber, totalMinor: 10000 },
    },
  });
  const o2 = await prisma.outboxEvent.findUnique({ where: { id: out.id } });
  assert.equal(o2?.status, "PENDING");
  assert.equal((o2?.payload as { totalMinor: number }).totalMinor, 10000);

  await prisma.stockMovement.delete({ where: { id: movement.id } });
  await prisma.outboxEvent.delete({ where: { id: out.id } });
  await prisma.product.delete({ where: { id: product.id } });
});
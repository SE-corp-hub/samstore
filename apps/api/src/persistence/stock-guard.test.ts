// Module 4 fix — stock writes are decided at the DATABASE BOUNDARY by guarded
// conditional UPDATEs, not by read-then-write checks. These tests prove:
//   1. a reservation beyond availability is rejected and leaves NO partial writes
//      (the "two buyers, one last unit" loser path, proven deterministically —
//      the Supabase pooler cannot run two concurrent interactive transactions);
//   2. a guarded decrement can never drive a level negative;
//   3. products with no stock rows stay untracked (legacy no-op).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, PrismaOrderRepository } from "./prisma-repositories.js";
import { randomId } from "./repositories.js";
import { deductStock, InsufficientStockError } from "../domain/movements.js";

const run = `SG${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const productIds: string[] = [];
const cartIds: string[] = [];
let slugSeq = 0;

after(async () => {
  if (storeIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    // The LIVE API's outbox worker may already have drained a test event into a
    // NotificationLog row — delete those before the store itself.
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } });
    const orderIds = (await prisma.order.findMany({ where: { storeId: { in: storeIds } }, select: { id: true } })).map((o) => o.id);
    if (orderIds.length) {
      await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (cartIds.length) {
      await prisma.cartItem.deleteMany({ where: { cartId: { in: cartIds } } });
      await prisma.cart.deleteMany({ where: { id: { in: cartIds } } });
    }
    if (productIds.length) {
      await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.stockLevel.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    }
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

interface Fixture {
  storeId: string;
  productId: string;
  levelId: string | null;
  cartToken: string;
}

async function fixture(onHand: number, withLevel = true): Promise<Fixture> {
  slugSeq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-s${slugSeq}`.toLowerCase(), name: `SG ${run}` } });
  storeIds.push(store.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `SG-${store.id.slice(-5)}`, name: "SG Product", priceMinor: 10000 } });
  productIds.push(product.id);
  let levelId: string | null = null;
  if (withLevel) {
    const lvl = await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: onHand, quantityReserved: 0 } });
    levelId = lvl.id;
  }
  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `sgcart-${store.id.slice(-5)}`, status: "OPEN" } });
  cartIds.push(cart.id);
  await prisma.cartItem.create({ data: { cartId: cart.id, storeId: store.id, productId: product.id, quantity: 1, unitPriceMinor: 10000 } });
  return { storeId: store.id, productId: product.id, levelId, cartToken: cart.token };
}

function orderFor(f: Fixture, orderNumber: string) {
  return {
    id: randomId(),
    orderNumber,
    storeId: f.storeId,
    status: "RECEIVED",
    currencyCode: "PHP",
    deliveryType: "delivery",
    subtotalMinor: 10000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 10000,
    snapshot: { lines: [] },
    paymentMethod: "cod",
    paymentStatus: "PENDING",
    idempotencyKey: randomId(),
    cartToken: f.cartToken,
    customerName: "SG Buyer",
    customerPhone: "+639****0000",
    deliveryAddressLine1: "1 SG St",
    deliveryAddressLine2: null, landmark: null, deliverySchedule: null, notes: null,
    claimToken: `sg.${randomId()}`,
    items: [{ productId: f.productId, productName: "SG Product", sku: "SG", unitPriceMinor: 10000, quantity: 1, lineTotalMinor: 10000 }],
    storeCustomerId: null,
    createdAt: new Date(),
  };
}

test("a reservation beyond availability is rejected atomically — no order, no cart conversion, no counter drift", async () => {
  const f = await fixture(1);
  const repo = new PrismaOrderRepository();

  // Buyer 1 takes the last unit.
  const first = await repo.createAtomic(orderFor(f, `SG-${f.storeId.slice(-4)}-A`), {
    cart: { token: f.cartToken, storeId: f.storeId },
    stockReservations: [{ productId: f.productId, quantity: 1 }],
  });
  assert.ok(first, "first buyer reserved the last unit");
  assert.equal((await prisma.stockLevel.findUnique({ where: { id: f.levelId! } }))?.quantityReserved, 1);

  // Buyer 2 asks for the same unit — the guarded UPDATE matches 0 rows.
  const second = orderFor(f, `SG-${f.storeId.slice(-4)}-B`);
  await assert.rejects(
    () => repo.createAtomic(second, { stockReservations: [{ productId: f.productId, quantity: 1 }] }),
    (e: unknown) => e instanceof InsufficientStockError,
    "second buyer is rejected with a typed domain error",
  );

  // Nothing from the loser's attempt persisted (the whole transaction rolled back).
  assert.equal(await prisma.order.findUnique({ where: { id: second.id } }), null, "no order row for the loser");
  assert.equal((await prisma.stockLevel.findUnique({ where: { id: f.levelId! } }))?.quantityReserved, 1, "reserved unchanged (still exactly one unit)");
  const moves = await prisma.stockMovement.findMany({ where: { productId: f.productId } });
  assert.equal(moves.length, 1, "only the winner's RESERVE movement exists");
  assert.equal(moves[0]!.type, "RESERVE");
  assert.equal(moves[0]!.delta, 1);
  // The loser's own cart was not converted either (it had no cart effect, but the
  // order that DID have effects must remain untouched).
  const cart = await prisma.cart.findFirst({ where: { token: f.cartToken } });
  assert.equal(cart?.status, "CONVERTED", "winner's cart converted exactly once");

  // Module 9 fix: the notification outbox row is part of the SAME transaction.
  // The winner has exactly one event; the loser's failed transaction wrote none.
  const events = await prisma.outboxEvent.findMany({ where: { storeId: f.storeId } });
  assert.equal(events.length, 1, "exactly one outbox event — the failed attempt wrote none");
  assert.equal(events[0]!.aggregateId, first.id, "the event belongs to the committed order");
  assert.equal(events[0]!.eventType, "order.received");
  // The API's outbox worker polls every 5s and may already have drained this event
  // (that IS the pipeline working); the invariant is that it was enqueued once and
  // never FAILED.
  assert.ok(["PENDING", "PROCESSED"].includes(events[0]!.status), `event status ${events[0]!.status}`);
});

test("a reservation equal to availability succeeds and records balanceAfter on the RESERVE movement", async () => {
  const f = await fixture(3);
  const repo = new PrismaOrderRepository();
  const o = orderFor(f, `SG-${f.storeId.slice(-4)}-C`);
  await repo.createAtomic(o, { stockReservations: [{ productId: f.productId, quantity: 3 }] });

  const lvl = await prisma.stockLevel.findUnique({ where: { id: f.levelId! } });
  assert.equal(lvl?.quantityReserved, 3, "fully reserved up to availability");
  assert.equal(lvl?.quantityOnHand, 3, "on-hand untouched by a reservation");
  const mv = await prisma.stockMovement.findFirst({ where: { orderId: o.id } });
  assert.equal(mv?.type, "RESERVE");
  assert.equal(mv?.delta, 3);
  assert.equal(mv?.balanceAfter, 3, "ledger records the reserved balance");
});

test("guarded deductStock can never drive a level negative", async () => {
  const f = await fixture(2);

  await prisma.$transaction(async (tx) => {
    await deductStock(tx, f.storeId, [{ productId: f.productId, quantity: 2 }], { type: "CONSUME", createdBy: "test" });
  });
  assert.equal((await prisma.stockLevel.findUnique({ where: { id: f.levelId! } }))?.quantityOnHand, 0, "drained to exactly zero");

  // One more unit is a hard shortfall — the balance must NOT become -1.
  await assert.rejects(
    () => prisma.$transaction(async (tx) => {
      await deductStock(tx, f.storeId, [{ productId: f.productId, quantity: 1 }], { type: "CONSUME", createdBy: "test" });
    }),
    (e: unknown) => e instanceof InsufficientStockError,
    "shortfall raises a typed domain error",
  );

  const lvl = await prisma.stockLevel.findUnique({ where: { id: f.levelId! } });
  assert.equal(lvl?.quantityOnHand, 0, "still zero — never negative");
  const consumes = await prisma.stockMovement.findMany({ where: { productId: f.productId } });
  assert.equal(consumes.length, 1, "the rejected attempt wrote no movement");
});

test("a product with no stock-level rows stays untracked (legacy no-op, no throw)", async () => {
  const f = await fixture(0, false);
  await prisma.$transaction(async (tx) => {
    await deductStock(tx, f.storeId, [{ productId: f.productId, quantity: 5 }], { type: "CONSUME" });
  });
  assert.equal(await prisma.stockLevel.count({ where: { productId: f.productId } }), 0);
  assert.equal(await prisma.stockMovement.count({ where: { productId: f.productId } }), 0);
});

// Module 5 — REAL atomicity test of PrismaOrderRepository.createAtomic (real DB).
// One transaction must persist: order + items + history + claim token + stock
// reservation (+movement) + cart CONVERTED + voucher redemption + loyalty deduction
// + credit entry+balance. If ANY of those is missing, the test fails.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, PrismaOrderRepository } from "./prisma-repositories.js";
import { randomId } from "./repositories.js";

const run = `M5${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ids: { stores: string[]; products: string[]; vouchers: string[]; customers: string[]; carts: string[] } = {
  stores: [], products: [], vouchers: [], customers: [], carts: [],
};

after(async () => {
  const s = ids.stores;
  if (s.length) {
    const orderIds = (await prisma.order.findMany({ where: { storeId: { in: s } }, select: { id: true } })).map((o) => o.id);
    if (orderIds.length) {
      await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.voucherRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (ids.customers.length) await prisma.storeCustomer.deleteMany({ where: { customerId: { in: ids.customers } } });
    if (ids.carts.length) {
      await prisma.cartItem.deleteMany({ where: { cartId: { in: ids.carts } } });
      await prisma.cart.deleteMany({ where: { id: { in: ids.carts } } });
    }
    if (ids.products.length) {
      await prisma.stockLevel.deleteMany({ where: { productId: { in: ids.products } } });
      await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
    }
    if (ids.vouchers.length) await prisma.voucher.deleteMany({ where: { id: { in: ids.vouchers } } });
    if (ids.customers.length) await prisma.customer.deleteMany({ where: { id: { in: ids.customers } } });
    // Fix #2: createAtomic writes the outbox event in-transaction and the live
    // worker drains it into a NotificationLog row — clear both before the store.
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: s } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: s } } });
    await prisma.store.deleteMany({ where: { id: { in: s } } });
  }
  await prisma.$disconnect();
});

test("createAtomic persists order + stock reserve + cart convert + voucher + loyalty + credit atomically", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-store`.toLowerCase(), name: `M5 ${run}` } });
  ids.stores.push(store.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `M5S-${store.id.slice(-4)}`, name: "M5 Product", priceMinor: 9900 } });
  ids.products.push(product.id);
  const level = await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 10, quantityReserved: 0 } });
  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `m5cart-${store.id.slice(-4)}`, status: "OPEN" } });
  ids.carts.push(cart.id);
  await prisma.cartItem.create({ data: { cartId: cart.id, storeId: store.id, productId: product.id, quantity: 2, unitPriceMinor: 9900 } });
  const voucher = await prisma.voucher.create({ data: { storeId: store.id, code: "M5OFF", discountMinor: 500 } });
  ids.vouchers.push(voucher.id);
  const customer = await prisma.customer.create({ data: { name: "M5 Buyer", phone: null, email: null, passwordHash: null } });
  ids.customers.push(customer.id);
  const sc = await prisma.storeCustomer.create({
    data: { storeId: store.id, customerId: customer.id, loyaltyBalancePoints: 500, creditApproved: true, creditLimitMinor: 100000, creditBalanceMinor: 0 },
  });

  const repo = new PrismaOrderRepository();
  const orderId = randomId();
  const order = {
    id: orderId,
    orderNumber: `M5AO-${store.id.slice(-4)}`,
    storeId: store.id,
    status: "RECEIVED",
    currencyCode: "PHP",
    deliveryType: "delivery",
    subtotalMinor: 19800,
    deliveryFeeMinor: 5000,
    discountMinor: 500,
    totalMinor: 24300,
    snapshot: { lines: [] },
    paymentMethod: "credit",
    paymentStatus: "PENDING",
    idempotencyKey: `m5idem-${store.id.slice(-4)}-${Date.now()}`,
    cartToken: cart.token,
    customerName: "M5 Buyer",
    customerPhone: "+6390000000",
    deliveryAddressLine1: "1 M5 St",
    deliveryAddressLine2: null,
    landmark: null,
    deliverySchedule: null,
    notes: null,
    claimToken: "tok.abc",
    items: [{ productId: product.id, productName: "M5 Product", sku: product.sku, unitPriceMinor: 9900, quantity: 2, lineTotalMinor: 19800 }],
    storeCustomerId: sc.id,
    createdAt: new Date(),
  };

  await repo.createAtomic(order, {
    cart: { token: cart.token, storeId: store.id },
    stockReservations: [{ productId: product.id, quantity: 2 }],
    voucherRedemption: { voucherId: voucher.id },
    loyalty: { customerId: customer.id, storeCustomerId: sc.id, points: 100 },
    credit: { storeCustomerId: sc.id, amountMinor: 24300 },
  });

  // ── verify everything persisted ──
  const o = await prisma.order.findUnique({ where: { id: orderId } });
  assert.ok(o, "order exists");
  assert.equal(o?.fulfillmentType, "DELIVERY");

  const levelNow = await prisma.stockLevel.findUnique({ where: { id: level.id } });
  assert.equal(levelNow?.quantityReserved, 2, "stock reserved atomically");
  const movements = await prisma.stockMovement.findMany({ where: { orderId } });
  assert.equal(movements.length, 1);
  assert.equal(movements[0]!.type, "RESERVE");
  assert.equal(movements[0]!.delta, 2);

  const cartNow = await prisma.cart.findUnique({ where: { id: cart.id } });
  assert.equal(cartNow?.status, "CONVERTED", "cart converted in the same transaction");

  const redemption = await prisma.voucherRedemption.findFirst({ where: { orderId } });
  assert.ok(redemption, "voucher redemption recorded");
  assert.equal(redemption?.voucherId, voucher.id);

  const scNow = await prisma.storeCustomer.findUnique({ where: { id: sc.id } });
  assert.equal(scNow?.loyaltyBalancePoints, 400, "loyalty points deducted atomically");
  const loyaltyEntry = await prisma.loyaltyEntry.findFirst({ where: { orderId } });
  assert.ok(loyaltyEntry, "loyalty ledger entry");
  assert.equal(loyaltyEntry?.points, -100);

  assert.equal(scNow?.creditBalanceMinor, 24300, "credit balance incremented atomically");
  const creditEntry = await prisma.creditEntry.findFirst({ where: { orderId } });
  assert.ok(creditEntry, "credit ledger entry");
  assert.equal(creditEntry?.amountMinor, 24300);
});

test("createAtomic with a duplicate idempotency key throws P2002 (no partial writes on conflict)", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-dup`.toLowerCase(), name: `M5 dup ${run}` } });
  ids.stores.push(store.id);
  const repo = new PrismaOrderRepository();
  const key = `m5dup-${store.id.slice(-4)}-${Date.now()}`;
  const base = {
    id: randomId(),
    storeId: store.id,
    status: "RECEIVED",
    currencyCode: "PHP",
    deliveryType: "delivery",
    subtotalMinor: 1000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 1000,
    snapshot: {}, paymentMethod: "cod", paymentStatus: "PENDING",
    idempotencyKey: key, cartToken: `c-${store.id.slice(-4)}`,
    customerName: "A", customerPhone: "+63", deliveryAddressLine1: "x",
    deliveryAddressLine2: null, landmark: null, deliverySchedule: null, notes: null,
    claimToken: null, items: [], storeCustomerId: null, createdAt: new Date(),
  };
  await repo.createAtomic({ ...base, orderNumber: `DUP1-${store.id.slice(-4)}` }, {});
  let threw = false;
  try {
    await repo.createAtomic({ ...base, orderNumber: `DUP2-${store.id.slice(-4)}` }, {});
  } catch (e) {
    threw = true;
    assert.equal((e as { code?: string }).code, "P2002");
  }
  assert.equal(threw, true, "duplicate idempotency key must violate the unique constraint");
  const count = await prisma.order.count({ where: { idempotencyKey: key } });
  assert.equal(count, 1);
});

test("M6: the voucher usedCount guard blocks at the limit (atomic UPDATE semantics)", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-vmax`.toLowerCase(), name: `M6 ${run}` } });
  ids.stores.push(store.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `M6V-${store.id.slice(-4)}`, name: "P", priceMinor: 1000 } });
  ids.products.push(product.id);
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 100, quantityReserved: 0 } });
  const voucher = await prisma.voucher.create({ data: { storeId: store.id, code: "M6ONLY", discountMinor: 100, maxRedemptions: 1 } });
  ids.vouchers.push(voucher.id);

  const repo = new PrismaOrderRepository();
  const mk = (tag: string) => ({
    id: randomId(),
    orderNumber: `V${tag}-${store.id.slice(-4)}`,
    storeId: store.id,
    status: "RECEIVED",
    currencyCode: "PHP",
    deliveryType: "delivery",
    subtotalMinor: 1000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 1000,
    snapshot: {}, paymentMethod: "cod", paymentStatus: "PENDING",
    idempotencyKey: `m6v-${tag}-${store.id.slice(-4)}`,
    cartToken: `c-${tag}`,
    customerName: "C", customerPhone: "+63", deliveryAddressLine1: "x",
    deliveryAddressLine2: null, landmark: null, deliverySchedule: null, notes: null,
    claimToken: null, items: [{ productId: product.id, productName: "P", sku: "P", unitPriceMinor: 1000, quantity: 1, lineTotalMinor: 1000 }],
    storeCustomerId: null, createdAt: new Date(),
  });

  // First checkout consumes the voucher (count 0 -> 1).
  await repo.createAtomic(mk("a"), { voucherRedemption: { voucherId: voucher.id }, stockReservations: [{ productId: product.id, quantity: 1 }] });

  // Second checkout MUST fail the guard — the UPDATE affects 0 rows -> limit conflict.
  let threw = false;
  try {
    await repo.createAtomic(mk("b"), { voucherRedemption: { voucherId: voucher.id }, stockReservations: [{ productId: product.id, quantity: 1 }] });
  } catch (e) {
    threw = true;
    assert.ok(String((e as Error).message).includes("Voucher redemption limit"), `expected limit conflict, got ${(e as Error).message}`);
  }
  assert.equal(threw, true, "second redemption must be blocked at the limit");
  const redemptions = await prisma.voucherRedemption.count({ where: { voucherId: voucher.id } });
  assert.equal(redemptions, 1, "voucher redeemed exactly once");
  const vNow = await prisma.voucher.findUnique({ where: { id: voucher.id } });
  assert.equal(vNow?.usedCount, 1, "counter stayed at the limit");
});

test("M6: the credit-limit guarded UPDATE blocks a purchase over the balance ceiling", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-clim`.toLowerCase(), name: `M6c ${run}` } });
  ids.stores.push(store.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `M6C-${store.id.slice(-4)}`, name: "P2", priceMinor: 100000 } });
  ids.products.push(product.id);
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 100, quantityReserved: 0 } });
  const customer = await prisma.customer.create({ data: { name: "M6 Buyer", phone: null, email: null, passwordHash: null } });
  ids.customers.push(customer.id);
  // Limit ₱1,500 — one ₱1,000 purchase fits, a second would breach it.
  const sc = await prisma.storeCustomer.create({
    data: { storeId: store.id, customerId: customer.id, creditApproved: true, creditLimitMinor: 150000, creditBalanceMinor: 0 },
  });

  const repo = new PrismaOrderRepository();
  const mk = (tag: string) => ({
    id: randomId(),
    orderNumber: `CL${tag}-${store.id.slice(-4)}`,
    storeId: store.id,
    status: "RECEIVED",
    currencyCode: "PHP",
    deliveryType: "delivery",
    subtotalMinor: 100000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 100000,
    snapshot: {}, paymentMethod: "credit", paymentStatus: "PENDING",
    idempotencyKey: `m6c-${tag}-${store.id.slice(-4)}`,
    cartToken: `cc-${tag}`,
    customerName: "C", customerPhone: "+63", deliveryAddressLine1: "x",
    deliveryAddressLine2: null, landmark: null, deliverySchedule: null, notes: null,
    claimToken: null, items: [{ productId: product.id, productName: "P2", sku: "P2", unitPriceMinor: 100000, quantity: 1, lineTotalMinor: 100000 }],
    storeCustomerId: sc.id, createdAt: new Date(),
  });

  await repo.createAtomic(mk("a"), { credit: { storeCustomerId: sc.id, amountMinor: 100000 }, stockReservations: [{ productId: product.id, quantity: 1 }] });

  let threw = false;
  try {
    await repo.createAtomic(mk("b"), { credit: { storeCustomerId: sc.id, amountMinor: 100000 }, stockReservations: [{ productId: product.id, quantity: 1 }] });
  } catch (e) {
    threw = true;
    assert.ok(String((e as Error).message).includes("Credit limit"), `expected credit-limit conflict, got ${(e as Error).message}`);
  }
  assert.equal(threw, true, "over-limit credit purchase must be blocked");
  const scNow = await prisma.storeCustomer.findUnique({ where: { id: sc.id } });
  assert.equal(scNow?.creditBalanceMinor, 100000, "balance never exceeds the limit");
});
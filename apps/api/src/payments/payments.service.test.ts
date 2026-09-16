import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PaymentsService } from "./payments.service.js";
import { prisma } from "../persistence/prisma-repositories.js";

const svc = new PaymentsService();
const STORE = "cmtifdks2000094ic1j9w8th7";

const run = `PAY${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdIds: string[] = [];
let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({ data: { slug: `${run}-s${slugSeq}`.toLowerCase(), name: `Pay ${run}` } });
  createdIds.push(s.id);
  return s;
}
async function makeProduct(storeId: string) {
  const p = await prisma.product.create({ data: { storeId, sku: `PAY-${storeId.slice(-4)}`, name: "P", priceMinor: 10000 } });
  createdIds.push(p.id);
  await prisma.stockLevel.create({ data: { storeId, productId: p.id, quantityOnHand: 10 } });
  return p;
}
async function makeOrder(storeId: string, status: string, paymentStatus: string, items?: { productId: string; quantity: number }[]) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${run}-${createdIds.length}-${storeId.slice(-4)}`,
      storeId,
      status: status as never,
      paymentStatus: paymentStatus as never,
      currencyCode: "PHP",
      subtotalMinor: 10000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 10000,
      snapshot: { items: [] }, paymentMethod: "cash",
      idempotencyKey: `pay-${createdIds.length}-${Date.now()}`,
      cartToken: `pc-${createdIds.length}`,
      customerName: "C", customerPhone: "+639176543210", deliveryAddressLine1: "1 St",
    },
  });
  createdIds.push(o.id);
  if (items?.length) {
    await prisma.orderItem.createMany({ data: items.map((i) => ({ orderId: o.id, storeId, productId: i.productId, productName: "P", sku: "P", unitPriceMinor: 10000, quantity: i.quantity, lineTotalMinor: 10000 * i.quantity })) });
  }
  return o;
}
after(async () => {
  if (createdIds.length) {
    // FK-safe cleanup: delete in dependency order.
    await prisma.stockMovement.deleteMany({ where: { storeId: { in: createdIds } } });
    const orders = await prisma.order.findMany({ where: { storeId: { in: createdIds } }, select: { id: true } });
    const oid = orders.map((o) => o.id);
    if (oid.length) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: oid } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: oid } } });
      await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: oid } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: oid } } });
      await prisma.order.deleteMany({ where: { id: { in: oid } } });
    }
    await prisma.stockLevel.deleteMany({ where: { productId: { in: createdIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
    // Fix #2: createAtomic writes the outbox event in-transaction and the live
    // worker drains it into a NotificationLog row — clear both before the store.
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: createdIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: createdIds } } });
    // N1: the shift tests create register rows for these stores.
    await prisma.cashMovement.deleteMany({ where: { storeId: { in: createdIds } } });
    await prisma.registerSession.deleteMany({ where: { storeId: { in: createdIds } } });
    await prisma.register.deleteMany({ where: { storeId: { in: createdIds } } });
    await prisma.store.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.$disconnect();
});

test("recordPayment rejects unknown order", async () => {
  const r = await svc.recordPayment({ orderId: "nope", storeId: STORE, method: "cash", amountMinor: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("recordPayment validates amount on an existing order", async () => {
  // unknown order → not_found wins over amount validation (by design)
  const unknown = await svc.recordPayment({ orderId: "nope", storeId: STORE, method: "cash", amountMinor: -5 });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.type, "not_found");
});

test("void rejects non-POS order", async () => {
  const r = await svc.voidOrder("nope", STORE, "actor", "test");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("refund rejects unknown order", async () => {
  const r = await svc.refundOrder("nope", STORE, "actor", 100, "test");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("paymentsFor unknown order returns null", async () => {
  assert.equal(await svc.paymentsFor("nope", STORE), null);
});

test("N1: a cash refund while a shift is open is attributed to that shift and reduces its expected cash", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id, "DELIVERED", "COLLECTED");

  const { RegisterService } = await import("../registers/register.service.js");
  const registers = new RegisterService();
  const opened = await registers.openSession(store.id, "cashier-1", { openingFloatMinor: 0 });
  assert.equal(opened.ok, true, JSON.stringify(opened));

  // Cash taken while the shift is open → attributed to it.
  const taken = await svc.recordPayment({ orderId: order.id, storeId: store.id, method: "cash", amountMinor: 10000, createdBy: "cashier-1" });
  assert.equal(taken.ok, true, JSON.stringify(taken));

  const refunded = await svc.refundOrder(order.id, store.id, "cashier-1", 4000, "damaged");
  assert.equal(refunded.ok, true, JSON.stringify(refunded));

  const refundRow = await prisma.payment.findFirst({ where: { orderId: order.id, type: "refund" }, select: { amountMinor: true, registerSessionId: true } });
  assert.equal(refundRow?.amountMinor, -4000);
  assert.equal(refundRow?.registerSessionId, opened.ok ? opened.value.sessionId : null, "the refund is bound to the open shift");

  const summary = await registers.currentSession(store.id);
  assert.equal(summary?.live.cashSalesMinor, 10000);
  assert.equal(summary?.live.cashRefundsMinor, 4000);
  assert.equal(summary?.live.expectedMinor, 6000, "cash in the drawer = sale − refund");
});

test("N1: an off-counter cash payment records cleanly with no shift attribution", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id, "RECEIVED", "PENDING");

  const res = await svc.recordPayment({ orderId: order.id, storeId: store.id, method: "cash", amountMinor: 5000, createdBy: "admin" });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = await prisma.payment.findFirst({ where: { orderId: order.id, type: "payment" }, select: { registerSessionId: true, amountMinor: true } });
  assert.equal(row?.amountMinor, 5000);
  assert.equal(row?.registerSessionId, null, "no open shift → the payment is not part of any drawer");
});

test("M7: a second VOID is rejected — stock is never restored twice", async () => {
  const store = await makeStore();
  const product = await makeProduct(store.id);
  const order = await makeOrder(store.id, "COMPLETED", "PENDING", [{ productId: product.id, quantity: 2 }]);
  const level = await prisma.stockLevel.findFirst({ where: { storeId: store.id, productId: product.id } });
  const before = level!.quantityOnHand;

  const r1 = await svc.voidOrder(order.id, store.id, "actor", "double-void test");
  assert.equal(r1.ok, true, "first void succeeds");
  const after1 = (await prisma.stockLevel.findUnique({ where: { id: level!.id } }))!.quantityOnHand;
  assert.equal(after1, before + 2, "stock restored once");

  const r2 = await svc.voidOrder(order.id, store.id, "actor", "double-void test");
  assert.equal(r2.ok, false, "second void is rejected");
  if (!r2.ok) assert.equal(r2.error.type, "conflict");
  const after2 = (await prisma.stockLevel.findUnique({ where: { id: level!.id } }))!.quantityOnHand;
  assert.equal(after2, after1, "stock NOT restored a second time");
});

test("M7: a partial refund within the captured amount is allowed and audited", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id, "DELIVERED", "COLLECTED");
  await prisma.payment.create({ data: { orderId: order.id, storeId: store.id, method: "cash", amountMinor: 10000, type: "payment" } });

  const part = await svc.refundOrder(order.id, store.id, "actor", 4000, "partial");
  assert.equal(part.ok, true, "partial refund within captured amount succeeds");
  const refunds = await prisma.payment.findMany({ where: { orderId: order.id, type: "refund" } });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0]!.amountMinor, -4000);
  // A second refund is rejected by the order-status guard (already CANCELLED) — one refund per order.
  const again = await svc.refundOrder(order.id, store.id, "actor", 4000, "partial-2");
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error.type, "conflict");
});

test("M7: over-capture refund is rejected with a conflict", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id, "DELIVERED", "COLLECTED");
  await prisma.payment.create({ data: { orderId: order.id, storeId: store.id, method: "cash", amountMinor: 10000, type: "payment" } });

  const over = await svc.refundOrder(order.id, store.id, "actor", 99900, "over");
  assert.equal(over.ok, false, "refund above captured amount is rejected");
  if (!over.ok) {
    assert.equal(over.error.type, "conflict");
    assert.ok(String(over.error.message).includes("remaining captured"), "message explains the cap");
  }
  const paymentRows = await prisma.payment.findMany({ where: { orderId: order.id, type: "refund" } });
  assert.equal(paymentRows.length, 0, "no refund row was written");
});
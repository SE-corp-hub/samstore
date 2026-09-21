// P4a: gateway payment links + webhook lifecycle (pending→received→reviewed→refunded)
// with idempotency and honest no-card-data. Uses the mock gateway + real Prisma.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { PaymentsService } from "./payments.service.js";

const svc = new PaymentsService();
const run = `P4A${Date.now()}${Math.floor(Math.random() * 1000)}`;
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

async function makeOrder(storeId: string) {
  const seq = await prisma.storeCounter.upsert({
    where: { storeId_kind: { storeId, kind: "ORDER_SEQ" } },
    update: { value: { increment: 1 } },
    create: { storeId, kind: "ORDER_SEQ", value: 1 },
  });
  return prisma.order.create({
    data: {
      orderNumber: `${run}-${storeId.slice(-5)}-${seq.value}`.toUpperCase(),
      storeId,
      status: "RECEIVED",
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: 10000,
      deliveryFeeMinor: 5000,
      discountMinor: 0,
      totalMinor: 15000,
      snapshot: {},
      paymentMethod: "paymongo",
      paymentStatus: "PENDING",
      idempotencyKey: `${run}-${slugSeq}-${seq.value}`,
      cartToken: "",
      customerName: "Buyer",
      customerPhone: "+63",
      deliveryAddressLine1: "",
    },
  });
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
      if (orderIds.length) {
        await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.notificationLog.deleteMany({ where: { storeId } });
      await prisma.outboxEvent.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.storeCounter.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort cleanup — a leftover row must not fail the run
    }
  }
  await prisma.$disconnect();
});

test("payment link creates a hosted-checkout session; no card data stored", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  const r = await svc.createGatewayPayment(order.id, store.id, "mock");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.value.checkoutUrl, /^https:\/\/checkout\.mock\.test\//);

  const payment = await prisma.payment.findUnique({ where: { id: r.value.paymentId } });
  assert.equal(payment?.gateway, "mock");
  assert.equal(payment?.checkoutSessionId, r.value.checkoutSessionId);
  assert.equal(payment?.status, "pending");
  assert.equal(payment?.amountMinor, 15000);
  assert.equal(payment?.proofData, null, "no card/proof data captured — gateway-hosted only");
});

test("lifecycle: pending → received (webhook) → reviewed → refunded, with history", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  const link = await svc.createGatewayPayment(order.id, store.id, "mock");
  assert.equal(link.ok, true);
  if (!link.ok) return;

  // 1. Gateway reports payment.paid → RECEIVED.
  const paid = await svc.handleGatewayWebhook("mock", "{}", "test-sig", {
    referenceId: order.id,
    idempotencyKey: "evt-paid-1",
    status: "paid",
  });
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  assert.equal(paid.value.processed, true);
  let o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.paymentStatus, "RECEIVED");
  const pay = await prisma.payment.findFirst({ where: { orderId: order.id } });
  assert.equal(pay?.status, "paid");

  // 2. Replay is idempotent.
  const replay = await svc.handleGatewayWebhook("mock", "{}", "test-sig", {
    referenceId: order.id,
    idempotencyKey: "evt-paid-1",
    status: "paid",
  });
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.value.processed, false);

  // 3. Operator reviews → REVIEWED.
  const reviewed = await svc.markPaymentReviewed(order.id, store.id, "user-1");
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.paymentStatus, "REVIEWED");

  // 4. Refund → REFUNDED.
  const refund = await svc.refundOrder(order.id, store.id, "user-1", 15000, "customer changed mind");
  assert.equal(refund.ok, true);
  if (!refund.ok) return;
  o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.status, "CANCELLED");
  assert.equal(o?.paymentStatus, "REFUNDED");

  const history = await svc.statusHistoryFor(order.id, store.id);
  const transitions = history.map((h) => h.toStatus);
  assert.ok(transitions.includes("RECEIVED"), "gateway transition recorded");
  assert.ok(transitions.includes("REVIEWED"), "review transition recorded");
  assert.ok(transitions.includes("REFUNDED"), "refund transition recorded");
  assert.equal(history.length, 3, "three status transitions total");
});

test("webhook signature is verified and bad payloads are rejected", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  const link = await svc.createGatewayPayment(order.id, store.id, "mock");
  assert.equal(link.ok, true);
  if (!link.ok) return;

  const badSig = await svc.handleGatewayWebhook("mock", "{}", "wrong-sig", { referenceId: order.id, idempotencyKey: "e", status: "paid" });
  assert.equal(badSig.ok, false);
  if (!badSig.ok) assert.equal(badSig.error.type, "unauthorized");

  const noPayload = await svc.handleGatewayWebhook("mock", "{}", "test-sig", { status: "paid" });
  assert.equal(noPayload.ok, false);
  if (!noPayload.ok) assert.equal(noPayload.error.type, "validation");

  // The order is still PENDING — nothing was applied.
  const o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.paymentStatus, "PENDING");
});

test("failed webhook marks the order FAILED", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  const link = await svc.createGatewayPayment(order.id, store.id, "mock");
  assert.equal(link.ok, true);
  if (!link.ok) return;

  const failed = await svc.handleGatewayWebhook("mock", "{}", "test-sig", {
    referenceId: order.id,
    idempotencyKey: "evt-failed-1",
    status: "failed",
  });
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  const o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.paymentStatus, "FAILED");
  const pay = await prisma.payment.findFirst({ where: { orderId: order.id } });
  assert.equal(pay?.status, "failed");
});
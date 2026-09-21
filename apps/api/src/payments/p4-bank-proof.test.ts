// P4b: bank-transfer proof upload (validated) + review queue + received→reviewed→refunded.
// Real Prisma, run-scoped fixtures.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { PaymentsService } from "./payments.service.js";

const svc = new PaymentsService();
const run = `P4B${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

// 1×1 transparent PNG (base64) — ~70 bytes, well under the 2 MB cap.
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA8FAAAADUlEQVQImWP9n4t4AAAAAElFTkSuQmCC";

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE", settings: { create: {} } },
  });
  createdStoreIds.push(s.id);
  return s;
}

async function makeOrder(storeId: string, paymentStatus: string = "PENDING") {
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
      subtotalMinor: 8000,
      deliveryFeeMinor: 2000,
      discountMinor: 0,
      totalMinor: 10000,
      snapshot: {},
      paymentMethod: "bank_transfer",
      paymentStatus: paymentStatus as never,
      idempotencyKey: `${run}-${slugSeq}-${seq.value}`,
      cartToken: "",
      customerName: "Buyer",
      customerPhone: "+63",
      deliveryAddressLine1: "",
    },
  });
}

async function makeBankTransferPayment(orderId: string, storeId: string) {
  return prisma.payment.create({
    data: { orderId, storeId, method: "bank_transfer", amountMinor: 10000, type: "payment", status: "pending" },
  });
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
      if (orderIds.length) {
        await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
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
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("submitting a valid proof marks the order RECEIVED and attaches the image", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  await makeBankTransferPayment(order.id, store.id);

  const r = await svc.submitBankProof(order.id, store.id, "user-1", PNG_1PX);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.status, "RECEIVED");

  const o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.paymentStatus, "RECEIVED");
  const pay = await prisma.payment.findFirst({ where: { orderId: order.id } });
  assert.equal(pay?.proofData, PNG_1PX);
  assert.equal(pay?.proofMime, "image/png");

  const queue = await svc.reviewQueue(store.id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.id, order.id);

  const history = await svc.statusHistoryFor(order.id, store.id);
  assert.ok(history.some((h) => h.toStatus === "RECEIVED" && h.reason?.includes("proof")));
});

test("invalid or oversized proofs are rejected and the order stays PENDING", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  await makeBankTransferPayment(order.id, store.id);

  const notImage = await svc.submitBankProof(order.id, store.id, "user-1", "data:image/png;base64,###");
  assert.equal(notImage.ok, false);
  if (!notImage.ok) assert.equal(notImage.error.type, "validation");

  const wrongMime = await svc.submitBankProof(order.id, store.id, "user-1", "data:text/plain;base64,aGVsbw==");
  assert.equal(wrongMime.ok, false);

  const huge = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`; // ~3 MB decoded
  const over = await svc.submitBankProof(order.id, store.id, "user-1", huge);
  assert.equal(over.ok, false);

  const o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.paymentStatus, "PENDING", "nothing applied on failure");
});

test("full lifecycle: proof → received → reviewed → refunded, and a second proof is a conflict", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  await makeBankTransferPayment(order.id, store.id);

  assert.equal((await svc.submitBankProof(order.id, store.id, "user-1", PNG_1PX)).ok, true);
  const reviewed = await svc.markPaymentReviewed(order.id, store.id, "user-1");
  assert.equal(reviewed.ok, true);
  const refund = await svc.refundOrder(order.id, store.id, "user-1", 10000, "proof mismatch");
  assert.equal(refund.ok, true);
  if (!refund.ok) return;

  const o = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(o?.status, "CANCELLED");
  assert.equal(o?.paymentStatus, "REFUNDED");

  const again = await svc.submitBankProof(order.id, store.id, "user-1", PNG_1PX);
  assert.equal(again.ok, false, "a refunded order cannot accept a new proof");
  if (!again.ok) assert.equal(again.error.type, "conflict");
});
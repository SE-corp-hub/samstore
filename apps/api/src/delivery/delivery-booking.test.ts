// P5b: courier bookings + delivery events + COD remittance ledger end-to-end (mock courier).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { DeliveryBookingService } from "./delivery-booking.service.js";
import { getCourier } from "./couriers.js";

const svc = new DeliveryBookingService();
const run = `P5B${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

function msgOf(error: { message?: string } | { errors?: string[] }): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("errors" in error && Array.isArray(error.errors)) return error.errors.join(", ");
  return "";
}

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
      status: "OUT_FOR_DELIVERY",
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: 8000,
      deliveryFeeMinor: 2000,
      discountMinor: 0,
      totalMinor: 10000,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: "PENDING",
      idempotencyKey: `${run}-${slugSeq}-${seq.value}`,
      cartToken: "",
      customerName: "Buyer",
      customerPhone: "+63",
      deliveryAddressLine1: "1 Main St",
    },
  });
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
      if (orderIds.length) {
        await prisma.courierRemittance.deleteMany({ where: { booking: { orderId: { in: orderIds } } } });
        await prisma.deliveryEvent.deleteMany({ where: { booking: { orderId: { in: orderIds } } } });
        await prisma.deliveryBooking.deleteMany({ where: { orderId: { in: orderIds } } });
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

test("mock courier: booking → tracking → events → COD remittance", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  const mock = getCourier("mock");
  assert.equal(mock.ready(), true, "mock courier is always ready");

  const b = await svc.createBooking(store.id, order.id, "mock", { codMinor: 10000 });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.match(b.value.trackingNumber ?? "", /^MOCK-/);
  assert.equal(b.value.status, "created");

  // Advance through the lifecycle.
  assert.equal((await svc.addEvent(store.id, b.value.id, "accepted")).ok, true);
  assert.equal((await svc.addEvent(store.id, b.value.id, "picked_up")).ok, true);
  assert.equal((await svc.addEvent(store.id, b.value.id, "delivered")).ok, true);

  // Terminal — no more events.
  const after = await svc.addEvent(store.id, b.value.id, "accepted");
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.type, "conflict");

  // COD remittance: partial then the rest, over-remit rejected.
  const r1 = await svc.remit(store.id, b.value.id!, 4000, "user-1", "first batch");
  assert.equal(r1.ok, true);
  const r2 = await svc.remit(store.id, b.value.id!, 6000, "user-1");
  assert.equal(r2.ok, true);
  const over = await svc.remit(store.id, b.value.id!, 1, "user-1");
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(msgOf(over.error), /outstanding COD/i);

  const list = await svc.list(store.id);
  assert.equal(list.length, 1);
  const row = list[0]!;
  assert.equal(row.status, "delivered");
  assert.equal(row.events.length, 4, "created + accepted + picked_up + delivered");
  assert.equal(row.remittances.length, 2);
  assert.equal(row.remittedMinor, 10000);
});

test("validation + tenant isolation", async () => {
  const store = await makeStore();
  const other = await makeStore();
  const order = await makeOrder(store.id);

  const badStatus = await svc.addEvent(store.id, "does-not-exist", "weird");
  assert.equal(badStatus.ok, false);

  const b = await svc.createBooking(store.id, order.id, "owner");
  assert.equal(b.ok, true);
  if (!b.ok) return;

  const badEvent = await svc.addEvent(store.id, b.value.id, "teleported");
  assert.equal(badEvent.ok, false);
  if (!badEvent.ok) assert.equal(badEvent.error.type, "validation");

  // Tenant isolation: store B cannot touch store A's booking.
  const cross = await svc.addEvent(other.id, b.value.id, "accepted");
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.error.type, "not_found");

  const remitCross = await svc.remit(other.id, b.value.id, 100, "user-9");
  assert.equal(remitCross.ok, false);

  // codMinor above the total is rejected.
  const overCod = await svc.createBooking(store.id, order.id, "mock", { codMinor: 999999 });
  assert.equal(overCod.ok, false);
  if (!overCod.ok) assert.equal(overCod.error.type, "validation");
});
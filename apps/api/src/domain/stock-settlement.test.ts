// Online checkout RESERVES stock (quantityReserved only — the units are still on
// the shelf). This module proves the other half of that lifecycle:
//   * fulfilment CONSUMES the reservation (on-hand + reserved both drop),
//   * cancellation RELEASES it (reserved only — the units stay on the shelf),
//   * POS/pre-orders (which consume on-hand at sale time) are never touched,
//   * settlement is tenant-scoped and settles at most once per order,
//   * the stock LEDGER still reconciles to the balance afterwards.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, PrismaOrderRepository } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import { settleOrderReservations, dispositionForOrderStatus } from "./stock-settlement.js";
import { OrderAdminService } from "../admin/order-admin.service.js";
import { DeliveryService } from "../delivery/delivery.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { reconcileStock } from "./reconcile.js";

const run = `SS${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const productIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const orders = await prisma.order.findMany({ where: { storeId: { in: storeIds } }, select: { id: true } });
    const orderIdList = orders.map((o) => o.id);
    if (orderIdList.length) {
      await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIdList } } });
      await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIdList } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIdList } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIdList } } });
      await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIdList } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIdList } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIdList } } });
    }
    await prisma.stockMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.productVariant.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.stockLevel.deleteMany({ where: { storeId: { in: storeIds } } });
    if (productIds.length) await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.warehouse.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.cashMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.registerSession.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.register.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

async function makeStore() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-s${seq}`.toLowerCase(), name: `SS ${run}` } });
  storeIds.push(store.id);
  return store;
}

async function makeProduct(storeId: string, onHand: number) {
  const product = await prisma.product.create({
    data: { storeId, sku: `SS-${randomId().slice(0, 6)}`, name: "SS Product", priceMinor: 10000 },
  });
  productIds.push(product.id);
  const level = await prisma.stockLevel.create({
    data: { storeId, productId: product.id, quantityOnHand: onHand, quantityReserved: 0 },
  });
  return { product, level };
}

/** A real online checkout: order + claim token + RESERVE movement, exactly as createAtomic writes it. */
async function reservedOnlineOrder(input: {
  storeId: string;
  productId: string;
  quantity: number;
  variantId?: string | null;
  deliveryType?: "delivery" | "pickup";
}) {
  const deliveryType = input.deliveryType ?? "delivery";
  const order = {
    id: randomId(),
    orderNumber: `SS-${randomId().slice(0, 8).toUpperCase()}`,
    storeId: input.storeId,
    status: "RECEIVED",
    currencyCode: "PHP",
    deliveryType,
    subtotalMinor: 10000,
    deliveryFeeMinor: 0,
    discountMinor: 0,
    totalMinor: 10000,
    snapshot: { lines: [] },
    paymentMethod: "cod",
    paymentStatus: "PENDING",
    idempotencyKey: `ss-${randomId()}`,
    cartToken: `ss-cart-${randomId()}`,
    customerName: "SS Buyer",
    customerPhone: "+639176543210",
    deliveryAddressLine1: deliveryType === "pickup" ? "" : "1 SS St",
    deliveryAddressLine2: null,
    landmark: null,
    deliverySchedule: null,
    notes: null,
    claimToken: `ss.${randomId()}`,
    items: [
      {
        productId: input.productId,
        productName: "SS Product",
        sku: "SS",
        unitPriceMinor: 10000,
        quantity: input.quantity,
        lineTotalMinor: 10000 * input.quantity,
      },
    ],
    storeCustomerId: null,
    createdAt: new Date(),
  };
  const created = await new PrismaOrderRepository().createAtomic(order, {
    stockReservations: [{ productId: input.productId, variantId: input.variantId ?? null, quantity: input.quantity }],
  });
  return created;
}

async function counters(levelId: string) {
  const level = await prisma.stockLevel.findUnique({ where: { id: levelId } });
  return { onHand: level?.quantityOnHand ?? -1, reserved: level?.quantityReserved ?? -1 };
}

test("dispositionForOrderStatus maps only fulfilment and cancellation", () => {
  assert.equal(dispositionForOrderStatus("DELIVERED"), "CONSUMED");
  assert.equal(dispositionForOrderStatus("COMPLETED"), "CONSUMED");
  assert.equal(dispositionForOrderStatus("CANCELLED"), "RELEASED");
  // Still in flight / retryable: the reservation must stay put.
  assert.equal(dispositionForOrderStatus("OUT_FOR_DELIVERY"), null);
  assert.equal(dispositionForOrderStatus("FAILED_DELIVERY"), null);
  assert.equal(dispositionForOrderStatus("RECEIVED"), null);
});

test("a delivered online order CONSUMES the reservation: on-hand and reserved both fall by the reserved quantity", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 5);
  const order = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 2 });
  assert.deepEqual(await counters(level.id), { onHand: 5, reserved: 2 }, "checkout reserved without touching on-hand");

  const delivery = new DeliveryService();
  const admin = new OrderAdminService();
  const confirmed = await admin.transition(store.id, order.id, "CONFIRMED");
  assert.equal(confirmed.ok, true);
  const sent = await admin.sendForDelivery(store.id, order.id);
  assert.equal(sent.ok, true, "one-tap dispatch is allowed");
  assert.deepEqual(await counters(level.id), { onHand: 5, reserved: 2 }, "dispatch does not settle the reservation");

  const delivered = await delivery.markStatus(store.id, order.id, "DELIVERED");
  assert.equal(delivered.ok, true, "courier can mark the delivery done");
  assert.deepEqual(await counters(level.id), { onHand: 3, reserved: 0 }, "the units physically left the store");

  const move = await prisma.stockMovement.findFirst({ where: { orderId: order.id, type: "CONSUME" } });
  assert.ok(move, "settlement appended a CONSUME movement");
  assert.equal(move?.delta, -2);
  assert.equal(move?.balanceAfter, 3);
  const row = await prisma.order.findUnique({ where: { id: order.id }, select: { stockDisposition: true } });
  assert.equal(row?.stockDisposition, "CONSUMED", "the order records how its reservation was settled");
});

test("a cancelled online order RELEASES the reservation and leaves the units on the shelf", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 4);
  const order = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 3 });

  const admin = new OrderAdminService();
  const cancelled = await admin.transition(store.id, order.id, "CANCELLED", "customer changed their mind");
  assert.equal(cancelled.ok, true);

  assert.deepEqual(await counters(level.id), { onHand: 4, reserved: 0 }, "reserved cleared, on-hand untouched");
  const moves = await prisma.stockMovement.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
  const types = moves.map((m) => m.type);
  assert.ok(!types.includes("CONSUME"), "a cancellation never consumes on-hand");
  assert.ok(types.includes("RELEASE_RESERVATION"), "the release is auditable in the ledger");
  const row = await prisma.order.findUnique({ where: { id: order.id }, select: { stockDisposition: true } });
  assert.equal(row?.stockDisposition, "RELEASED");
});

test("settlement is idempotent: a repeated call changes nothing", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 6);
  const order = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 1 });

  const first = await prisma.$transaction(async (tx) =>
    settleOrderReservations(tx, { id: order.id, storeId: store.id }, "CONSUMED"),
  );
  assert.equal(first.outcome, "applied");
  const second = await prisma.$transaction(async (tx) =>
    settleOrderReservations(tx, { id: order.id, storeId: store.id }, "CONSUMED"),
  );
  assert.equal(second.outcome, "already-settled", "the guarded claim rejects the second attempt");
  const third = await prisma.$transaction(async (tx) =>
    settleOrderReservations(tx, { id: order.id, storeId: store.id }, "RELEASED"),
  );
  assert.equal(third.outcome, "already-settled", "a cancellation cannot undo a fulfilment");

  assert.deepEqual(await counters(level.id), { onHand: 5, reserved: 0 }, "counters moved exactly once");
  const consumes = await prisma.stockMovement.count({ where: { orderId: order.id, type: "CONSUME" } });
  assert.equal(consumes, 1, "exactly one CONSUME movement in the ledger");
});

test("a POS order carries no reservation: settlement is a no-op", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 8);
  const posOrder = await prisma.order.create({
    data: {
      orderNumber: `SSPOS-${randomId().slice(0, 8).toUpperCase()}`,
      storeId: store.id,
      status: "COMPLETED",
      source: "pos",
      currencyCode: "PHP",
      subtotalMinor: 10000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 10000,
      snapshot: { lines: [] }, paymentMethod: "cash", paymentStatus: "COLLECTED",
      idempotencyKey: `ss-pos-${randomId()}`,
      cartToken: "",
      customerName: "Walk-in", customerPhone: "",
      deliveryAddressLine1: "", fulfillmentType: "PICKUP",
    },
  });
  // POS already consumed on-hand at sale time (deductStock), like the real flow.
  await prisma.stockLevel.update({ where: { id: level.id }, data: { quantityOnHand: { decrement: 2 } } });
  await prisma.stockMovement.create({
    data: { storeId: store.id, productId: product.id, warehouseId: null, delta: -2, type: "CONSUME", orderId: posOrder.id, createdBy: "test", balanceAfter: 6 },
  });

  const result = await prisma.$transaction(async (tx) =>
    settleOrderReservations(tx, { id: posOrder.id, storeId: store.id }, "CONSUMED"),
  );
  assert.equal(result.outcome, "no-reservation");
  assert.deepEqual(await counters(level.id), { onHand: 6, reserved: 0 }, "a counter sale is never settled twice");
  const row = await prisma.order.findUnique({ where: { id: posOrder.id }, select: { stockDisposition: true } });
  assert.equal(row?.stockDisposition, null, "orders without a reservation stay unmarked");
});

test("a variant reservation settles on the variant's own counters, not the product level", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 3);
  const variant = await prisma.productVariant.create({
    data: { storeId: store.id, productId: product.id, name: "5kg", sku: `SSV-${randomId().slice(0, 6)}`, priceMinor: 50000, quantityOnHand: 2, quantityReserved: 0 },
  });
  const order = await reservedOnlineOrder({ storeId: store.id, productId: product.id, variantId: variant.id, quantity: 2 });

  const fresh = await prisma.productVariant.findUnique({ where: { id: variant.id } });
  assert.equal(fresh?.quantityReserved, 2);

  await prisma.$transaction(async (tx) => settleOrderReservations(tx, { id: order.id, storeId: store.id }, "CONSUMED"));

  const afterVariant = await prisma.productVariant.findUnique({ where: { id: variant.id } });
  assert.equal(afterVariant?.quantityOnHand, 0);
  assert.equal(afterVariant?.quantityReserved, 0);
  assert.deepEqual(await counters(level.id), { onHand: 3, reserved: 0 }, "the product level is unrelated to a variant line");
});

test("a reservation split across two warehouse levels settles both legs once", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 4);
  const warehouse = await prisma.warehouse.create({ data: { storeId: store.id, name: "SS overflow" } });
  const second = await prisma.stockLevel.create({
    data: { storeId: store.id, productId: product.id, warehouseId: warehouse.id, quantityOnHand: 4, quantityReserved: 0 },
  });
  const order = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 2 });
  // A second reserve leg on the OTHER level (checkout allocates greedily and
  // prefers a warehouse level, so this exercises the aggregation that a split
  // allocation would produce).
  const bumped = await prisma.stockLevel.update({ where: { id: level.id }, data: { quantityReserved: { increment: 3 } } });
  await prisma.stockMovement.create({
    data: { storeId: store.id, productId: product.id, warehouseId: null, delta: 3, type: "RESERVE", orderId: order.id, createdBy: "test", balanceAfter: bumped.quantityReserved },
  });

  const result = await prisma.$transaction(async (tx) =>
    settleOrderReservations(tx, { id: order.id, storeId: store.id }, "RELEASED"),
  );
  assert.equal(result.outcome, "applied");
  assert.equal(result.lines, 2, "both reserved legs were settled");
  assert.deepEqual(await counters(level.id), { onHand: 4, reserved: 0 });
  const secondCounters = await counters(second.id);
  assert.deepEqual(secondCounters, { onHand: 4, reserved: 0 });
});

test("settlement is tenant-scoped: another store cannot settle the order", async () => {
  const owner = await makeStore();
  const intruder = await makeStore();
  const { product, level } = await makeProduct(owner.id, 5);
  const order = await reservedOnlineOrder({ storeId: owner.id, productId: product.id, quantity: 2 });

  const result = await prisma.$transaction(async (tx) =>
    settleOrderReservations(tx, { id: order.id, storeId: intruder.id }, "CONSUMED"),
  );
  assert.equal(result.outcome, "no-reservation", "the ledger is read through the caller's store scope");
  assert.deepEqual(await counters(level.id), { onHand: 5, reserved: 2 }, "the owner's counters are untouched");
});

test("voiding an online order releases the reservation instead of inflating on-hand", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 5);
  const order = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 2 });

  const result = await new PaymentsService().voidOrder(order.id, store.id, "owner-1", "customer cancelled");
  assert.equal(result.ok, true);
  assert.deepEqual(await counters(level.id), { onHand: 5, reserved: 0 }, "a void must not create phantom stock");
});

test("an online item edit is refused while the reservation is active; POS holds stay editable", async () => {
  const store = await makeStore();
  const { product, level } = await makeProduct(store.id, 9);
  const order = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 2 });

  const admin = new OrderAdminService();
  const refused = await admin.replaceOrderItems(store.id, order.id, [{ productId: product.id, quantity: 3 }]);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.type, "conflict");
  assert.deepEqual(await counters(level.id), { onHand: 9, reserved: 2 }, "the refused edit changed nothing");

  // A POS hold consumes on-hand at hold time and carries no reservation — the
  // existing net-delta edit path still works for it.
  const hold = await prisma.order.create({
    data: {
      orderNumber: `SSHOLD-${randomId().slice(0, 8).toUpperCase()}`,
      storeId: store.id,
      status: "ON_HOLD",
      source: "pos",
      currencyCode: "PHP",
      subtotalMinor: 10000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 10000,
      snapshot: { lines: [] }, paymentMethod: "cash", paymentStatus: "PENDING",
      idempotencyKey: `ss-hold-${randomId()}`,
      cartToken: "",
      customerName: "Walk-in", customerPhone: "",
      deliveryAddressLine1: "", fulfillmentType: "PICKUP",
    },
  });
  await prisma.orderItem.createMany({
    data: [{ orderId: hold.id, storeId: store.id, productId: product.id, productName: "SS Product", sku: "SS", unitPriceMinor: 10000, quantity: 2, lineTotalMinor: 20000 }],
  });
  await prisma.stockLevel.update({ where: { id: level.id }, data: { quantityOnHand: { decrement: 2 } } });
  const edited = await admin.replaceOrderItems(store.id, hold.id, [{ productId: product.id, quantity: 3 }]);
  assert.equal(edited.ok, true, "POS hold editing is unchanged");
  // The hold already consumed 2 units at hold time (7 on hand); editing to 3 nets
  // −1. The online order's reservation on the same level is untouched.
  assert.deepEqual(await counters(level.id), { onHand: 6, reserved: 2 });
});

test("the stock ledger still reconciles to the balance after a settlement", async () => {
  const store = await makeStore();
  const { product } = await makeProduct(store.id, 7);
  const consumed = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 3 });
  const released = await reservedOnlineOrder({ storeId: store.id, productId: product.id, quantity: 1 });

  await prisma.$transaction(async (tx) => settleOrderReservations(tx, { id: consumed.id, storeId: store.id }, "CONSUMED"));
  await prisma.$transaction(async (tx) => settleOrderReservations(tx, { id: released.id, storeId: store.id }, "RELEASED"));

  const drift = await reconcileStock({ storeId: store.id });
  assert.deepEqual(drift, [], "reserved-only movements must not look like on-hand drift");
});

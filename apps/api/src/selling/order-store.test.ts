// Per-store build, step 1b — Facebook and online orders follow their store, against the real DB.
//   * a Facebook order named for a store is a sale of THAT store on the day it is handed over
//     (delivered or picked up), not on the day it was placed: its cost is saved, a store that
//     sells the main store's rice owes the main store's cost once, and it is in that store's
//     daily report and Compare stores;
//   * cash on delivery is that store's cash, written once; a GCash payment still to be checked
//     stays in Payment review and writes no cash;
//   * an online order that names no store is the main store's, and rice it held on another
//     store's shelf books that store's profit share;
//   * an order changed after it was placed keeps its store's price;
//   * a refund takes back what the store owed for the sale.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma, PrismaCartRepository, PrismaCatalogRepository, PrismaOrderRepository, PrismaOrderSequenceRepository, PrismaStoreRepository } from "../persistence/prisma-repositories.js";
import { CheckoutService } from "../checkout/checkout.service.js";
import { HubOrderService, type HubOrderRequest } from "../integrations/hub-orders.service.js";
import { OrderAdminService } from "../admin/order-admin.service.js";
import { DeliveryService } from "../delivery/delivery.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { RiceReportsService } from "../reports/rice-reports.service.js";
import { StoreReportService } from "../reports/store-report.service.js";
import { manilaDate } from "../domain/reports.js";
import type { Actor } from "../people/people.service.js";

const run = `ORS${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;

const checkout = new CheckoutService(new PrismaStoreRepository(), new PrismaCatalogRepository(), new PrismaCartRepository(), new PrismaOrderRepository(), new PrismaOrderSequenceRepository(), "test-claim-secret-0123456789");
// The same two look-ups the app gives the hub door: a location by its code, and its own prices.
const hub = new HubOrderService(
  new PrismaStoreRepository(), new PrismaCatalogRepository(), new PrismaCartRepository(), checkout, undefined,
  async (storeId, code) => (await prisma.warehouse.findFirst({ where: { storeId, code: { equals: code.trim(), mode: "insensitive" }, isActive: true }, select: { id: true } }))?.id ?? null,
  async (storeId, warehouseId) => new Map((await prisma.locationPrice.findMany({ where: { storeId, warehouseId }, select: { productId: true, priceMinor: true } })).map((p) => [p.productId, p.priceMinor])),
);
const admin = new OrderAdminService();
const delivery = new DeliveryService();
const payments = new PaymentsService();
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const key = () => `hub-${randomBytes(8).toString("hex")}`;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    const cartIds = (await prisma.cart.findMany({ where, select: { id: true } })).map((c) => c.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.notificationLog.deleteMany({ where });
    if (orderIds.length) {
      await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    if (cartIds.length) await prisma.cartItem.deleteMany({ where: { cartId: { in: cartIds } } });
    await prisma.cart.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    // Checkout makes a customer from the phone number: remove the ones only these stores knew.
    const customerIds = (await prisma.storeCustomer.findMany({ where, select: { customerId: true } })).map((c) => c.customerId);
    await prisma.storeCustomer.deleteMany({ where });
    if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds }, storeProfiles: { none: {} } } });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/** A mobile number no customer has yet, so the cleanup never touches anyone else's customer. */
async function freshPhone(): Promise<string> {
  for (;;) {
    const d = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
    if (!(await prisma.customer.findFirst({ where: { phone: `+63918${d}` } }))) return `0918${d}`;
  }
}

/**
 * One business, three stores. Dinorado 25 kg costs ₱1,150: ₱1,300 at the main store, ₱1,350 at
 * Bahay Tindahan, ₱1,400 at Lipa. Bahay Tindahan and Lipa sell the main store's rice (consignment).
 * Shelves: main 10, Bahay Tindahan 20, Lipa 0.
 */
async function fixture() {
  seq += 1;
  const slug = `${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `Order stores ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const bt = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const lipa = await prisma.warehouse.create({ data: { storeId: store.id, name: "Lipa", code: "S3", type: "STORE", consignment: true } });
  const rice = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-D25`, name: "Dinorado 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  await prisma.locationPrice.createMany({ data: [
    { storeId: store.id, warehouseId: bt.id, productId: rice.id, priceMinor: 135_000 },
    { storeId: store.id, warehouseId: lipa.id, productId: rice.id, priceMinor: 140_000 },
  ] });
  await prisma.stockLevel.createMany({ data: [
    { storeId: store.id, productId: rice.id, warehouseId: main.id, quantityOnHand: 10 },
    { storeId: store.id, productId: rice.id, warehouseId: bt.id, quantityOnHand: 20 },
    { storeId: store.id, productId: rice.id, warehouseId: lipa.id, quantityOnHand: 0 },
  ] });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@ors.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  return { storeId: store.id, slug, main: main.id, bt: bt.id, lipa: lipa.id, riceId: rice.id, phone: await freshPhone(), owner: await mk("owner", "OWNER", null), rider: await mk("rider", "STAFF", bt.id) };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const shelf = async (fx: Fx, w: string) => {
  const l = await prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId, productId: fx.riceId, warehouseId: w } });
  return [l.quantityOnHand, l.quantityReserved];
};
const owes = async (fx: Fx, w: string) => (await prisma.storePayableEntry.aggregate({ where: { storeId: fx.storeId, locationId: w }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, payments: true } });
/** A Facebook order as the hub hands it over. */
const place = async (fx: Fx, quantity: number, more: Partial<HubOrderRequest> = {}) => {
  const r = await hub.place({
    storeSlug: fx.slug, idempotencyKey: key(), externalRef: "#1001", channel: "messenger", pageName: "Samrice", customerName: "Ana Cruz", customerPhone: fx.phone,
    deliveryType: "delivery", address: "Purok 3, Brgy. San Isidro", deliveryFeeMinor: 5_000, items: [{ name: "Dinorado 25 kg", quantity }], ...more,
  });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) throw new Error("hub order failed");
  return r.value;
};
/** Confirm it and send it out with the rider. */
const sendOut = async (fx: Fx, id: string) => {
  const c = await admin.transition(fx.storeId, id, "CONFIRMED", undefined, { type: "OWNER", id: fx.owner.userId });
  assert.equal(c.ok, true, msg(c));
  const s = await admin.sendForDelivery(fx.storeId, id);
  assert.equal(s.ok, true, msg(s));
};
const reports = async (fx: Fx) => {
  const today = manilaDate(new Date());
  const daily = await new RiceReportsService().daily(fx.storeId, fx.owner, { date: today });
  const cmp = await new StoreReportService().compare(fx.storeId, fx.owner, { from: today, to: today });
  assert.equal(daily.ok, true, msg(daily));
  assert.equal(cmp.ok, true, msg(cmp));
  if (!daily.ok || !cmp.ok) throw new Error("report failed");
  return {
    day: (id: string) => daily.value.sections.find((s) => s.location.id === id)!,
    row: (id: string) => cmp.value.stores.find((s) => s.location.id === id)!,
  };
};

test("a Facebook order for Bahay Tindahan, delivered for cash: that store's sale on the delivery day, its cost, its charge once, the rider's cash in its count", async () => {
  const fx = await fixture();
  const made = await place(fx, 2, { locationCode: "S2" });
  assert.equal(made.totalMinor, 2 * 135_000 + 5_000, "Bahay Tindahan's price plus the delivery fee");
  // Placed two days ago: a day that is already closed must not change when it is delivered today.
  await prisma.order.update({ where: { id: made.orderId }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
  assert.deepEqual([await shelf(fx, fx.bt), await shelf(fx, fx.main)], [[20, 2], [10, 0]], "held on Bahay Tindahan's shelf, not sold yet");
  assert.equal(await owes(fx, fx.bt), 0, "an order still on its way is not a sale");
  const before = await reports(fx);
  assert.equal(before.day(fx.bt).sales.count, 0);

  await sendOut(fx, made.orderId);
  const t0 = Date.now();
  const done = await delivery.markStatus(fx.storeId, made.orderId, "DELIVERED", undefined, { actor: fx.rider, cashCollectedMinor: 275_000 });
  assert.equal(done.ok, true, msg(done));
  const o = await order(made.orderId);
  assert.deepEqual([o.status, o.paymentStatus, o.sellingLocationId], ["DELIVERED", "COLLECTED", fx.bt]);
  assert.ok(o.occurredAt && o.occurredAt.getTime() >= t0 - 1000, "dated when it was handed over");
  assert.deepEqual(o.items.map((i) => [i.unitPriceMinor, i.unitCostMinor]), [[135_000, 115_000]], "the cost is saved with the sale");
  assert.deepEqual(o.payments.map((p) => [p.method, p.amountMinor, p.locationId, p.type]), [["cash", 275_000, fx.bt, "payment"]], "the rider's cash is Bahay Tindahan's");
  assert.deepEqual([await shelf(fx, fx.bt), await shelf(fx, fx.main)], [[18, 0], [10, 0]]);
  assert.equal(await owes(fx, fx.bt), 2 * 115_000, "Bahay Tindahan owes the main store's cost");

  // A second tap on Delivered changes nothing.
  const again = await delivery.markStatus(fx.storeId, made.orderId, "DELIVERED", undefined, { actor: fx.rider, cashCollectedMinor: 275_000 });
  assert.equal(again.ok, false);
  assert.equal(await owes(fx, fx.bt), 2 * 115_000);
  assert.equal(await prisma.payment.count({ where: { orderId: made.orderId } }), 1);

  const r = await reports(fx);
  assert.deepEqual([r.day(fx.bt).sales.count, r.day(fx.bt).sales.totalMinor, r.day(fx.bt).sales.cashMinor, r.day(fx.bt).sales.costMinor, r.day(fx.bt).cash.expectedMinor], [1, 275_000, 275_000, 230_000, 275_000]);
  assert.deepEqual([r.day(fx.main).sales.count, r.day(fx.lipa).sales.count, r.day(fx.main).cash.expectedMinor], [0, 0, 0]);
  assert.deepEqual([r.row(fx.bt).sales.totalMinor, r.row(fx.bt).owesMinor, r.row(fx.main).sales.totalMinor], [275_000, 230_000, 0]);

  // Returned later: the money goes back from that store, and it no longer owes for the sale.
  const back = await payments.refundOrder(made.orderId, fx.storeId, fx.owner.userId, undefined, "customer returned it");
  assert.equal(back.ok, true, msg(back));
  assert.equal(await owes(fx, fx.bt), 0);
  const refund = (await order(made.orderId)).payments.find((p) => p.type === "refund");
  assert.deepEqual([refund?.amountMinor, refund?.locationId], [-275_000, fx.bt]);
  assert.equal((await reports(fx)).day(fx.bt).sales.count, 0);
});

test("a Facebook pick-up order paid by GCash still to be checked: a sale when picked up, no cash written, the payment stays in review", async () => {
  const fx = await fixture();
  const made = await place(fx, 1, { locationCode: "S2", deliveryType: "pickup", address: undefined, deliveryFeeMinor: 0, paymentMethod: "gcash" });
  const done = await admin.completeNow(fx.storeId, made.orderId, fx.owner.userId);
  assert.equal(done.ok, true, msg(done));
  const o = await order(made.orderId);
  assert.deepEqual([o.status, o.paymentStatus, o.sellingLocationId, o.payments.length], ["COMPLETED", "RECEIVED", fx.bt, 0], "GCash is not cash, and it is not confirmed yet");
  assert.equal(await owes(fx, fx.bt), 115_000);
  const r = await reports(fx);
  assert.deepEqual([r.day(fx.bt).sales.count, r.day(fx.bt).sales.gcashMinor, r.day(fx.bt).sales.cashMinor, r.day(fx.bt).cash.expectedMinor], [1, 135_000, 0, 0]);
});

test("an order that names no store is the main store's; rice it held on Bahay Tindahan's shelf books Bahay Tindahan's profit share", async () => {
  const fx = await fixture();
  // 12 sacks, 10 on the main shelf: the main shelf first, the last 2 from another store's.
  await prisma.stockLevel.updateMany({ where: { storeId: fx.storeId, warehouseId: fx.lipa }, data: { quantityOnHand: 0 } });
  const made = await place(fx, 12, { deliveryType: "pickup", address: undefined, deliveryFeeMinor: 0 });
  assert.equal(made.totalMinor, 12 * 130_000, "the main price");
  assert.deepEqual([await shelf(fx, fx.main), await shelf(fx, fx.bt)], [[10, 10], [20, 2]]);
  assert.equal((await order(made.orderId)).sellingLocationId, null, "no store named");

  const done = await admin.transition(fx.storeId, made.orderId, "COMPLETED", undefined, { type: "OWNER", id: fx.owner.userId });
  assert.equal(done.ok, true, msg(done));
  const o = await order(made.orderId);
  assert.deepEqual([o.status, o.sellingLocationId], ["COMPLETED", fx.main], "it is the main store's sale");
  assert.deepEqual(o.payments.map((p) => [p.method, p.amountMinor, p.locationId]), [["cash", 12 * 130_000, fx.main]], "paid in cash at pick-up");
  assert.deepEqual([await shelf(fx, fx.main), await shelf(fx, fx.bt)], [[0, 0], [18, 0]]);
  assert.equal(await owes(fx, fx.main), 0, "the main store owes nobody for its own rice");
  // 2 sacks came from Bahay Tindahan's shelf: its profit on them (₱1,350 − ₱1,150 each) comes off what it owes.
  assert.equal(await owes(fx, fx.bt), -2 * 20_000);
  const r = await reports(fx);
  assert.deepEqual([r.day(fx.main).sales.count, r.day(fx.main).sales.totalMinor, r.day(fx.bt).sales.count], [1, 12 * 130_000, 0]);
});

test("paid at the counter and handed over (POS): the store's sale, with the counter payment and no second cash line", async () => {
  const fx = await fixture();
  const made = await place(fx, 1, { locationCode: "S2", deliveryType: "pickup", address: undefined, deliveryFeeMinor: 0 });
  const c = await admin.transition(fx.storeId, made.orderId, "CONFIRMED", undefined, { type: "OWNER", id: fx.owner.userId });
  assert.equal(c.ok, true, msg(c));
  const paid = await new PosService(new LoyaltyService()).completeHold(fx.storeId, fx.owner.userId, made.orderId, { paymentMethod: "cash", tenderedMinor: 135_000 });
  assert.equal(paid.ok, true, msg(paid));
  const o = await order(made.orderId);
  assert.deepEqual([o.status, o.sellingLocationId], ["COMPLETED", fx.bt]);
  assert.deepEqual(o.payments.filter((p) => p.type === "payment").map((p) => [p.method, p.amountMinor]), [["cash", 135_000]]);
  assert.equal(await owes(fx, fx.bt), 115_000);
  assert.deepEqual(await shelf(fx, fx.bt), [19, 0]);
  assert.equal((await reports(fx)).day(fx.bt).cash.expectedMinor, 135_000);
});

test("an order changed after it was placed keeps its store's price; the edit screen is told the store's prices", async () => {
  const fx = await fixture();
  const made = await place(fx, 1, { locationCode: "S2", deliveryFeeMinor: 0 });
  const seen = await admin.detail(fx.storeId, made.orderId);
  assert.deepEqual([seen?.sellingLocationName, seen?.storePrices], ["Bahay Tindahan", { [fx.riceId]: 135_000 }]);

  // 3 sacks now, no price sent: the usual price is Bahay Tindahan's, not the main price.
  const more = await admin.replaceOrderItems(fx.storeId, made.orderId, [{ productId: fx.riceId, quantity: 3 }], fx.owner.userId);
  assert.equal(more.ok, true, msg(more));
  const o = await order(made.orderId);
  assert.deepEqual([o.totalMinor, o.items.map((i) => [i.quantity, i.unitPriceMinor, i.priceOverridden])], [3 * 135_000, [[3, 135_000, false]]]);
  assert.deepEqual(await shelf(fx, fx.bt), [20, 3], "the hold follows the edit, on the same shelf");

  // The main price on a Bahay Tindahan order is a changed price: it needs its reason.
  const low = await admin.replaceOrderItems(fx.storeId, made.orderId, [{ productId: fx.riceId, quantity: 3, unitPriceMinorOverride: 130_000 }], fx.owner.userId);
  assert.equal(low.ok, false, "a price that is not the store's needs a reason");
});

test("a failed delivery is not a sale; cancelled, the rice is free again and nothing is owed", async () => {
  const fx = await fixture();
  const made = await place(fx, 2, { locationCode: "S2" });
  await sendOut(fx, made.orderId);
  const failed = await delivery.markStatus(fx.storeId, made.orderId, "FAILED_DELIVERY", "nobody home", { actor: fx.rider });
  assert.equal(failed.ok, true, msg(failed));
  assert.deepEqual([await shelf(fx, fx.bt), await owes(fx, fx.bt), await prisma.payment.count({ where: { orderId: made.orderId } })], [[20, 2], 0, 0]);
  const gone = await admin.transition(fx.storeId, made.orderId, "CANCELLED", "customer cancelled", { type: "OWNER", id: fx.owner.userId });
  assert.equal(gone.ok, true, msg(gone));
  assert.deepEqual([await shelf(fx, fx.bt), await owes(fx, fx.bt)], [[20, 0], 0]);
  assert.equal((await reports(fx)).day(fx.bt).sales.count, 0);
});

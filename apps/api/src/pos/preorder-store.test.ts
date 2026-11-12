// Per-store build, step 1a — pre-orders follow their store, against the real DB.
//   * a pre-order saves the store of the login that took it, at that store's price, and the rice
//     leaves that store's shelf (it may go below zero); the main store's shelf is not touched;
//   * a request with no store (an old copy of the app, or one saved offline) is never refused;
//   * completed, it is a sale of that store on that day: in the store's daily report and
//     Compare stores, its cash in the store's count, the cost saved on every line, and a store
//     that sells the main store's rice owes the main store's cost, once;
//   * another store's login cannot complete, change or cancel it; the owner can move it, the
//     rice follows and the agreed price stays.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { PosService } from "./pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { RiceReportsService } from "../reports/rice-reports.service.js";
import { StoreReportService } from "../reports/store-report.service.js";
import { manilaDate } from "../domain/reports.js";
import type { Actor } from "../people/people.service.js";

const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `PRS${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];
let seq = 0;

const pos = new PosService(new LoyaltyService());
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const key = () => `tap-${randomBytes(8).toString("hex")}`;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    if (orderIds.length) {
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/**
 * One business, three stores. Dinorado 25 kg costs ₱1,150: ₱1,300 at the main store, ₱1,350 at
 * Bahay Tindahan, ₱1,400 at Lipa. Bahay Tindahan and Lipa sell the main store's rice (consignment).
 * Shelves: main 10, Bahay Tindahan 20, Lipa 1.
 */
async function fixture() {
  seq += 1;
  const slug = `${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `Pre-order stores ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false, creditLimitMinor: 5_000_000, creditTermDays: 30 } });
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
    { storeId: store.id, productId: rice.id, warehouseId: lipa.id, quantityOnHand: 1 },
  ] });
  const customer = await prisma.customer.create({ data: { name: `Suki ${run} ${seq}`, phone: null, email: null, passwordHash: null } });
  customerIds.push(customer.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: customer.id, creditApproved: true, creditLimitMinor: 5_000_000 } });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@prs.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  return {
    storeId: store.id, main: main.id, bt: bt.id, lipa: lipa.id, riceId: rice.id, customerId: sc.id,
    owner: await mk("owner", "OWNER", null), btStaff: await mk("bt", "STAFF", bt.id), lipaStaff: await mk("lipa", "STAFF", lipa.id),
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const onHand = async (fx: Fx, w: string) => (await prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId, productId: fx.riceId, warehouseId: w } })).quantityOnHand;
const owes = async (fx: Fx, w: string) => (await prisma.storePayableEntry.aggregate({ where: { storeId: fx.storeId, locationId: w }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, payments: true } });
const take = async (fx: Fx, who: Actor | string, quantity: number, more: Record<string, unknown> = {}) => {
  const r = await pos.createPreOrder(fx.storeId, who, { customerId: fx.customerId, items: [{ productId: fx.riceId, quantity }], idempotencyKey: key(), ...more });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) throw new Error("pre-order failed");
  return r.value;
};

test("a store's login takes a pre-order: its store, its price, its shelf (below zero allowed), nothing owed yet", async () => {
  const fx = await fixture();
  // No store in the request: this is what an old copy of the app (or one saved offline) sends.
  const made = await take(fx, fx.lipaStaff, 3);
  const o = await order(made.orderId);
  assert.equal(o.sellingLocationId, fx.lipa, "saved at Lipa");
  assert.equal(o.status, "ON_HOLD");
  assert.equal(made.totalMinor, 3 * 140_000, "Lipa's price, not the main price");
  assert.deepEqual(o.items.map((i) => [i.unitPriceMinor, i.unitCostMinor, i.priceOverridden]), [[140_000, 115_000, false]]);
  assert.deepEqual([await onHand(fx, fx.lipa), await onHand(fx, fx.main), await onHand(fx, fx.bt)], [-2, 10, 20], "Lipa's shelf only (1 − 3)");
  assert.equal(await owes(fx, fx.lipa), 0, "a waiting pre-order is not a sale yet");

  // The same key again (a retry) is the same pre-order: the shelf does not move twice.
  const body = { customerId: fx.customerId, items: [{ productId: fx.riceId, quantity: 1 }], idempotencyKey: key() };
  const a = await pos.createPreOrder(fx.storeId, fx.lipaStaff, body);
  const b = await pos.createPreOrder(fx.storeId, fx.lipaStaff, body);
  assert.equal(a.ok && b.ok && a.value.orderId === b.value.orderId, true);
  assert.equal(await onHand(fx, fx.lipa), -3);
});

test("no store asked: the owner's pre-order is the main store's; asked: that store's; a store login cannot take one for another store", async () => {
  const fx = await fixture();
  const atMain = await take(fx, fx.owner, 1);
  assert.equal((await order(atMain.orderId)).sellingLocationId, fx.main);
  assert.equal(atMain.totalMinor, 130_000, "main price");
  // A bare user id (how older code called it) behaves like a login with no home store.
  const bare = await take(fx, "someone", 1);
  assert.equal((await order(bare.orderId)).sellingLocationId, fx.main);

  const atBt = await take(fx, fx.owner, 2, { locationId: fx.bt });
  assert.equal((await order(atBt.orderId)).sellingLocationId, fx.bt);
  assert.equal(atBt.totalMinor, 2 * 135_000, "Bahay Tindahan's price");
  assert.deepEqual([await onHand(fx, fx.main), await onHand(fx, fx.bt)], [8, 18]);

  const wrong = await pos.createPreOrder(fx.storeId, fx.lipaStaff, { customerId: fx.customerId, items: [{ productId: fx.riceId, quantity: 1 }], locationId: fx.bt });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.error.type, "forbidden");
  const unknown = await pos.createPreOrder(fx.storeId, fx.owner, { customerId: fx.customerId, items: [{ productId: fx.riceId, quantity: 1 }], locationId: "no-such-place" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.type, "validation");
  assert.deepEqual([await onHand(fx, fx.main), await onHand(fx, fx.bt), await onHand(fx, fx.lipa)], [8, 18, 1], "a refused pre-order moves nothing");
});

test("completed in cash: a sale of that store today — its report, its cash, its cost, and what it owes the main store, once", async () => {
  const fx = await fixture();
  const made = await take(fx, fx.lipaStaff, 2);
  // Made "yesterday": the sale still counts on the day it is completed.
  await prisma.order.update({ where: { id: made.orderId }, data: { createdAt: new Date(Date.now() - 86_400_000), occurredAt: new Date(Date.now() - 86_400_000) } });

  const body = { paymentMethod: "cash" as const, tenderedMinor: 300_000, idempotencyKey: key() };
  const done = await pos.finalizePreorder(fx.storeId, fx.lipaStaff, made.orderId, body);
  assert.equal(done.ok, true, msg(done));
  if (!done.ok) return;
  assert.equal(done.value.changeMinor, 20_000);
  const o = await order(made.orderId);
  assert.equal(o.status, "COMPLETED");
  assert.equal(o.sellingLocationId, fx.lipa);
  assert.ok(o.occurredAt && Date.now() - o.occurredAt.getTime() < 60_000, "dated at the moment it became a sale");
  assert.deepEqual(o.items.map((i) => i.unitCostMinor), [115_000]);
  assert.deepEqual(o.payments.map((p) => [p.method, p.amountMinor, p.locationId]), [["cash", 280_000, fx.lipa]]);
  assert.equal(await owes(fx, fx.lipa), 2 * 115_000, "Lipa owes the main store its cost for 2 sacks");
  assert.equal(await owes(fx, fx.bt), 0);

  // Sent again (saved offline, uploaded twice): the same answer, nothing charged twice.
  const again = await pos.finalizePreorder(fx.storeId, fx.lipaStaff, made.orderId, body);
  assert.equal(again.ok, true, msg(again));
  assert.equal(await owes(fx, fx.lipa), 2 * 115_000);
  assert.equal(await prisma.payment.count({ where: { orderId: made.orderId } }), 1);

  // Lipa's daily report and Compare stores both show it, at Lipa only.
  const today = manilaDate(new Date());
  const daily = await new RiceReportsService().daily(fx.storeId, fx.owner, { date: today });
  assert.equal(daily.ok, true, msg(daily));
  if (!daily.ok) return;
  const at = (id: string) => daily.value.sections.find((s) => s.location.id === id)!;
  assert.deepEqual([at(fx.lipa).sales.count, at(fx.lipa).sales.totalMinor, at(fx.lipa).sales.cashMinor, at(fx.lipa).sales.costMinor, at(fx.lipa).cash.expectedMinor], [1, 280_000, 280_000, 230_000, 280_000]);
  assert.deepEqual([at(fx.main).sales.count, at(fx.bt).sales.count, at(fx.main).cash.expectedMinor], [0, 0, 0]);
  const cmp = await new StoreReportService().compare(fx.storeId, fx.owner, { from: today, to: today });
  assert.equal(cmp.ok, true, msg(cmp));
  if (!cmp.ok) return;
  const row = (id: string) => cmp.value.stores.find((s) => s.location.id === id)!;
  assert.deepEqual([row(fx.lipa).sales.totalMinor, row(fx.lipa).owesMinor, row(fx.main).sales.totalMinor, row(fx.bt).sales.totalMinor], [280_000, 230_000, 0, 0]);
});

test("completed on credit: the store's sale and the store's charge; the main store's own pre-order owes nothing", async () => {
  const fx = await fixture();
  const made = await take(fx, fx.btStaff, 1);
  const done = await pos.finalizePreorder(fx.storeId, fx.btStaff, made.orderId, { signatureData: SIGNATURE });
  assert.equal(done.ok, true, msg(done));
  const o = await order(made.orderId);
  assert.deepEqual([o.status, o.paymentStatus, o.sellingLocationId], ["COMPLETED", "PENDING", fx.bt]);
  assert.equal(await owes(fx, fx.bt), 115_000);
  assert.equal((await prisma.creditEntry.findFirstOrThrow({ where: { orderId: made.orderId } })).amountMinor, 135_000);

  const own = await take(fx, fx.owner, 1);
  const paid = await pos.finalizePreorder(fx.storeId, fx.owner, own.orderId, { paymentMethod: "cash", tenderedMinor: 130_000 });
  assert.equal(paid.ok, true, msg(paid));
  assert.equal(await owes(fx, fx.main), 0, "the main store owes itself nothing");
  assert.equal(await prisma.storePayableEntry.count({ where: { storeId: fx.storeId, orderId: own.orderId } }), 0);
});

test("another store's login cannot complete, change or cancel it; the owner moves it, the rice follows, the price stays", async () => {
  const fx = await fixture();
  const made = await take(fx, fx.lipaStaff, 2);
  const items = { items: [{ productId: fx.riceId, quantity: 1 }] };
  for (const r of [
    await pos.finalizePreorder(fx.storeId, fx.btStaff, made.orderId, { paymentMethod: "cash", tenderedMinor: 280_000 }),
    await pos.replaceItems(fx.storeId, fx.btStaff, made.orderId, items, { source: "PRE_ORDER" }),
    await pos.voidHold(fx.storeId, fx.btStaff, made.orderId, "not mine"),
    await pos.movePreorder(fx.storeId, fx.btStaff, made.orderId, fx.bt),
  ]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.type, "forbidden", msg(r));
  }
  assert.match(msg(await pos.voidHold(fx.storeId, fx.btStaff, made.orderId)), /belongs to Lipa/);
  assert.deepEqual([(await order(made.orderId)).status, await onHand(fx, fx.lipa), await onHand(fx, fx.bt)], ["ON_HOLD", -1, 20], "nothing moved");

  const moved = await pos.movePreorder(fx.storeId, fx.owner, made.orderId, fx.bt);
  assert.equal(moved.ok, true, msg(moved));
  assert.deepEqual([await onHand(fx, fx.lipa), await onHand(fx, fx.bt), await onHand(fx, fx.main)], [1, 18, 10], "back on Lipa's shelf, taken from Bahay Tindahan's");
  const o = await order(made.orderId);
  assert.deepEqual([o.sellingLocationId, o.totalMinor, o.items[0]!.unitPriceMinor], [fx.bt, 280_000, 140_000], "the agreed price stays");
  assert.equal((await pos.movePreorder(fx.storeId, fx.owner, made.orderId, fx.bt)).ok, true, "moving it to where it is changes nothing");
  assert.equal(await onHand(fx, fx.bt), 18);

  // Now it is Bahay Tindahan's: its login completes it, and Bahay Tindahan (not Lipa) owes the cost.
  const done = await pos.finalizePreorder(fx.storeId, fx.btStaff, made.orderId, { paymentMethod: "cash", tenderedMinor: 280_000 });
  assert.equal(done.ok, true, msg(done));
  assert.deepEqual([await owes(fx, fx.bt), await owes(fx, fx.lipa)], [230_000, 0]);
  assert.equal((await pos.movePreorder(fx.storeId, fx.owner, made.orderId, fx.lipa)).ok, false, "a completed pre-order does not move");
});

test("changing a pre-order keeps its store's price and shelf; cancelling puts the rice back on that shelf", async () => {
  const fx = await fixture();
  const made = await take(fx, fx.lipaStaff, 1);
  const edited = await pos.replaceItems(fx.storeId, fx.lipaStaff, made.orderId, { items: [{ productId: fx.riceId, quantity: 4 }] }, { source: "PRE_ORDER" });
  assert.equal(edited.ok, true, msg(edited));
  if (!edited.ok) return;
  assert.equal(edited.value.totalMinor, 4 * 140_000, "still Lipa's price");
  assert.deepEqual([await onHand(fx, fx.lipa), await onHand(fx, fx.main)], [-3, 10]);
  assert.deepEqual((await order(made.orderId)).items.map((i) => [i.quantity, i.unitCostMinor]), [[4, 115_000]]);

  const gone = await pos.voidHold(fx.storeId, fx.lipaStaff, made.orderId, "customer cancelled");
  assert.equal(gone.ok, true, msg(gone));
  assert.deepEqual([await onHand(fx, fx.lipa), await onHand(fx, fx.main), await onHand(fx, fx.bt)], [1, 10, 20]);
  assert.equal(await owes(fx, fx.lipa), 0);
});

test("a completed pre-order that is voided takes the store's charge away and puts the rice back on its shelf", async () => {
  const fx = await fixture();
  const made = await take(fx, fx.btStaff, 2);
  assert.equal((await pos.finalizePreorder(fx.storeId, fx.btStaff, made.orderId, { signatureData: SIGNATURE })).ok, true);
  assert.equal(await owes(fx, fx.bt), 230_000);
  const voided = await new PaymentsService().voidOrder(made.orderId, fx.storeId, fx.owner.userId, "wrong customer");
  assert.equal(voided.ok, true, msg(voided));
  assert.equal(await owes(fx, fx.bt), 0);
  assert.deepEqual([await onHand(fx, fx.bt), await onHand(fx, fx.main)], [20, 10]);
});

test("the list: a store login sees its own store's pre-orders (and old ones with no store); the owner sees all, with the store's name", async () => {
  const fx = await fixture();
  const a = await take(fx, fx.lipaStaff, 1);
  const b = await take(fx, fx.btStaff, 1);
  const c = await take(fx, fx.owner, 1);
  // A pre-order from before stores were saved.
  await prisma.order.update({ where: { id: c.orderId }, data: { sellingLocationId: null } });

  const ids = async (who?: Actor) => (await pos.listPreorders(fx.storeId, undefined, undefined, who)).map((p) => p.id).sort();
  assert.deepEqual(await ids(fx.lipaStaff), [a.orderId, c.orderId].sort());
  assert.deepEqual(await ids(fx.btStaff), [b.orderId, c.orderId].sort());
  assert.deepEqual(await ids(fx.owner), [a.orderId, b.orderId, c.orderId].sort());
  assert.deepEqual(await ids(), [a.orderId, b.orderId, c.orderId].sort());
  const rows = await pos.listPreorders(fx.storeId, undefined, undefined, fx.owner);
  assert.deepEqual([rows.find((p) => p.id === a.orderId)!.locationName, rows.find((p) => p.id === c.orderId)!.locationName], ["Lipa", null]);

  // The old one takes the store of whoever completes it: here Bahay Tindahan.
  const done = await pos.finalizePreorder(fx.storeId, fx.btStaff, c.orderId, { paymentMethod: "cash", tenderedMinor: 130_000 });
  assert.equal(done.ok, true, msg(done));
  assert.equal((await order(c.orderId)).sellingLocationId, fx.bt);
  assert.equal(await owes(fx, fx.bt), 115_000);
});

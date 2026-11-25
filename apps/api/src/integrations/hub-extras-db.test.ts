// The SE Corp Hub link's database parts (hub-extras.ts), against the real DB:
//   * per-kilo items are the ones the Page is never offered;
//   * a hub order goes under its customer: the one the hub named, else the one with that mobile number (also when
//     known only at another store), else a new one; an order staff already put under a customer is left alone;
//   * a line the hub sold at another price than ours is marked as a changed price, with why and who;
//   * a price change from the hub goes through the same door as Orders → Change items;
//   * the selling days are the sales book's numbers, for the whole store and for each location.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { OrderAdminService } from "../admin/order-admin.service.js";
import { manilaDate } from "../domain/reports.js";
import { hubExtras } from "./hub-extras.js";

const run = `HEX${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const customerIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.expense.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.orderStatusHistory.deleteMany({ where });
    await prisma.orderItem.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    const mine = await prisma.storeCustomer.findMany({ where, select: { customerId: true } });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.customer.deleteMany({ where: { id: { in: [...customerIds, ...mine.map((m) => m.customerId)] } } });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

const extras = hubExtras(prisma, (storeId, orderId, items, actorId, role) => new OrderAdminService().replaceOrderItems(storeId, orderId, items, actorId, role));
/** A mobile number nobody else in the database has: 09 + nine digits from the clock and the count. */
const mobile = () => `09${String(Date.now() % 10_000_000).padStart(7, "0")}${String(++seq % 100).padStart(2, "0")}`;

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Hub extras ${seq}` } });
  storeIds.push(store.id);
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const ers = await prisma.warehouse.create({ data: { storeId: store.id, name: "Extra Rice Store", code: "S2", type: "STORE" } });
  const dino = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-D25`, name: "Dinorado 25kg", priceMinor: 150_000, costMinor: 125_000 } });
  const jas = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-J25`, name: "Jasmine 25kg", priceMinor: 140_000, costMinor: 0 } });
  const kilo = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-DK`, name: "Dinorado · per kilo", priceMinor: 6_200, costMinor: 5_000, stockBaseUnit: "g", stockBaseQuantity: 1 } });
  await prisma.stockLevel.createMany({
    data: [dino, jas].map((p) => ({ storeId: store.id, productId: p.id, warehouseId: ers.id, quantityOnHand: 50 })),
  });
  let n = 0;
  /** A hub order as checkout leaves it: lines at the price the Page told, nothing marked yet. */
  const order = async (lines: { p: typeof dino; quantity: number; price: number; cost?: number }[], over: Record<string, unknown> = {}) => {
    n += 1;
    const total = lines.reduce((t, l) => t + l.price * l.quantity, 0);
    const o = await prisma.order.create({
      data: {
        orderNumber: `${run}-${seq}-${n}`, storeId: store.id, status: "CONFIRMED", source: "hub", currencyCode: "PHP", subtotalMinor: total, totalMinor: total,
        snapshot: {}, idempotencyKey: `${run}-${seq}-${n}`, cartToken: "", customerName: "Maria Santos", customerPhone: "0917 000 0000", deliveryAddressLine1: "Purok 1",
        sellingLocationId: ers.id, ...over,
      },
    });
    for (const l of lines)
      await prisma.orderItem.create({ data: { storeId: store.id, orderId: o.id, productId: l.p.id, productName: l.p.name, sku: l.p.sku, unitPriceMinor: l.price, quantity: l.quantity, lineTotalMinor: l.price * l.quantity, ...(l.cost !== undefined ? { unitCostMinor: l.cost } : {}) } });
    return o;
  };
  const read = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { productName: "asc" } } } });
  return { storeId: store.id, main, ers, dino, jas, kilo, order, read };
}

test("only the per-kilo items are kept off the Page", async () => {
  const fx = await fixture();
  assert.deepEqual([...(await extras.kiloIds(fx.storeId))], [fx.kilo.id]);
});

test("a hub order goes under its customer: named by the hub, else found by mobile number, else made", async () => {
  const fx = await fixture();
  const other = await fixture();
  const info = (over: Record<string, unknown> = {}) => ({ customerName: "  Maria   Santos ", customerPhone: mobile(), address: "Purok 1, Bauan", repriced: [], ...over });

  // 1. The hub names this store's own customer.
  const known = await prisma.customer.create({ data: { name: "Maria Santos", phone: mobile(), email: null, passwordHash: null } });
  customerIds.push(known.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: fx.storeId, customerId: known.id } });
  const a = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }]);
  await extras.afterPlace(fx.storeId, a.orderNumber, info({ customerRef: sc.id }));
  assert.equal((await fx.read(a.id)).storeCustomerId, sc.id);

  // 2. No name from the hub, the same mobile number typed another way: the same customer, no double.
  const b = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }]);
  await extras.afterPlace(fx.storeId, b.orderNumber, info({ customerPhone: `+63 ${known.phone!.slice(1, 4)} ${known.phone!.slice(4)}` }));
  assert.equal((await fx.read(b.id)).storeCustomerId, sc.id);

  // 3. Another store's reference is not this store's customer; the person is known only at the other store: they
  //    join this store as the same person.
  const far = await prisma.customer.create({ data: { name: "Ana Cruz", phone: mobile(), email: null, passwordHash: null } });
  customerIds.push(far.id);
  const farSc = await prisma.storeCustomer.create({ data: { storeId: other.storeId, customerId: far.id } });
  const c = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }]);
  await extras.afterPlace(fx.storeId, c.orderNumber, info({ customerRef: farSc.id, customerName: "Ana Cruz", customerPhone: far.phone }));
  const joined = await prisma.storeCustomer.findFirstOrThrow({ where: { storeId: fx.storeId, customerId: far.id } });
  assert.equal((await fx.read(c.id)).storeCustomerId, joined.id);
  assert.equal(joined.addedVia, "ONLINE");
  assert.equal(joined.addedAtId, fx.ers.id, "added at the store the order sells from");

  // 4. Nobody has this number: a new customer, with the name tidied.
  const phone = mobile();
  const d = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }]);
  await extras.afterPlace(fx.storeId, d.orderNumber, info({ customerPhone: phone }));
  const made = await prisma.storeCustomer.findUniqueOrThrow({ where: { id: (await fx.read(d.id)).storeCustomerId! }, include: { customer: true } });
  assert.equal(made.customer.name, "Maria Santos");
  assert.equal(made.customer.phone, phone);
  assert.equal(made.customer.address, "Purok 1, Bauan");
  // Asked again (the hub offered the order twice): still one customer.
  await extras.afterPlace(fx.storeId, d.orderNumber, info({ customerPhone: phone }));
  assert.equal(await prisma.customer.count({ where: { phone } }), 1);

  // 5. Staff already put the order under someone: left alone. And no usable number: it stays a guest order.
  const e = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }], { storeCustomerId: sc.id });
  await extras.afterPlace(fx.storeId, e.orderNumber, info());
  assert.equal((await fx.read(e.id)).storeCustomerId, sc.id);
  const f = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }]);
  await extras.afterPlace(fx.storeId, f.orderNumber, info({ customerPhone: "none" }));
  assert.equal((await fx.read(f.id)).storeCustomerId, null);
  // An order that is not from the hub is never touched.
  const g = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }], { source: "pos" });
  await extras.afterPlace(fx.storeId, g.orderNumber, info());
  assert.equal((await fx.read(g.id)).storeCustomerId, null);
});

test("a line the hub sold at another price is marked as a changed price, with why and who, once", async () => {
  const fx = await fixture();
  const o = await fx.order([{ p: fx.dino, quantity: 2, price: 140_000 }, { p: fx.jas, quantity: 1, price: 140_000 }]);
  const info = { customerName: "Maria Santos", customerPhone: "none", repriced: [{ productId: fx.dino.id, catalogUnitPriceMinor: 150_000 }] };
  await extras.afterPlace(fx.storeId, o.orderNumber, { ...info, priceReason: "Suki, pays cash", priceBy: "owner" });
  const [dino, jas] = (await fx.read(o.id)).items;
  assert.equal(dino?.priceOverridden, true);
  assert.equal(dino?.priceOverrideReason, "Suki, pays cash (owner, SE Corp Hub)");
  assert.equal(dino?.catalogUnitPriceMinor, 150_000);
  assert.ok(dino?.priceOverriddenAt);
  assert.equal(jas?.priceOverridden, false, "sold at our own price: not a changed price");
  // Offered again without the reason: what is already written stays.
  await extras.afterPlace(fx.storeId, o.orderNumber, info);
  assert.equal((await fx.read(o.id)).items[0]?.priceOverrideReason, "Suki, pays cash (owner, SE Corp Hub)");
  // With no reason from the hub (a wholesale price, or our price changed in between): plain words.
  const p = await fx.order([{ p: fx.dino, quantity: 10, price: 145_000 }]);
  await extras.afterPlace(fx.storeId, p.orderNumber, info);
  assert.equal((await fx.read(p.id)).items[0]?.priceOverrideReason, "Price given on the Page (SE Corp Hub)");
});

test("a price change from the hub is done as on Orders → Change items, and the other lines keep their price", async () => {
  const fx = await fixture();
  // Jasmine was sold at 1,350 on the Page while our price is 1,400; nobody marked it (an order from before).
  const o = await fx.order([{ p: fx.dino, quantity: 2, price: 150_000 }, { p: fx.jas, quantity: 1, price: 135_000 }]);
  const ask = (items: { sku?: string; name?: string; unitPriceMinor: number }[], orderNumber = o.orderNumber) =>
    extras.change(fx.storeId, { orderNumber, items, reason: "Suki price", by: "lea", role: "manager" });

  assert.equal(await ask([{ sku: fx.dino.sku, name: "An old name", unitPriceMinor: 142_000 }]), null);
  const after1 = await fx.read(o.id);
  const [dino, jas] = after1.items;
  assert.equal(dino?.unitPriceMinor, 142_000);
  assert.equal(dino?.priceOverridden, true);
  assert.equal(dino?.priceOverrideReason, "Suki price (lea, SE Corp Hub)");
  assert.equal(dino?.catalogUnitPriceMinor, 150_000);
  assert.equal(jas?.unitPriceMinor, 135_000, "not put back to today's list price");
  assert.equal(jas?.priceOverrideReason, "Price given on the Page (SE Corp Hub)");
  assert.equal(after1.totalMinor, 2 * 142_000 + 135_000);

  // The same ask again (the answer was lost on the way): nothing to do, and nothing changes.
  assert.equal(await ask([{ sku: fx.dino.sku, unitPriceMinor: 142_000 }]), null);
  assert.equal((await fx.read(o.id)).updatedAt.getTime(), after1.updatedAt.getTime());

  // Why not, in words the hub shows.
  assert.equal(await ask([{ name: "Malagkit 25kg", unitPriceMinor: 100_000 }]), '"Malagkit 25kg" is not on this order in Sam Store now');
  assert.equal(await ask([{ sku: fx.dino.sku, unitPriceMinor: 140_000 }], "NO-SUCH-ORDER"), "Sam Store has no such order from the hub");
  await prisma.order.update({ where: { id: o.id }, data: { status: "COMPLETED" } });
  assert.match((await ask([{ sku: fx.dino.sku, unitPriceMinor: 140_000 }])) ?? "", /Cannot edit an order in COMPLETED/);
  // Never an order that did not come from the hub.
  const pos = await fx.order([{ p: fx.dino, quantity: 1, price: 150_000 }], { source: "pos" });
  assert.equal(await ask([{ sku: fx.dino.sku, unitPriceMinor: 140_000 }], pos.orderNumber), "Sam Store has no such order from the hub");
});

test("selling days: sales, cost, expenses and profit from the sales book, for the store and each location", async () => {
  const fx = await fixture();
  const now = new Date();
  const today = manilaDate(now);
  // A hub sale at Extra Rice Store with its cost frozen; a counter sale at the main store of an item with no cost.
  await fx.order([{ p: fx.dino, quantity: 2, price: 150_000, cost: 120_000 }], { status: "DELIVERED", occurredAt: now });
  await fx.order([{ p: fx.jas, quantity: 3, price: 140_000 }], { status: "COMPLETED", source: "pos", occurredAt: now, sellingLocationId: fx.main.id });
  // Not sold yet: counts nowhere.
  await fx.order([{ p: fx.dino, quantity: 5, price: 150_000 }]);
  await prisma.expense.createMany({
    data: [
      { storeId: fx.storeId, category: "transport", amountMinor: 20_000, spentAt: now, locationId: fx.ers.id },
      { storeId: fx.storeId, category: "rent", amountMinor: 50_000, spentAt: now },
      { storeId: fx.storeId, category: "other", amountMinor: 99_000, spentAt: now, voidedAt: now },
    ],
  });
  const days = await extras.days(fx.storeId, 3, now);
  assert.equal(days.filter((d) => d.location === "").length, 3, "every day has a row for the whole store, also a day with no sale");
  const of = (location: string) => days.find((d) => d.day === today && d.location === location);
  assert.deepEqual(of(""), {
    day: today, location: "", salesMinor: 300_000 + 420_000, costMinor: 240_000, expensesMinor: 70_000, profitMinor: 720_000 - 240_000 - 70_000,
    orders: 2, noCostUnits: 3, hubSalesMinor: 300_000, hubOrders: 1,
  });
  assert.deepEqual(of("S2"), { day: today, location: "S2", salesMinor: 300_000, costMinor: 240_000, expensesMinor: 20_000, profitMinor: 40_000, orders: 1, noCostUnits: 0, hubSalesMinor: 300_000, hubOrders: 1 });
  assert.deepEqual(of("S1"), { day: today, location: "S1", salesMinor: 420_000, costMinor: 0, expensesMinor: 0, profitMinor: 420_000, orders: 1, noCostUnits: 3, hubSalesMinor: 0, hubOrders: 0 });
  assert.equal(days[0]?.day, today, "today first");
});

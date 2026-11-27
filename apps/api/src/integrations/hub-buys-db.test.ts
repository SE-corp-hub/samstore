// What each customer bought here, for the SE Corp Hub's customer cards (hub-buys.ts), against the real DB:
//   * one line per customer whose own orders changed after the hub's point, oldest change first, at most the limit;
//   * the hub's own orders, cancelled, failed and held ones are not counted; only paid and handed over is "spent";
//   * a customer whose orders were all cancelled still gets a line (nothing bought), so the hub's point moves on;
//   * a changed order brings its customer back after the point.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { hubBuys } from "./hub-buys.js";

const run = `HBY${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const customerIds: string[] = [];

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.orderItem.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.product.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

const buys = hubBuys(prisma, () => new Date("2026-11-27T00:00:00.000Z"));

test("each buying customer's line: counter and delivered sales, not the hub's own or cancelled ones, oldest change first", async () => {
  const store = await prisma.store.create({ data: { slug: run.toLowerCase(), name: "Hub buys" } });
  storeIds.push(store.id);
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Extra Rice Store", code: "S2", type: "STORE", isDefault: true } });
  const dino = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-D25`, name: "Dinorado 25kg", priceMinor: 150_000, costMinor: 0 } });
  const kilo = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-DK`, name: "Dinorado · per kilo", priceMinor: 6_200, costMinor: 0, stockBaseUnit: "g", stockBaseQuantity: 1 } });
  const person = async (name: string, phone: string) => {
    const c = await prisma.customer.create({ data: { name, phone, email: null, passwordHash: null } });
    customerIds.push(c.id);
    return prisma.storeCustomer.create({ data: { storeId: store.id, customerId: c.id } });
  };
  const ana = await person("Ana Cruz", `09${String(Date.now() % 1e9).padStart(9, "0")}`);
  const ben = await person("Ben Reyes", `09${String((Date.now() + 7) % 1e9).padStart(9, "0")}`);
  let n = 0;
  const order = async (who: string, status: string, source: string, at: string, lines: { p: typeof dino; quantity: number; price: number; soldBy?: string; grams?: number }[]) => {
    n += 1;
    const total = lines.reduce((t, l) => t + l.price, 0);
    const o = await prisma.order.create({
      data: {
        orderNumber: `${run}-${n}`, storeId: store.id, status: status as never, source, currencyCode: "PHP", subtotalMinor: total, totalMinor: total,
        snapshot: {}, idempotencyKey: `${run}-${n}`, cartToken: "", customerName: "x", customerPhone: "x", deliveryAddressLine1: "x",
        sellingLocationId: s2.id, storeCustomerId: who, occurredAt: new Date(at),
      },
    });
    for (const l of lines)
      await prisma.orderItem.create({ data: { storeId: store.id, orderId: o.id, productId: l.p.id, productName: l.p.name, sku: l.p.sku, unitPriceMinor: l.price, quantity: l.quantity, lineTotalMinor: l.price, soldBy: l.soldBy ?? null, grams: l.grams ?? null } });
    return o;
  };
  // Ana: two counter sales and a delivered order count; the hub's own order, a cancelled and a held one don't.
  await order(ana.id, "COMPLETED", "pos", "2026-10-01T02:00:00.000Z", [{ p: dino, quantity: 2, price: 300_000 }]);
  await order(ana.id, "COMPLETED", "pos", "2026-10-15T02:00:00.000Z", [{ p: kilo, quantity: 5000, price: 31_000, soldBy: "KILO", grams: 5000 }, { p: dino, quantity: 1, price: 150_000 }]);
  await order(ana.id, "CONFIRMED", "online", "2026-11-20T02:00:00.000Z", [{ p: dino, quantity: 1, price: 150_000 }]);
  await order(ana.id, "DELIVERED", "hub", "2026-11-21T02:00:00.000Z", [{ p: dino, quantity: 9, price: 1_350_000 }]);
  await order(ana.id, "CANCELLED", "pos", "2026-11-22T02:00:00.000Z", [{ p: dino, quantity: 9, price: 1_350_000 }]);
  await order(ana.id, "ON_HOLD", "pos", "2026-11-23T02:00:00.000Z", [{ p: dino, quantity: 9, price: 1_350_000 }]);
  // Ben: only a cancelled order.
  await order(ben.id, "CANCELLED", "pos", "2026-11-24T02:00:00.000Z", [{ p: dino, quantity: 1, price: 150_000 }]);
  // A guest sale (no customer) is nobody's.
  await order(null as never, "COMPLETED", "pos", "2026-11-24T03:00:00.000Z", [{ p: dino, quantity: 1, price: 150_000 }]);

  const all = await buys(store.id, { at: "", id: "" }, 200);
  assert.deepEqual(all.map((b) => b.id), [ana.id, ben.id], "Ana's orders changed first");
  const [a, last] = all;
  assert.ok(a && last);
  assert.equal(a.places.length, 1, "all at S2");
  const s2line = a.places[0];
  assert.ok(s2line);
  assert.deepEqual([s2line.location, s2line.orders, s2line.paidOrders], ["S2", 3, 2]);
  assert.equal(s2line.firstAt, "2026-10-01T02:00:00.000Z");
  assert.equal(s2line.lastAt, "2026-11-20T02:00:00.000Z");
  assert.equal(s2line.spentMinor, 481_000, "the online order is not handed over yet");
  assert.deepEqual(s2line.recent.map((r) => [r.at.slice(0, 10), r.totalMinor, r.done]), [
    ["2026-10-01", 300_000, true],
    ["2026-10-15", 181_000, true],
    ["2026-11-20", 150_000, false],
  ]);
  assert.deepEqual(s2line.items, [
    { name: "Dinorado 25kg", kilo: false, total: 4, orders: 3 },
    { name: "Dinorado · per kilo", kilo: true, total: 5000, orders: 1 },
  ]);
  assert.deepEqual(last.places, [], "Ben bought nothing, but his line moves the point on");

  // The point moves on: nothing after the last line, one after the first, and the limit holds.
  assert.deepEqual(await buys(store.id, { at: last.changedAt, id: last.id }, 200), []);
  assert.deepEqual((await buys(store.id, { at: a.changedAt, id: a.id }, 200)).map((b) => b.id), [ben.id]);
  assert.deepEqual((await buys(store.id, { at: "", id: "" }, 1)).map((b) => b.id), [ana.id]);

  // Ana's online order is delivered: she comes back after the point, now with it spent.
  const online = await prisma.order.findFirstOrThrow({ where: { storeId: store.id, storeCustomerId: ana.id, source: "online" } });
  await prisma.order.update({ where: { id: online.id }, data: { status: "DELIVERED" } });
  const again = await buys(store.id, { at: last.changedAt, id: last.id }, 200);
  assert.deepEqual(again.map((b) => [b.id, b.places[0]?.spentMinor]), [[ana.id, 631_000]]);
});

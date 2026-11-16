// Soft launch: clearing a store's test activity keeps its setup, and never touches another store.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { ExpensesService } from "../expenses/expenses.service.js";
import type { Actor } from "../people/people.service.js";
import { CLEAR_TABLES, KEEP_TABLES, clearOrder, clearStoreActivity, exportStoreActivity, unclassifiedTables } from "./clear-store-activity.js";

const run = `clr${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];

after(async () => {
  for (const storeId of storeIds) await clearStoreActivity(storeId, { apply: true });
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.$disconnect();
});

const must = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

test("every store table is either cleared or kept, and lines go before what they belong to", () => {
  assert.deepEqual(unclassifiedTables(), []);
  assert.equal(new Set([...CLEAR_TABLES, ...KEEP_TABLES]).size, CLEAR_TABLES.length + KEEP_TABLES.length, "no table in both lists");
  const order = clearOrder();
  assert.deepEqual([...order].sort(), [...CLEAR_TABLES].sort());
  const before = (a: string, b: string) => assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  before("OrderItem", "Order");
  before("Payment", "Order");
  before("StockInLine", "StockIn");
  before("JournalEntryLine", "JournalEntry");
});

async function aStoreWithADay(name: string) {
  const store = await prisma.store.create({ data: { slug: `${run}-${name}`, name } });
  storeIds.push(store.id);
  const storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false } });
  const shelf = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const rice = await prisma.product.create({ data: { storeId, sku: `${run}-${name}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 115_000 } });
  await prisma.stockLevel.create({ data: { storeId, productId: rice.id, warehouseId: shelf.id, quantityOnHand: 10 } });
  const user = await prisma.user.create({ data: { email: `${run}-${name}@clear.test`, passwordHash: "x", name: "Lucy", role: "STORE_OWNER" } });
  userIds.push(user.id);
  await prisma.userStore.create({ data: { userId: user.id, storeId, role: "OWNER" } });
  const person = await prisma.customer.create({ data: { name: "Carmen" } });
  customerIds.push(person.id);
  const customer = await prisma.storeCustomer.create({ data: { storeId, customerId: person.id, creditBalanceMinor: 50_000, loyaltyBalancePoints: 7 } });
  const owner: Actor = { userId: user.id, role: "OWNER", homeLocationId: null };
  const sale = must(await new BentaService().sell(storeId, owner, { idempotencyKey: `tap-${randomBytes(8).toString("hex")}`, lines: [{ productId: rice.id, quantity: 2 }], payment: { method: "cash" } }));
  must(await new ExpensesService().create(storeId, owner, { category: "transport", amountMinor: 20_000 }));
  return { storeId, shelf, rice, customer, sale };
}

test("clearing the test day keeps the setup and leaves the other store alone", async () => {
  const a = await aStoreWithADay("a");
  const b = await aStoreWithADay("b");

  const preview = await clearStoreActivity(a.storeId);
  assert.equal(preview.applied, false);
  assert.ok(preview.rows.Order! >= 1 && preview.rows.Expense! >= 1 && preview.rows.StockLevel! >= 1 && preview.rows.StockMovement! >= 1);
  assert.equal(await prisma.order.count({ where: { storeId: a.storeId } }), preview.rows.Order, "a preview removes nothing");

  const copy = await exportStoreActivity(a.storeId);
  assert.equal(copy.Order!.length, preview.rows.Order);

  const done = await clearStoreActivity(a.storeId, { apply: true });
  assert.equal(done.total, preview.total);
  assert.equal((await clearStoreActivity(a.storeId)).total, 0, "nothing of the test day is left");

  // The setup is still there, with its totals back at zero.
  const kept = await prisma.storeCustomer.findUniqueOrThrow({ where: { id: a.customer.id } });
  assert.deepEqual([kept.customerId, kept.creditBalanceMinor, kept.loyaltyBalancePoints], [a.customer.customerId, 0, 0]);
  const rice = await prisma.product.findUniqueOrThrow({ where: { id: a.rice.id } });
  assert.deepEqual([rice.name, rice.priceMinor, rice.costMinor], ["Sinandomeng 25 kg", 130_000, 115_000]);
  assert.equal(await prisma.warehouse.count({ where: { storeId: a.storeId } }), 1);
  assert.equal(await prisma.userStore.count({ where: { storeId: a.storeId } }), 1);

  // Store B is untouched.
  assert.equal(await prisma.order.count({ where: { storeId: b.storeId } }), 1);
  assert.equal((await prisma.stockLevel.findFirstOrThrow({ where: { storeId: b.storeId } })).quantityOnHand, 8);
  assert.equal((await prisma.storeCustomer.findUniqueOrThrow({ where: { id: b.customer.id } })).creditBalanceMinor, 50_000);
  assert.ok((await clearStoreActivity(b.storeId)).total > 0);

  // Selling again after the clear works and the order number keeps counting up.
  const owner = await prisma.userStore.findFirstOrThrow({ where: { storeId: a.storeId } });
  await prisma.stockLevel.create({ data: { storeId: a.storeId, productId: a.rice.id, warehouseId: a.shelf.id, quantityOnHand: 5 } });
  const again = must(await new BentaService().sell(a.storeId, { userId: owner.userId, role: "OWNER", homeLocationId: null }, { idempotencyKey: `tap-${randomBytes(8).toString("hex")}`, lines: [{ productId: a.rice.id, quantity: 1 }], payment: { method: "cash" } }));
  assert.notEqual(again.orderNumber, a.sale.orderNumber);
});

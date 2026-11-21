// 2026-11-21 — a new customer or item keeps the store it was made at, who made it and the screen, against the real DB.
// One business with four places: Bogs and Lucy (main), Bahay Tindahan, Lipa, Bodega. An owner and a Lipa counter login.
//   * POS sale with a new name typed with no internet (sent later) → made at the sale's store, "POS", by the counter;
//   * POS "New customer" (quick-customer) → the store the screen names, never the main store by mistake;
//   * Pre-order with a new name → made at the pre-order's store, "PREORDER";
//   * the same name again (another store, a resend) → the same customer, which keeps where it was FIRST made;
//   * a name saved with no mobile, typed again with a mobile → the same customer gets the mobile (no second "Maria");
//   * Credit "Add customer" → the login's store, "CREDIT";
//   * a counter "New item" → made at that store, waits for the owner's check; the owner's own is ready;
//   * Products and Customers lists show the store name, the screen and who; "Unknown" rows have none.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { UtangService } from "../utang/utang.service.js";
import { ProductAdminService } from "../admin/product-admin.service.js";
import type { Actor } from "../people/people.service.js";
import { addedAtStore, addedTagReader, counterItemVia } from "./added-where.js";
import { findOrMakeQuickCustomer } from "../pos/quick-customer.js";

const run = `ADW${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;
const benta = new BentaService();
const pos = new PosService(new LoyaltyService());
const products = new ProductAdminService();
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
let k = 0;
const key = () => `${run}-key-${++k}`;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const customerIds = (await prisma.storeCustomer.findMany({ where, select: { customerId: true } })).map((c) => c.customerId);
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.notificationLog.deleteMany({ where });
    await prisma.stockInLine.deleteMany({ where });
    await prisma.stockIn.deleteMany({ where });
    if (orderIds.length) {
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.creditEntry.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.priceHistory.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.category.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
    if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Added ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE" } });
  const s3 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Lipa", code: "S3", type: "STORE" } });
  const rice = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-D25`, name: "Dinorado 25 kg", priceMinor: 130_000, costMinor: 115_000, unit: "sako", stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  await prisma.stockLevel.createMany({ data: [s1, s2, s3].map((w) => ({ storeId: store.id, productId: rice.id, warehouseId: w.id, quantityOnHand: 10 })) });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@adw.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  return { storeId: store.id, s1: s1.id, s2: s2.id, s3: s3.id, riceId: rice.id, owner: await mk("Owner Sam", "OWNER", null), lipa: await mk("Juan", "STAFF", s3.id) };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const customerNamed = (fx: Fx, name: string) => prisma.storeCustomer.findMany({ where: { storeId: fx.storeId, customer: { name } }, include: { customer: true } });

test("POS sale with a new name sent later: the customer is made at the sale's store, by the counter, on POS", async () => {
  const fx = await fixture();
  const sale = await benta.sell(fx.storeId, fx.lipa, { idempotencyKey: key(), locationId: fx.s3, lines: [{ productId: fx.riceId, quantity: 1 }], payment: { method: "cash", tenderedMinor: 130_000 }, newCustomerName: "Aling Nena" });
  assert.equal(sale.ok, true, msg(sale));
  const rows = await customerNamed(fx, "Aling Nena");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.addedAtId, rows[0]!.addedById, rows[0]!.addedVia], [fx.s3, fx.lipa.userId, "POS"]);
});

test("Pre-order with a new name: made at the pre-order's store, on Pre-order", async () => {
  const fx = await fixture();
  const pre = await pos.createPreOrder(fx.storeId, fx.owner, { customerName: "Mang Tonyo", items: [{ productId: fx.riceId, quantity: 1 }], idempotencyKey: key(), locationId: fx.s2 });
  assert.equal(pre.ok, true, msg(pre));
  const rows = await customerNamed(fx, "Mang Tonyo");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.addedAtId, rows[0]!.addedById, rows[0]!.addedVia], [fx.s2, fx.owner.userId, "PREORDER"]);
});

test("The same name again (another store, or a resend) is the same customer and keeps where it was first made", async () => {
  const fx = await fixture();
  const a = await findOrMakeQuickCustomer(fx.storeId, "Liza", null, { locationId: fx.s3, userId: fx.lipa.userId, via: "POS" });
  const b = await findOrMakeQuickCustomer(fx.storeId, "  liza ", null, { locationId: fx.s1, userId: fx.owner.userId, via: "PREORDER" });
  assert.equal(a, b);
  const row = await prisma.storeCustomer.findUniqueOrThrow({ where: { id: a! } });
  assert.deepEqual([row.addedAtId, row.addedVia], [fx.s3, "POS"]);
});

test("A name saved with no mobile, typed again with a mobile: the same customer gets the mobile (no second one)", async () => {
  const fx = await fixture();
  const first = await findOrMakeQuickCustomer(fx.storeId, "Maria Santos", null, { locationId: fx.s3, userId: fx.lipa.userId, via: "POS" });
  const again = await findOrMakeQuickCustomer(fx.storeId, "Maria Santos", `+63917${String(Date.now()).slice(-7)}`, { locationId: fx.s1, userId: fx.owner.userId, via: "POS" });
  assert.equal(again, first);
  const rows = await customerNamed(fx, "Maria Santos");
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.customer.phone);
  // A different person with the same name AND another mobile stays their own customer.
  const other = await findOrMakeQuickCustomer(fx.storeId, "Maria Santos", `+63918${String(Date.now()).slice(-7)}`, { locationId: fx.s2, userId: fx.owner.userId, via: "POS" });
  assert.notEqual(other, first);
});

test("Where a screen says it is: a counter login can only tag its own store; the owner with none named is no store", async () => {
  const fx = await fixture();
  assert.equal(await addedAtStore(fx.storeId, fx.lipa, fx.s1), fx.s3); // not allowed at Bogs and Lucy → its own Lipa
  assert.equal(await addedAtStore(fx.storeId, fx.lipa, undefined), fx.s3);
  assert.equal(await addedAtStore(fx.storeId, fx.owner, fx.s2), fx.s2);
  assert.equal(await addedAtStore(fx.storeId, fx.owner, undefined), null); // never guessed as the main store
  const other = await fixture();
  assert.equal(await addedAtStore(fx.storeId, fx.owner, other.s2), null); // another business's store
});

test("Credit 'Add customer': made at the login's store, on Credit", async () => {
  const fx = await fixture();
  const r = await new UtangService().addCustomer(fx.storeId, fx.lipa, { name: "Pedro Cruz", phone: `0919${String(Date.now()).slice(-7)}` });
  assert.equal(r.ok, true, msg(r));
  const rows = await customerNamed(fx, "Pedro Cruz");
  assert.deepEqual([rows[0]!.addedAtId, rows[0]!.addedById, rows[0]!.addedVia], [fx.s3, fx.lipa.userId, "CREDIT"]);
});

test("Counter 'New item': made at that store; the counter's waits for the owner's check, the owner's is ready", async () => {
  const fx = await fixture();
  const sig = [{ signerKind: "STAFF" as const, imagePng: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==" }];
  const staffItem = await benta.manualItem(fx.storeId, fx.lipa, { name: "Jasmine 25 kg", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 150_000, costMinor: 120_000, openingQty: 2, locationId: fx.s3, signatures: sig });
  assert.equal(staffItem.ok, true, msg(staffItem));
  const ownerItem = await benta.manualItem(fx.storeId, fx.owner, { name: "Coco Pandan 25 kg", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 160_000, costMinor: 130_000, openingQty: 0, noOpeningStock: true, locationId: fx.s2, via: "PREORDER" });
  assert.equal(ownerItem.ok, true, msg(ownerItem));
  const a = await prisma.product.findUniqueOrThrow({ where: { id: staffItem.ok ? staffItem.value.productId : "" } });
  const b = await prisma.product.findUniqueOrThrow({ where: { id: ownerItem.ok ? ownerItem.value.productId : "" } });
  assert.deepEqual([a.addedAtId, a.createdById, a.addedVia, a.reviewStatus], [fx.s3, fx.lipa.userId, "POS", "FOR_REVIEW"]);
  assert.deepEqual([b.addedAtId, b.createdById, b.addedVia, b.reviewStatus], [fx.s2, fx.owner.userId, "PREORDER", "ACTIVE"]);

  // Products shows the store, the screen and who; "Check" until the owner confirms.
  const list = await products.listFiltered(fx.storeId, {});
  const row = list.find((p) => p.id === a.id)!;
  assert.deepEqual([row.addedAt?.name, row.addedVia, row.addedBy, row.toCheck], ["Lipa", "POS", "Juan", true]);
  const old = list.find((p) => p.id === fx.riceId)!;
  assert.deepEqual([old.addedAt, old.addedVia, old.toCheck], [null, null, false]); // made before: "Unknown"
  assert.equal(await products.markChecked(fx.storeId, a.id, fx.owner.userId), true);
  assert.equal(await products.markChecked(fx.storeId, a.id, fx.owner.userId), false); // already checked
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).reviewStatus, "ACTIVE");
  // Still sells while it waits: the counter list kept it.
  const cat = await benta.catalog(fx.storeId, fx.lipa, fx.s3);
  assert.equal(cat.ok, true, msg(cat));
});

test("Products 'New product' is made at the store its stock goes to; the Customers list shows each customer's tag", async () => {
  const fx = await fixture();
  const made = await products.create(fx.storeId, { name: "Malagkit 25 kg", sku: `${run}-${seq}-M25`, priceMinor: 140_000, stock: 5, stockLocationId: fx.s2 }, fx.owner.userId, { locationId: fx.s2, userId: fx.owner.userId, via: "PRODUCTS" });
  assert.equal(made.ok, true, msg(made));
  const p = await prisma.product.findUniqueOrThrow({ where: { id: made.ok ? made.value.id : "" } });
  assert.deepEqual([p.addedAtId, p.addedVia, p.createdById], [fx.s2, "PRODUCTS", fx.owner.userId]);

  await findOrMakeQuickCustomer(fx.storeId, "Bert", null, { locationId: fx.s3, userId: fx.lipa.userId, via: "POS" });
  const rows = await new LoyaltyService().adminCustomers(fx.storeId, { search: "Bert" });
  const tagOf = await addedTagReader(fx.storeId, rows);
  assert.deepEqual(tagOf(rows[0]!), { addedAt: { id: fx.s3, name: "Lipa" }, addedVia: "POS", addedBy: "Juan" });
  assert.deepEqual(tagOf({}), { addedAt: null, addedVia: null, addedBy: null });
  assert.equal(counterItemVia("PREORDER"), "PREORDER");
  assert.equal(counterItemVia("IMPORT"), "POS"); // a counter screen can't claim another source
});

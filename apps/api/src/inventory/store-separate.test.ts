// 2026-11-21 — each store's stock stays its own, against the real DB.
// One business with four places: Bogs and Lucy (main), Bahay Tindahan, Lipa, Bodega. Every way
// stock is changed by hand or sold through the old POS door must say which store it changes, and a
// login tied to one store can never change another store's shelf.
//   * Inventory → Adjust always names the store (no store = refused; it never lands on the main store);
//   * a new rice's opening stock goes to the store the form names; its reorder level is the main store's;
//   * each store has its own reorder level;
//   * the old POS sale and hold take rice from the login's own store, not the main store;
//   * a login tied to Lipa cannot sell or hold at Bogs and Lucy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { InventoryService } from "./inventory.service.js";
import { ProductAdminService } from "../admin/product-admin.service.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";

const run = `SEP${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;
const inv = new InventoryService();
const products = new ProductAdminService();
const pos = new PosService(new LoyaltyService());
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.notificationLog.deleteMany({ where });
    if (orderIds.length) {
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
    await prisma.priceHistory.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.category.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/** Four places, Dinorado 25 kg with 10 sacks at each. An owner, a Lipa counter, a Bahay Tindahan counter. */
async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Separate ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE" } });
  const s3 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Lipa", code: "S3", type: "STORE" } });
  const wh = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bodega", code: "WH", type: "WAREHOUSE" } });
  const rice = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-D25`, name: "Dinorado 25 kg", priceMinor: 130_000, costMinor: 115_000 } });
  await prisma.stockLevel.createMany({ data: [s1, s2, s3, wh].map((w) => ({ storeId: store.id, productId: rice.id, warehouseId: w.id, quantityOnHand: 10 })) });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null) => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@sep.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return u.id;
  };
  return {
    storeId: store.id, s1: s1.id, s2: s2.id, s3: s3.id, wh: wh.id, riceId: rice.id,
    owner: await mk("owner", "OWNER", null), lipa: await mk("lipa", "STAFF", s3.id), bahay: await mk("bahay", "STAFF", s2.id),
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const shelves = async (fx: Fx, productId = fx.riceId) => {
  const rows = await prisma.stockLevel.findMany({ where: { storeId: fx.storeId, productId } });
  const at = (w: string) => rows.find((r) => r.warehouseId === w);
  return { s1: at(fx.s1)?.quantityOnHand ?? null, s2: at(fx.s2)?.quantityOnHand ?? null, s3: at(fx.s3)?.quantityOnHand ?? null, wh: at(fx.wh)?.quantityOnHand ?? null };
};

test("Adjust: no store named is refused, and it never lands on the main store", async () => {
  const fx = await fixture();
  const none = await inv.adjust(fx.storeId, fx.owner, { productId: fx.riceId, delta: 3, reason: "Found 3 more" });
  assert.equal(none.ok, false);
  assert.equal(none.ok === false && none.error.type, "validation");
  assert.deepEqual(await shelves(fx), { s1: 10, s2: 10, s3: 10, wh: 10 });
});

test("Adjust at each store changes that store only, and the stock book names it", async () => {
  const fx = await fixture();
  for (const [w, d] of [[fx.s1, 1], [fx.s2, -2], [fx.s3, 3], [fx.wh, -4]] as const) {
    const r = await inv.adjust(fx.storeId, fx.owner, { productId: fx.riceId, warehouseId: w, delta: d, reason: "Recount" });
    assert.equal(r.ok, true, msg(r));
  }
  assert.deepEqual(await shelves(fx), { s1: 11, s2: 8, s3: 13, wh: 6 });
  const book = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, type: "ADJUST" }, select: { warehouseId: true, delta: true } });
  assert.equal(book.length, 4);
  assert.ok(book.every((m) => m.warehouseId !== null));
  // "Counted total" at Lipa sets Lipa only.
  const set = await inv.adjust(fx.storeId, fx.owner, { productId: fx.riceId, warehouseId: fx.s3, setTo: 7, reason: "Counted" });
  assert.equal(set.ok, true, msg(set));
  assert.deepEqual(await shelves(fx), { s1: 11, s2: 8, s3: 7, wh: 6 });
});

test("Adjust: a store of another business, or a store turned off, is refused", async () => {
  const a = await fixture();
  const b = await fixture();
  const foreign = await inv.adjust(a.storeId, a.owner, { productId: a.riceId, warehouseId: b.s2, delta: 1, reason: "Wrong business" });
  assert.equal(foreign.ok, false);
  await prisma.warehouse.update({ where: { id: a.s3 }, data: { isActive: false } });
  const off = await inv.adjust(a.storeId, a.owner, { productId: a.riceId, warehouseId: a.s3, delta: 1, reason: "Closed store" });
  assert.equal(off.ok, false);
  assert.deepEqual(await shelves(a), { s1: 10, s2: 10, s3: 10, wh: 10 });
});

test("New rice: opening stock goes to the store the form names; reorder level is the main store's", async () => {
  const fx = await fixture();
  const made = await products.create(fx.storeId, { name: "Jasmine 25 kg", sku: `${run}-${seq}-J25`, priceMinor: 120_000, costMinor: 100_000, stock: 15, stockLocationId: fx.s3, reorderThreshold: 4 }, fx.owner);
  assert.equal(made.ok, true, msg(made));
  const id = made.ok ? made.value.id : "";
  const rows = await prisma.stockLevel.findMany({ where: { storeId: fx.storeId, productId: id } });
  assert.deepEqual(rows.map((r) => [r.warehouseId, r.quantityOnHand, r.reorderThreshold]).sort(), [[fx.s1, 0, 4], [fx.s3, 15, 0]].sort());
  const receipt = await prisma.stockMovement.findFirstOrThrow({ where: { storeId: fx.storeId, productId: id } });
  assert.equal(receipt.warehouseId, fx.s3);
  // No store named: the main store, as before.
  const plain = await products.create(fx.storeId, { name: "Sinandomeng 25 kg", sku: `${run}-${seq}-S25`, priceMinor: 110_000, stock: 6 }, fx.owner);
  assert.equal(plain.ok, true, msg(plain));
  const p = await prisma.stockLevel.findMany({ where: { storeId: fx.storeId, productId: plain.ok ? plain.value.id : "" } });
  assert.deepEqual(p.map((r) => [r.warehouseId, r.quantityOnHand]), [[fx.s1, 6]]);
});

test("New rice: opening stock for a store of another business is refused, nothing is saved", async () => {
  const a = await fixture();
  const b = await fixture();
  const sku = `${run}-${seq}-X25`;
  const r = await products.create(a.storeId, { name: "Wrong place 25 kg", sku, priceMinor: 120_000, stock: 5, stockLocationId: b.s2 }, a.owner);
  assert.equal(r.ok, false);
  assert.equal(await prisma.product.count({ where: { storeId: a.storeId, sku } }), 0);
});

test("Editing the reorder level on Products sets the main store's only; each store has its own on Inventory", async () => {
  const fx = await fixture();
  const e = await products.update(fx.storeId, fx.riceId, { reorderThreshold: 5 }, fx.owner);
  assert.equal(e.ok, true, msg(e));
  const lipa = await inv.setReorder(fx.storeId, fx.owner, { productId: fx.riceId, warehouseId: fx.s3, reorderThreshold: 2 });
  assert.equal(lipa.ok, true, msg(lipa));
  const bodega = await inv.setReorder(fx.storeId, fx.owner, { productId: fx.riceId, warehouseId: fx.wh, reorderThreshold: 20 });
  assert.equal(bodega.ok, true, msg(bodega));
  const rows = await prisma.stockLevel.findMany({ where: { storeId: fx.storeId, productId: fx.riceId } });
  const level = (w: string) => rows.find((r) => r.warehouseId === w)?.reorderThreshold;
  assert.deepEqual([level(fx.s1), level(fx.s2), level(fx.s3), level(fx.wh)], [5, 0, 2, 20]);
  assert.equal((await inv.setReorder(fx.storeId, fx.owner, { productId: fx.riceId, reorderThreshold: 2 })).ok, false, "no store = refused");
  assert.equal((await inv.setReorder(fx.storeId, fx.owner, { productId: fx.riceId, warehouseId: fx.s2, reorderThreshold: -1 })).ok, false);
  // The stock never moved.
  assert.deepEqual(await shelves(fx), { s1: 10, s2: 10, s3: 10, wh: 10 });
});

test("Old POS sale: a Lipa login sells from Lipa's shelf, never the main store's", async () => {
  const fx = await fixture();
  const r = await pos.sell(fx.storeId, fx.lipa, { items: [{ productId: fx.riceId, quantity: 2 }], paymentMethod: "cash", tenderedMinor: 260_000 });
  assert.equal(r.ok, true, msg(r));
  assert.deepEqual(await shelves(fx), { s1: 10, s2: 10, s3: 8, wh: 10 });
  const o = await prisma.order.findUniqueOrThrow({ where: { id: r.ok ? r.value.orderId : "" } });
  assert.equal(o.sellingLocationId, fx.s3);
});

test("Old POS sale: a Lipa login cannot sell at Bogs and Lucy; the owner can sell at any store it names", async () => {
  const fx = await fixture();
  const refused = await pos.sell(fx.storeId, fx.lipa, { locationId: fx.s1, items: [{ productId: fx.riceId, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 130_000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error.type, "forbidden");
  const atBahay = await pos.sell(fx.storeId, fx.owner, { locationId: fx.s2, items: [{ productId: fx.riceId, quantity: 3 }], paymentMethod: "cash", tenderedMinor: 390_000 });
  assert.equal(atBahay.ok, true, msg(atBahay));
  // The owner with no store named sells at the main store, as before.
  const atMain = await pos.sell(fx.storeId, fx.owner, { items: [{ productId: fx.riceId, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 130_000 });
  assert.equal(atMain.ok, true, msg(atMain));
  assert.deepEqual(await shelves(fx), { s1: 9, s2: 7, s3: 10, wh: 10 });
});

test("Old POS hold: a Bahay Tindahan login holds from its own shelf, and the hold is its store's", async () => {
  const fx = await fixture();
  const r = await pos.hold(fx.storeId, fx.bahay, { items: [{ productId: fx.riceId, quantity: 4 }] });
  assert.equal(r.ok, true, msg(r));
  assert.deepEqual(await shelves(fx), { s1: 10, s2: 6, s3: 10, wh: 10 });
  const o = await prisma.order.findUniqueOrThrow({ where: { id: r.ok ? r.value.orderId : "" } });
  assert.equal(o.sellingLocationId, fx.s2);
  const refused = await pos.hold(fx.storeId, fx.bahay, { locationId: fx.s3, items: [{ productId: fx.riceId, quantity: 1 }] });
  assert.equal(refused.ok, false);
});

// P3f: reorder threshold — set at product create/update, drives the LOW-stock status
// in the inventory list and the stockLow report. Real Prisma, run-scoped fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ProductAdminService } from "./product-admin.service.js";
import { InventoryService } from "../inventory/inventory.service.js";

const productsAdmin = new ProductAdminService();
const inventory = new InventoryService();
const run = `P3F${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

function tag(s: string) {
  return `${run}-${s}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({ data: { name: `${run} store`, slug: tag(`store-${slugSeq}`), status: "ACTIVE" } });
  createdStoreIds.push(s.id);
  return s;
}

after(async () => {
  for (const storeId of createdStoreIds) {
    const productIds = (await prisma.product.findMany({ where: { storeId }, select: { id: true } })).map((p) => p.id);
    if (productIds.length > 0) {
      await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.stockLevel.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productRelation.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    }
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

test("create with stock + reorderThreshold flags the item LOW in the inventory list", async () => {
  const store = await makeStore();
  const c = await productsAdmin.create(store.id, { name: "Low Kape", sku: tag("lowkape"), priceMinor: 5000, stock: 5, reorderThreshold: 5 });
  assert.equal(c.ok, true);
  if (!c.ok) return;

  const list = await inventory.list(store.id);
  const row = list.items.find((r) => r.id === c.value.id);
  assert.equal(row?.quantityOnHand, 5);
  assert.equal(row?.reorderThreshold, 5);
  assert.equal(row?.status, "low", "available 5 ≤ threshold 5 → LOW");

  const admin = await productsAdmin.listFiltered(store.id, {});
  const ap = admin.find((p) => p.id === c.value.id);
  assert.equal(ap?.reorderThreshold, 5);
});

test("update changes the threshold and flips the LOW status", async () => {
  const store = await makeStore();
  const c = await productsAdmin.create(store.id, { name: "Turon", sku: tag("turon"), priceMinor: 4000, stock: 10 });
  assert.equal(c.ok, true);
  if (!c.ok) return;

  const id = c.value.id;
  const before = (await inventory.list(store.id)).items.find((r) => r.id === id);
  assert.equal(before?.status, "in", "no threshold → not low");

  const set = await productsAdmin.update(store.id, id, { reorderThreshold: 12 });
  assert.equal(set.ok, true);
  const low = (await inventory.list(store.id)).items.find((r) => r.id === id);
  assert.equal(low?.status, "low", "available 10 ≤ threshold 12 → LOW");

  const clear = await productsAdmin.update(store.id, id, { reorderThreshold: 0 });
  assert.equal(clear.ok, true);
  const back = (await inventory.list(store.id)).items.find((r) => r.id === id);
  assert.equal(back?.status, "in", "threshold 0 → not low");
});

test("threshold can be set on a product with no stock level yet", async () => {
  const store = await makeStore();
  const c = await productsAdmin.create(store.id, { name: "Rice", sku: tag("rice"), priceMinor: 5200 });
  assert.equal(c.ok, true);
  if (!c.ok) return;

  const set = await productsAdmin.update(store.id, c.value.id, { reorderThreshold: 3 });
  assert.equal(set.ok, true);
  const admin = await productsAdmin.listFiltered(store.id, {});
  assert.equal(admin.find((p) => p.id === c.value.id)?.reorderThreshold, 3);

  const list = await inventory.list(store.id);
  const row = list.items.find((r) => r.id === c.value.id);
  assert.equal(row?.reorderThreshold, 3);
  assert.equal(row?.status, "out", "0 on hand → OUT (out-of-stock trumps low)");
});

test("validation rejects a negative threshold", async () => {
  const store = await makeStore();
  const c = await productsAdmin.create(store.id, { name: "Bread", sku: tag("bread"), priceMinor: 1000 });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const bad = await productsAdmin.update(store.id, c.value.id, { reorderThreshold: -1 });
  assert.equal(bad.ok, false);
});

test("tenant isolation: another store cannot set this product's threshold", async () => {
  const storeA = await makeStore();
  const storeB = await makeStore();
  const c = await productsAdmin.create(storeA.id, { name: "Aloe", sku: tag("a"), priceMinor: 1000, stock: 3 });
  assert.equal(c.ok, true);
  if (!c.ok) return;

  const x = await productsAdmin.update(storeB.id, c.value.id, { reorderThreshold: 1 });
  assert.equal(x.ok, false);
  if (!x.ok) assert.equal((x.error as { type: string }).type, "not_found");
});
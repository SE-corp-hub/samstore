// M5 — product barcode / unit / soldByWeight. Tenant-scoped uniqueness on barcode,
// search-by-barcode via Phase 1 listFiltered, create/update persistence, cross-store
// isolation. Uses the real Prisma client (repo style); run-scoped + deleted fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ProductAdminService } from "./product-admin.service.js";

const svc = new ProductAdminService();
const run = `M5T${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];
const createdProductIds: string[] = [];

function tag(s: string) {
  return `${run}-${s}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: tag(`store-${slugSeq}`), status: "ACTIVE" },
  });
  createdStoreIds.push(s.id);
  return s;
}

after(async () => {
  if (createdProductIds.length > 0) {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  }
  if (createdStoreIds.length > 0) {
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  await prisma.$disconnect();
});

test("create persists barcode/unit/soldByWeight and it round-trips through the list", async () => {
  const store = await makeStore();
  const c = await svc.create(store.id, {
    name: "Coke Sakto",
    sku: tag("coke-saku"),
    priceMinor: 5000,
    barcode: "4801234567890",
    unit: "bottle",
    soldByWeight: false,
  });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  createdProductIds.push(c.value.id);

  const list = await svc.listFiltered(store.id, {});
  const p = list.find((x) => x.id === c.value.id);
  assert.ok(p, "created product in list");
  assert.equal(p?.barcode, "4801234567890");
  assert.equal(p?.unit, "bottle");
  assert.equal(p?.soldByWeight, false);
});

test("search by barcode finds the product", async () => {
  const store = await makeStore();
  const c = await svc.create(store.id, {
    name: "Rice 5kg",
    sku: tag("rice-5kg"),
    priceMinor: 26500,
    barcode: "4805555555555",
    unit: "pack",
    soldByWeight: true,
  });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  createdProductIds.push(c.value.id);

  const hit = await svc.listFiltered(store.id, { search: "4805555555555" });
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.id, c.value.id);
});

test("duplicate barcode within a store is rejected", async () => {
  const store = await makeStore();
  const c1 = await svc.create(store.id, {
    name: "Milo",
    sku: tag("milo-1"),
    priceMinor: 4500,
    barcode: "4807777777777",
  });
  assert.equal(c1.ok, true);
  if (!c1.ok) return;
  createdProductIds.push(c1.value.id);

  const c2 = await svc.create(store.id, {
    name: "Milo Dupe",
    sku: tag("milo-2"),
    priceMinor: 4500,
    barcode: "4807777777777",
  });
  assert.equal(c2.ok, false);
  if (c2.ok) return;
  assert.equal(c2.error.type, "conflict");
});

test("same barcode in a DIFFERENT store is allowed (tenant isolation)", async () => {
  const storeA = await makeStore();
  const storeB = await makeStore();
  const a = await svc.create(storeA.id, {
    name: "Bear Brand A",
    sku: tag("bear-a"),
    priceMinor: 7000,
    barcode: "4808888888888",
  });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  createdProductIds.push(a.value.id);

  const b = await svc.create(storeB.id, {
    name: "Bear Brand B",
    sku: tag("bear-b"),
    priceMinor: 7000,
    barcode: "4808888888888",
  });
  assert.equal(b.ok, true, "cross-store duplicate barcode must be allowed");
  if (!b.ok) return;
  createdProductIds.push(b.value.id);
});

test("update changes barcode/unit/soldByWeight and clears them when blank", async () => {
  const store = await makeStore();
  const c = await svc.create(store.id, {
    name: "Tang",
    sku: tag("tang-1"),
    priceMinor: 3000,
    barcode: "4809999999999",
    unit: "sachet",
    soldByWeight: false,
  });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  createdProductIds.push(c.value.id);
  const id = c.value.id;

  const u1 = await svc.update(store.id, id, { barcode: "4801212121212", unit: "pack", soldByWeight: true });
  assert.equal(u1.ok, true);

  const list = await svc.listFiltered(store.id, { search: "4801212121212" });
  assert.equal(list.length, 1);
  assert.equal(list[0]?.unit, "pack");
  assert.equal(list[0]?.soldByWeight, true);

  const u2 = await svc.update(store.id, id, { barcode: null, unit: null });
  assert.equal(u2.ok, true);
  const cleared = await svc.listFiltered(store.id, {});
  const p = cleared.find((x) => x.id === id);
  assert.equal(p?.barcode, null);
  assert.equal(p?.unit, null);
});

test("duplicate barcode on update (excluding self) is rejected", async () => {
  const store = await makeStore();
  const c1 = await svc.create(store.id, {
    name: "Piattos",
    sku: tag("piat-1"),
    priceMinor: 4500,
    barcode: "4801313131313",
  });
  assert.equal(c1.ok, true);
  if (!c1.ok) return;
  createdProductIds.push(c1.value.id);

  const c2 = await svc.create(store.id, {
    name: "Piattos Sour",
    sku: tag("piat-2"),
    priceMinor: 4500,
  });
  assert.equal(c2.ok, true);
  if (!c2.ok) return;
  createdProductIds.push(c2.value.id);

  const dup = await svc.update(store.id, c2.value.id, { barcode: "4801313131313" });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.error.type, "conflict");

  // Setting the SAME barcode back on c1 (its own value) must not conflict.
  const self = await svc.update(store.id, c1.value.id, { barcode: "4801313131313", unit: "pack" });
  assert.equal(self.ok, true);
});
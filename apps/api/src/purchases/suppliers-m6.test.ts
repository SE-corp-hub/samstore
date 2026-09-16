// M6 — Suppliers master. Tenant-scoped CRUD, upsert-by-name idempotency,
// cross-store isolation. Uses the real Prisma client (repo style);
// run-scoped + deleted fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { SuppliersService } from "../purchases/suppliers.service.js";

const svc = new SuppliersService();
const run = `M6T${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];
const createdSupplierIds: string[] = [];

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
  if (createdSupplierIds.length > 0) {
    await prisma.supplier.deleteMany({ where: { id: { in: createdSupplierIds } } });
  }
  if (createdStoreIds.length > 0) {
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  await prisma.$disconnect();
});

test("create supplier persists and round-trips through list", async () => {
  const store = await makeStore();
  const c = await svc.create(store.id, "Acme Supplies", "John Doe", "+63-917-1234", "acme@example.com");
  assert.equal(c.ok, true);
  if (!c.ok) return;
  createdSupplierIds.push(c.value.id);

  const list = await svc.list(store.id);
  const found = list.find((s) => s.id === c.value.id);
  assert.equal(found?.name, "Acme Supplies");
  assert.equal(found?.contactPerson, "John Doe");
  assert.equal(found?.phone, "+63-917-1234");
  assert.equal(found?.email, "acme@example.com");
});

test("create rejects duplicate name per store", async () => {
  const store = await makeStore();
  const c1 = await svc.create(store.id, "DupVendor");
  assert.equal(c1.ok, true);
  if (!c1.ok) return;
  createdSupplierIds.push(c1.value.id);

  const c2 = await svc.create(store.id, "DupVendor");
  assert.equal(c2.ok, false);
  if (!c2.ok) assert.equal(c2.error.type, "conflict");
});

test("create is scoped to store (cross-store isolation)", async () => {
  const store1 = await makeStore();
  const store2 = await makeStore();
  const c = await svc.create(store1.id, "IsolatedVendor");
  assert.equal(c.ok, true);
  if (!c.ok) return;
  createdSupplierIds.push(c.value.id);

  const list2 = await svc.list(store2.id);
  assert.equal(list2.find((s) => s.name === "IsolatedVendor"), undefined);
});

test("upsertByName creates new supplier", async () => {
  const store = await makeStore();
  const r = await svc.upsertByName(store.id, "NewVendor Corp");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  createdSupplierIds.push(r.value.id);
  assert.equal(r.value.name, "NewVendor Corp");
});

test("upsertByName returns existing supplier (idempotent)", async () => {
  const store = await makeStore();
  const r1 = await svc.upsertByName(store.id, "DupByName");
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  createdSupplierIds.push(r1.value.id);

  const r2 = await svc.upsertByName(store.id, "DupByName");
  assert.equal(r2.ok, true);
  if (r1.ok && r2.ok) assert.equal(r1.value.id, r2.value.id);
});
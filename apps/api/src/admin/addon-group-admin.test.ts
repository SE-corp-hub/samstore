// P3e: add-on GROUP edit (rename / required) + add-option-to-existing-group.
// Round-trips through the admin product list; tenant isolation on the group target.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ProductAdminService } from "./product-admin.service.js";

const svc = new ProductAdminService();
const run = `P3E${Date.now()}${Math.floor(Math.random() * 1000)}`;
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

async function makeProduct(storeId: string, name: string) {
  return prisma.product.create({ data: { storeId, sku: tag(name), name, priceMinor: 10000, isActive: true } });
}

after(async () => {
  if (createdStoreIds.length > 0) {
    await prisma.product.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  await prisma.$disconnect();
});

test("group rename + required toggle round-trip through the admin list", async () => {
  const store = await makeStore();
  const product = await makeProduct(store.id, "Kape");
  const g = await svc.addAddon(store.id, product.id, { name: "Extras", required: false, options: [{ name: "Shot", priceMinor: 2000 }] });
  assert.equal(g.ok, true);
  if (!g.ok) return;

  const renamed = await svc.updateAddon(store.id, g.value.id, { name: "Add-ons", required: true });
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;

  const row = (await svc.listFiltered(store.id, {})).find((p) => p.id === product.id);
  const group = row?.addons.find((a) => a.id === g.value.id);
  assert.equal(group?.name, "Add-ons");
  assert.equal(group?.required, true);
});

test("addOptionToGroup appends an option after existing ones", async () => {
  const store = await makeStore();
  const product = await makeProduct(store.id, "Turon");
  const g = await svc.addAddon(store.id, product.id, { name: "Extras", options: [{ name: "Shot", priceMinor: 1000 }] });
  assert.equal(g.ok, true);
  if (!g.ok) return;

  const added = await svc.addAddonOption(store.id, g.value.id, { name: "Milk", priceMinor: 1500 });
  assert.equal(added.ok, true);
  if (!added.ok) return;

  const row = (await svc.listFiltered(store.id, {})).find((p) => p.id === product.id);
  const group = row?.addons.find((a) => a.id === g.value.id);
  const names = group?.options.map((o) => `${o.name}:${o.priceMinor}`) ?? [];
  assert.deepEqual(names, ["Shot:1000", "Milk:1500"], "new option appended, prices intact");
});

test("validation rejects blank group name and negative option price", async () => {
  const store = await makeStore();
  const product = await makeProduct(store.id, "Rice");
  const g = await svc.addAddon(store.id, product.id, { name: "Extras", options: [{ name: "Small", priceMinor: 0 }] });
  assert.equal(g.ok, true);
  if (!g.ok) return;

  const badName = await svc.updateAddon(store.id, g.value.id, { name: "  " });
  assert.equal(badName.ok, false);

  const badPrice = await svc.addAddonOption(store.id, g.value.id, { name: "Large", priceMinor: -1 });
  assert.equal(badPrice.ok, false);

  const badOptName = await svc.addAddonOption(store.id, g.value.id, { name: "", priceMinor: 500 });
  assert.equal(badOptName.ok, false);
});

test("tenant isolation: another store cannot edit the group or add options", async () => {
  const storeA = await makeStore();
  const storeB = await makeStore();
  const productA = await makeProduct(storeA.id, "A");
  const g = await svc.addAddon(storeA.id, productA.id, { name: "Extras", options: [{ name: "Shot", priceMinor: 1000 }] });
  assert.equal(g.ok, true);
  if (!g.ok) return;

  const rename = await svc.updateAddon(storeB.id, g.value.id, { name: "Hijacked" });
  assert.equal(rename.ok, false);
  if (!rename.ok) assert.equal((rename.error as { type: string }).type, "not_found");

  const add = await svc.addAddonOption(storeB.id, g.value.id, { name: "X", priceMinor: 100 });
  assert.equal(add.ok, false);
  if (!add.ok) assert.equal((add.error as { type: string }).type, "not_found");
});
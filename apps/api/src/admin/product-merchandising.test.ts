// P3d: merchandising — featured flag, tags, related/upsell relations.
// Admin create/update round-trips through listFiltered; tenant isolation on relation
// targets (same store, active, no self-link). Uses the real Prisma client.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ProductAdminService } from "./product-admin.service.js";

const svc = new ProductAdminService();
const run = `P3D${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

function msgOf(error: { message?: string } | { errors?: string[] }): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("errors" in error && Array.isArray(error.errors)) return error.errors.join(", ");
  return "";
}

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
  const p = await prisma.product.create({
    data: { storeId, sku: tag(name), name, priceMinor: 10000, isActive: true },
  });
  return p;
}

after(async () => {
  for (const storeId of createdStoreIds) {
    await prisma.productRelation.deleteMany({ where: { storeId } });
  }
  if (createdStoreIds.length > 0) {
    await prisma.product.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  await prisma.$disconnect();
});

test("create persists featured + tags and they round-trip through the list", async () => {
  const store = await makeStore();
  const created = await svc.create(store.id, { name: "Featured Kape", sku: tag("fkape"), priceMinor: 12000, featured: true, tags: ["new", "best seller"] });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const list = await svc.listFiltered(store.id, {});
  const row = list.find((p) => p.id === created.value.id);
  assert.ok(row, "product appears in the admin list");
  assert.equal(row?.featured, true);
  assert.deepEqual(row?.tags, ["new", "best seller"]);
  assert.equal(row?.related.length, 0);
  assert.equal(row?.upsell.length, 0);
});

test("update replaces related/upsell links and listFiltered returns targets", async () => {
  const store = await makeStore();
  const a = await makeProduct(store.id, "A");
  const b = await makeProduct(store.id, "B");
  const c = await makeProduct(store.id, "C");

  const created = await svc.create(store.id, { name: "Hub", sku: tag("hub"), priceMinor: 9000 });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const hubId = created.value.id;

  const upd = await svc.update(store.id, hubId, { relatedProductIds: [b.id, c.id], upsellProductIds: [a.id], featured: true, tags: ["hot"] });
  assert.equal(upd.ok, true);
  if (!upd.ok) return;

  const row = (await svc.listFiltered(store.id, {})).find((p) => p.id === hubId);
  assert.deepEqual(row?.related.map((r) => r.id), [b.id, c.id], "related in sortOrder");
  assert.deepEqual(row?.upsell.map((r) => r.id), [a.id]);
  assert.equal(row?.featured, true);
  assert.deepEqual(row?.tags, ["hot"]);

  // Replace-all semantics: a second update clears the previous set.
  const upd2 = await svc.update(store.id, hubId, { relatedProductIds: [c.id], upsellProductIds: [] });
  assert.equal(upd2.ok, true);
  const row2 = (await svc.listFiltered(store.id, {})).find((p) => p.id === hubId);
  assert.deepEqual(row2?.related.map((r) => r.id), [c.id]);
  assert.deepEqual(row2?.upsell, []);
});

test("self-link and cross-store targets are rejected", async () => {
  const store = await makeStore();
  const otherStore = await makeStore();
  const hub = await makeProduct(store.id, "Hub");
  const other = await makeProduct(otherStore.id, "Other");

  const selfLink = await svc.update(store.id, hub.id, { relatedProductIds: [hub.id] });
  assert.equal(selfLink.ok, false);
  if (!selfLink.ok) assert.match(msgOf(selfLink.error), /to itself/);

  const crossStore = await svc.update(store.id, hub.id, { relatedProductIds: [other.id] });
  assert.equal(crossStore.ok, false);
  if (!crossStore.ok) assert.match(msgOf(crossStore.error), /not found or inactive/);
});

test("featured + tag filters narrow the admin list", async () => {
  const store = await makeStore();
  const f = await svc.create(store.id, { name: "F1", sku: tag("f1"), priceMinor: 500, featured: true, tags: ["special"] });
  assert.equal(f.ok, true);
  if (!f.ok) return;
  await svc.create(store.id, { name: "F2", sku: tag("f2"), priceMinor: 400, featured: false, tags: ["special"] });

  const featured = await svc.listFiltered(store.id, { featured: true });
  assert.equal(featured.length, 1);
  assert.equal(featured[0]?.id, f.value.id);

  const byTag = await svc.listFiltered(store.id, { tag: "special" });
  assert.equal(byTag.length, 2);

  const byTagAndFeatured = await svc.listFiltered(store.id, { tag: "special", featured: true });
  assert.equal(byTagAndFeatured.length, 1);
  assert.equal(byTagAndFeatured[0]?.id, f.value.id);
});
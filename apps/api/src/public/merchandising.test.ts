// P3d: merchandising flows through the PUBLIC storefront payload — featured flag, tags,
// and related/upsell summaries (active same-store targets only). Real Prisma fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { PublicStoreService } from "./public-store.service.js";
import type { ProductDTO } from "@sam-store/contracts";

const run = `M3D${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

async function makeStore(tag: string) {
  const slug = `${run}-${tag}`.toLowerCase();
  const store = await prisma.store.create({
    data: {
      slug,
      name: `Merch ${run} ${tag}`,
      publicLink: { create: { slug, token: `lnk_${tag}-${"y".repeat(30)}` } },
    },
  });
  createdStoreIds.push(store.id);
  return store;
}

async function makeProduct(storeId: string, sku: string, over: { isActive?: boolean; featured?: boolean; tags?: string[] } = {}) {
  return prisma.product.create({
    data: {
      storeId,
      sku,
      name: sku,
      priceMinor: 10000,
      isActive: over.isActive ?? true,
      featured: over.featured ?? false,
      tags: over.tags ?? [],
    },
  });
}

after(async () => {
  for (const storeId of createdStoreIds) {
    await prisma.productRelation.deleteMany({ where: { storeId } });
  }
  if (createdStoreIds.length > 0) {
    await prisma.product.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.publicStoreLink.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  await prisma.$disconnect();
});

test("storefront returns featured, tags, and related/upsell summaries", async () => {
  const store = await makeStore("a");
  const a = await makeProduct(store.id, "MERCH-A", { featured: true, tags: ["new", "best seller"] });
  const b = await makeProduct(store.id, "MERCH-B", { tags: ["hot"] });
  const c = await makeProduct(store.id, "MERCH-C", { isActive: false });

  await prisma.productRelation.createMany({
    data: [
      { storeId: store.id, sourceProductId: a.id, targetProductId: b.id, kind: "related", sortOrder: 0 },
      { storeId: store.id, sourceProductId: a.id, targetProductId: c.id, kind: "upsell", sortOrder: 0 }, // inactive target → hidden
      { storeId: store.id, sourceProductId: b.id, targetProductId: a.id, kind: "upsell", sortOrder: 0 },
    ],
  });

  const link = await prisma.publicStoreLink.findUnique({ where: { storeId: store.id } });
  const svc = new PublicStoreService();
  const result = await svc.getStore(store.slug, link?.token);
  assert.ok(result && result.closed === false);
  if (!result || result.closed) return;

  const bySku = new Map((result.products as ProductDTO[]).map((p) => [p.sku, p]));
  const pa = bySku.get("MERCH-A");
  assert.ok(pa, "featured product listed");
  assert.equal(pa.featured, true);
  assert.deepEqual(pa.tags, ["new", "best seller"]);
  assert.equal(pa.related.length, 1);
  assert.equal(pa.related[0]?.id, b.id);
  assert.equal(pa.related[0]?.name, "MERCH-B");
  assert.equal(pa.related[0]?.priceMinor, 10000);
  assert.equal(pa.related[0]?.image, null);
  assert.equal(pa.upsell.length, 0, "inactive upsell target is omitted");

  const pb = bySku.get("MERCH-B");
  assert.ok(pb);
  assert.equal(pb.featured, false);
  assert.deepEqual(pb.tags, ["hot"]);
  assert.equal(pb.upsell.length, 1);
  assert.equal(pb.upsell[0]?.id, a.id);
});
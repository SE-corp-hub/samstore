// Quota promo settings: saved and read back; a group from another store, or odd numbers, are refused.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { StoreSettingsService } from "./store-settings.service.js";

const run = `qp${Date.now().toString(36)}`;
const storeIds: string[] = [];

after(async () => {
  await prisma.storeSettings.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.category.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

async function store(n: number) {
  const s = await prisma.store.create({ data: { slug: `${run}-${n}`, name: `QP ${run} ${n}` } });
  storeIds.push(s.id);
  return s.id;
}

test("quota promo: saved, read back, and checked", async () => {
  const a = await store(1), b = await store(2);
  const local = await prisma.category.create({ data: { storeId: a, name: "Local", slug: "local" } });
  const other = await prisma.category.create({ data: { storeId: b, name: "Premium", slug: "premium" } });
  const svc = new StoreSettingsService();

  const before = await svc.get(a);
  assert.equal(before?.settings.quotaPromoEnabled, false, "off until the owner turns it on");
  assert.equal(before?.settings.quotaPromoMinSacks, 10);
  assert.equal(before?.settings.quotaPromoOffMinor, 2000);

  const ok = await svc.update(a, { quotaPromoEnabled: true, quotaPromoMinSacks: 12, quotaPromoOffMinor: 2500, quotaPromoCategoryIds: [local.id, local.id] });
  assert.equal(ok.ok, true);
  const got = await svc.get(a);
  assert.deepEqual([got?.settings.quotaPromoEnabled, got?.settings.quotaPromoMinSacks, got?.settings.quotaPromoOffMinor, got?.settings.quotaPromoCategoryIds], [true, 12, 2500, [local.id]]);

  assert.equal((await svc.update(a, { quotaPromoCategoryIds: [other.id] })).ok, false, "another store's group is refused");
  assert.equal((await svc.update(a, { quotaPromoMinSacks: 0 })).ok, false);
  assert.equal((await svc.update(a, { quotaPromoOffMinor: 0 })).ok, false);
});

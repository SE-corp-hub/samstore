// Settings → Business name: the owner renames the business; the store code (slug) stays.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { StoreSettingsService } from "./store-settings.service.js";

const run = `biz${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
after(async () => {
  await prisma.auditLog.deleteMany({ where: { storeId: { in: storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

test("the owner renames the business, the slug stays, and it is in the audit log", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-test`, name: "TEST Bigasan" } });
  storeIds.push(store.id);
  const svc = new StoreSettingsService();
  const r = await svc.rename(store.id, "  Bogs and   Lucy Rice Store ", "owner-1");
  assert.ok(r.ok);
  const now = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
  assert.deepEqual([now.name, now.slug], ["Bogs and Lucy Rice Store", `${run}-test`]);
  const log = await prisma.auditLog.findFirstOrThrow({ where: { storeId: store.id, action: "store.rename" } });
  assert.deepEqual(log.before, { name: "TEST Bigasan" });

  for (const bad of ["", " x ", "y".repeat(61)]) assert.equal((await svc.rename(store.id, bad, "owner-1")).ok, false, `refuses "${bad}"`);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).name, "Bogs and Lucy Rice Store");
});

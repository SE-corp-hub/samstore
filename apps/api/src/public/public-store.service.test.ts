// Module 2 — public store link security (slug + token). Real Prisma, run-scoped fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { PublicStoreService } from "./public-store.service.js";

const run = `PUB${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

async function makeStore(tag: string, withLink = true) {
  const slug = `${run}-${tag}`.toLowerCase();
  const store = await prisma.store.create({
    data: {
      slug,
      name: `Public ${run} ${tag}`,
      ...(withLink
        ? { publicLink: { create: { slug, token: `lnk_${tag}-${"x".repeat(30)}` } } }
        : {}),
    },
  });
  createdStoreIds.push(store.id);
  return store;
}

after(async () => {
  if (createdStoreIds.length > 0) {
    await prisma.publicStoreLink.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    // Fix #2: createAtomic writes the outbox event in-transaction and the live
    // worker drains it into a NotificationLog row — clear both before the store.
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  await prisma.$disconnect();
});

test("requires the token — missing token returns null (404)", async () => {
  const s = await makeStore("a");
  const svc = new PublicStoreService();
  assert.equal(await svc.getStore(s.slug, undefined), null);
  assert.equal(await svc.getStore(s.slug, ""), null);
});

test("wrong token returns null — does not reveal the store", async () => {
  const s = await makeStore("b");
  const svc = new PublicStoreService();
  assert.equal(await svc.getStore(s.slug, "lnk_wrong-token"), null);
});

test("valid slug + token resolves the storefront payload", async () => {
  const s = await makeStore("c");
  const link = await prisma.publicStoreLink.findUnique({ where: { storeId: s.id } });
  const svc = new PublicStoreService();
  const result = await svc.getStore(s.slug, link?.token);
  assert.ok(result, "resolves with correct token");
  if (!result) return;
  assert.equal(result.closed, false);
  assert.equal((result.store as { name: string }).name, `Public ${run} c`);
  assert.ok(Array.isArray(result.products));
});

test("revoked link returns null even with the old token", async () => {
  const s = await makeStore("d");
  const link = await prisma.publicStoreLink.findUnique({ where: { storeId: s.id } });
  await prisma.publicStoreLink.update({ where: { id: link!.id }, data: { status: "REVOKED", revokedAt: new Date() } });

  const svc = new PublicStoreService();
  assert.equal(await svc.getStore(s.slug, link?.token), null);
});

test("unknown slug returns null (no enumeration)", async () => {
  const svc = new PublicStoreService();
  assert.equal(await svc.getStore(`${run}-nope`, "lnk_anything"), null);
});
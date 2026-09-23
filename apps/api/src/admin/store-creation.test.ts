import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { StoreAdminService } from "./store-admin.service.js";

const service = new StoreAdminService();
const run = `STORE${Date.now()}`;
const storeIds: string[] = [];
const userIds: string[] = [];

after(async () => {
  for (const storeId of storeIds) {
    await prisma.userStore.deleteMany({ where: { storeId } });
    await prisma.publicStoreLink.deleteMany({ where: { storeId } });
    await prisma.storeSettings.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("Platform Admin store creation creates a new owner login with one-time credentials", async () => {
  const result = await service.create({ name: "New Staging Store", slug: `${run}-new`, ownerEmail: `${run.toLowerCase()}@example.test` });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  storeIds.push(result.value.id);
  const membership = await prisma.userStore.findFirst({ where: { storeId: result.value.id }, include: { user: true } });
  assert.ok(membership);
  if (!membership) return;
  userIds.push(membership.userId);
  assert.equal(membership.role, "OWNER");
  assert.equal(membership.user.email, `${run.toLowerCase()}@example.test`);
  assert.ok(result.value.tempPassword, "new owner receives a one-time password");
  assert.equal(membership.user.mustChangePassword, true);
  assert.ok(await prisma.publicStoreLink.findUnique({ where: { storeId: result.value.id } }));
});

test("existing owner email is linked without generating a second user", async () => {
  const user = await prisma.user.create({ data: { email: `${run}-existing@example.test`, passwordHash: "hash", role: "OWNER" } });
  userIds.push(user.id);
  const result = await service.create({ name: "Existing Owner Store", slug: `${run}-existing`, ownerEmail: user.email! });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  storeIds.push(result.value.id);
  assert.equal(result.value.tempPassword, undefined);
  assert.equal(await prisma.user.count({ where: { email: user.email! } }), 1);
  assert.ok(await prisma.userStore.findUnique({ where: { userId_storeId: { userId: user.id, storeId: result.value.id } } }));
});

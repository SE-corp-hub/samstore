// Task 1 — platform-only user creation (POST /admin/users).
// Real Prisma; every fixture is run-scoped and removed in after().

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { AuthService } from "../auth/auth.service.js";
import { PrismaAuthRepository } from "../auth/auth.repository.js";
import { hashPassword, verifyPassword } from "../auth/auth.domain.js";
import { TeamService } from "./team.service.js";

const CONFIG = { jwtSecret: "test-secret-0123456789", jwtExpiresIn: "1h" };
const svc = new AuthService(new PrismaAuthRepository(), CONFIG);

const run = `PAU${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ACTOR_ID = `actor-${run}`;
const storeIds: string[] = [];
const userIds: string[] = [];

function email(tag: string) {
  return `${run}-${tag}@example.test`.toLowerCase();
}

async function makeStore() {
  const s = await prisma.store.create({
    data: { slug: `${run}-store${storeIds.length}`.toLowerCase(), name: `Platform users ${run}` },
  });
  storeIds.push(s.id);
  return s;
}

after(async () => {
  if (userIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: userIds } } });
    await prisma.userStore.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (storeIds.length > 0) await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

test("createPlatformUser creates a user with a temp password and an ACTIVE membership", async () => {
  const store = await makeStore();

  const owner = await svc.createPlatformUser({ name: "New Owner", email: email("owner"), role: "OWNER", storeId: store.id, actorId: ACTOR_ID });
  assert.equal(owner.ok, true);
  if (!owner.ok) return;
  userIds.push(owner.value.userId);
  assert.equal(owner.value.email, email("owner"));
  assert.equal(owner.value.role, "OWNER");
  assert.equal(typeof owner.value.tempPassword, "string");
  assert.ok((owner.value.tempPassword ?? "").length >= 10, "temp password is at least 10 chars");

  const ownerRow = await prisma.user.findUnique({ where: { id: owner.value.userId } });
  assert.equal(ownerRow?.mustChangePassword, true);
  assert.equal(ownerRow?.role, "STORE_OWNER", "global role maps OWNER to STORE_OWNER");
  assert.equal(await verifyPassword(owner.value.tempPassword ?? "", ownerRow?.passwordHash ?? ""), true);

  const ownerMembership = await prisma.userStore.findUnique({
    where: { userId_storeId: { userId: owner.value.userId, storeId: store.id } },
  });
  assert.equal(ownerMembership?.role, "OWNER");
  assert.equal(ownerMembership?.status, "ACTIVE");

  const audit = await prisma.auditLog.findFirst({
    where: { entityId: owner.value.userId, action: "platform.user.create" },
  });
  assert.equal(audit?.actorType, "platform_admin");
  assert.equal(audit?.actorId, ACTOR_ID, "audit row records the acting platform admin");

  const staff = await svc.createPlatformUser({ email: email("staff"), role: "STAFF", storeId: store.id, actorId: ACTOR_ID });
  assert.equal(staff.ok, true);
  if (!staff.ok) return;
  userIds.push(staff.value.userId);
  const staffRow = await prisma.user.findUnique({ where: { id: staff.value.userId } });
  assert.equal(staffRow?.role, "STAFF", "non-OWNER global role keeps the store role");
  assert.equal(staffRow?.mustChangePassword, true);
  const staffMembership = await prisma.userStore.findUnique({
    where: { userId_storeId: { userId: staff.value.userId, storeId: store.id } },
  });
  assert.equal(staffMembership?.role, "STAFF");
  assert.equal(staffMembership?.status, "ACTIVE");
});

test("createPlatformUser rejects PLATFORM_ADMIN as a store role", async () => {
  const r = await svc.createPlatformUser({ email: email("badrole"), role: "PLATFORM_ADMIN", actorId: ACTOR_ID });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("createPlatformUser binds an existing email without touching its password", async () => {
  const store = await makeStore();
  const existing = await prisma.user.create({
    data: { email: email("existing"), passwordHash: await hashPassword("original-pass-123"), role: "STORE_OWNER" },
  });
  userIds.push(existing.id);

  const r = await svc.createPlatformUser({ name: "Ignored", email: email("existing"), role: "MANAGER", storeId: store.id, actorId: ACTOR_ID });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.userId, existing.id);
  assert.equal(r.value.role, "MANAGER");
  assert.equal("tempPassword" in r.value, false, "existing account gets no temp password");

  const row = await prisma.user.findUnique({ where: { id: existing.id } });
  assert.equal(row?.passwordHash, existing.passwordHash, "password hash unchanged");
  assert.equal(row?.mustChangePassword, false, "must-change flag untouched");
  assert.equal(row?.role, "MANAGER", "bound user's global role aligns with the membership role");

  const membership = await prisma.userStore.findUnique({
    where: { userId_storeId: { userId: existing.id, storeId: store.id } },
  });
  assert.equal(membership?.role, "MANAGER");
  assert.equal(membership?.status, "ACTIVE");
});

test("createPlatformUser rejects a nonexistent store", async () => {
  const r = await svc.createPlatformUser({ email: email("nostore"), role: "STAFF", storeId: "does-not-exist-000", actorId: ACTOR_ID });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("createPlatformUser conflicts on a duplicate email with no store to bind", async () => {
  const first = await svc.createPlatformUser({ email: email("dup"), role: "STAFF", actorId: ACTOR_ID });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  userIds.push(first.value.userId);

  const second = await svc.createPlatformUser({ email: email("dup"), role: "STAFF", actorId: ACTOR_ID });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.type, "conflict");
});

test("invite creates a new user who must change their password on first login", async () => {
  const store = await makeStore();
  const team = new TeamService();

  const r = await team.invite(store.id, email("invite-new"), "Invited Person", "STAFF");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  userIds.push(r.value.userId);

  const row = await prisma.user.findUnique({ where: { id: r.value.userId } });
  assert.equal(row?.mustChangePassword, true, "newly invited user must change password");
});

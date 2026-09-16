// v6 — store access management: password reset / must-change flow, role changes,
// per-user access (A3, B2, B3). Uses the real Prisma client (like the other
// *.test.ts files); every fixture is run-scoped and deleted in after().

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { AuthService } from "./auth.service.js";
import { PrismaAuthRepository } from "./auth.repository.js";
import { hashPassword, verifyPassword } from "./auth.domain.js";

const CONFIG = { jwtSecret: "test-secret-0123456789", jwtExpiresIn: "1h" };
const svc = new AuthService(new PrismaAuthRepository(), CONFIG);

const run = `SAU${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let resetHistoryIds: string[] = [];

function email(tag: string) {
  // Lowercase: login/findByEmail normalize to lowercase (createUser stores it that way).
  return `${run}-${tag}@example.test`.toLowerCase();
}

async function makeStore(tag: string) {
  const s = await prisma.store.create({ data: { slug: `${run}-${tag}`, name: `Access Mgmt ${run} ${tag}` } });
  storeIds.push(s.id);
  return s;
}

async function makeUser(tag: string, password = "orig-password-123") {
  const u = await prisma.user.create({
    data: { email: email(tag), passwordHash: await hashPassword(password), role: "STORE_OWNER" },
  });
  userIds.push(u.id);
  return u;
}

async function makeMembership(userId: string, storeId: string, role: "OWNER" | "MANAGER" | "STAFF" | "SALES_AGENT" | "DELIVERY", status: "ACTIVE" | "DEACTIVATED" = "ACTIVE") {
  return prisma.userStore.create({ data: { userId, storeId, role, status } });
}

after(async () => {
  if (resetHistoryIds.length > 0) {
    await prisma.passwordResetHistory.deleteMany({ where: { id: { in: resetHistoryIds } } });
  }
  if (userIds.length > 0) {
    await prisma.userStore.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (storeIds.length > 0) {
    // Fix #2: createAtomic writes the outbox event in-transaction and the live
    // worker drains it into a NotificationLog row — clear both before the store.
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

// ─────────────────────────────── B3: reset password ───────────────────────────────

test("resetPassword generates a strong temp password, sets must-change, audits", async () => {
  const store = await makeStore("reset1");
  const owner = await makeUser("reset1-owner");
  const member = await makeUser("reset1-member");
  await makeMembership(owner.id, store.id, "OWNER");
  await makeMembership(member.id, store.id, "MANAGER");

  const r = await svc.resetPassword({ userId: member.id, storeId: store.id, resetBy: owner.id });
  assert.equal(r.ok, true, "reset should succeed");
  if (!r.ok) return;
  assert.ok(r.value.tempPassword.length >= 10, `temp password is strong (${r.value.tempPassword.length} chars)`);
  assert.equal(r.value.mustChangePassword, true);
  // no padding artifacts in the generated temp
  assert.ok(!r.value.tempPassword.includes("="));

  const u = await prisma.user.findUnique({ where: { id: member.id } });
  assert.equal(u?.mustChangePassword, true);
  assert.equal(await verifyPassword(r.value.tempPassword, u?.passwordHash ?? ""), true, "stored hash matches temp");

  const rows = await prisma.passwordResetHistory.findMany({ where: { userId: member.id, storeId: store.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.resetBy, owner.id);
  resetHistoryIds = rows.map((x) => x.id);

  // temp password alone must NOT grant a token — must-change gate fires first
  const login = await svc.login({ email: email("reset1-member"), password: r.value.tempPassword });
  assert.equal(login.ok, false);
  if (login.ok) return;
  assert.equal(login.error.type, "forbidden");
  assert.equal("mustChangePassword" in login.error && login.error.mustChangePassword === true, true);
  assert.equal(login.error.message, "You must change your password on first login");
});

test("resetPassword honors a provided password and rejects short ones", async () => {
  const store = await makeStore("reset2");
  const owner = await makeUser("reset2-owner");
  const member = await makeUser("reset2-member");
  await makeMembership(owner.id, store.id, "OWNER");
  await makeMembership(member.id, store.id, "STAFF");

  const short = await svc.resetPassword({ userId: member.id, storeId: store.id, resetBy: owner.id, newPassword: "too-short" });
  assert.equal(short.ok, false, "under-10-char temp must be rejected");
  if (!short.ok) assert.equal(short.error.type, "validation");

  const ok = await svc.resetPassword({ userId: member.id, storeId: store.id, resetBy: owner.id, newPassword: "my-strong-pass-123" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.tempPassword, "my-strong-pass-123");
    const u = await prisma.user.findUnique({ where: { id: member.id } });
    assert.equal(await verifyPassword("my-strong-pass-123", u?.passwordHash ?? ""), true);
  }
});

test("resetPassword rejects a user who is not a member of the store", async () => {
  const store = await makeStore("reset3");
  const stranger = await makeUser("reset3-stranger");
  const r = await svc.resetPassword({ userId: stranger.id, storeId: store.id, resetBy: stranger.id });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

// ─────────────────────────────── must-change flow: changePassword ───────────────────────────────

test("login is refused while mustChangePassword is set — no token issued", async () => {
  const user = await makeUser("mustchg", "temp-pass-12345");
  await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });
  const r = await svc.login({ email: email("mustchg"), password: "temp-pass-12345" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "forbidden");
  assert.ok("mustChangePassword" in r.error && r.error.mustChangePassword === true);
});

test("changePassword verifies the current password before updating", async () => {
  const user = await makeUser("chg-verify", "temp-pass-12345");
  await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });

  const wrong = await svc.changePassword({ email: email("chg-verify"), currentPassword: "nope-nope-nope", newPassword: "new-pass-12345" });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.error.type, "unauthorized");

  const short = await svc.changePassword({ email: email("chg-verify"), currentPassword: "temp-pass-12345", newPassword: "short" });
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.error.type, "validation");

  const before = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(before?.mustChangePassword, true, "failed attempts do not clear the flag");
});

test("changePassword with the temp password clears the flag and returns a fresh token", async () => {
  const store = await makeStore("chg-ok");
  const member = await makeUser("chg-ok-member", "temp-pass-12345");
  await makeMembership(member.id, store.id, "SALES_AGENT");
  await prisma.user.update({ where: { id: member.id }, data: { mustChangePassword: true } });

  const r = await svc.changePassword({ email: email("chg-ok-member"), currentPassword: "temp-pass-12345", newPassword: "brand-new-pass-123" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.value.token, /^eyJ/);

  const u = await prisma.user.findUnique({ where: { id: member.id } });
  assert.equal(u?.mustChangePassword, false, "must-change flag cleared");

  const newLogin = await svc.login({ email: email("chg-ok-member"), password: "brand-new-pass-123" });
  assert.equal(newLogin.ok, true, "new password logs in normally");
  const oldLogin = await svc.login({ email: email("chg-ok-member"), password: "temp-pass-12345" });
  assert.equal(oldLogin.ok, false, "old temp password no longer works");
});

// ─────────────────────────────── B2: role change ───────────────────────────────

test("role change: cannot demote the last active owner", async () => {
  const store = await makeStore("role1");
  const owner = await makeUser("role1-owner");
  const staff = await makeUser("role1-staff");
  await makeMembership(owner.id, store.id, "OWNER");
  await makeMembership(staff.id, store.id, "STAFF");

  const demote = await svc.changeRole({ storeId: store.id, userId: owner.id, role: "MANAGER" });
  assert.equal(demote.ok, false, "last owner cannot be demoted");
  if (!demote.ok) assert.equal(demote.error.type, "conflict");

  const promote = await svc.changeRole({ storeId: store.id, userId: staff.id, role: "MANAGER" });
  assert.equal(promote.ok, true);
});

test("role change: with a second owner the first may be demoted", async () => {
  const store = await makeStore("role2");
  const ownerA = await makeUser("role2-owner-a");
  const ownerB = await makeUser("role2-owner-b");
  const bMember = await makeMembership(ownerB.id, store.id, "OWNER");
  await makeMembership(ownerA.id, store.id, "OWNER");

  const demoteA = await svc.changeRole({ storeId: store.id, userId: ownerA.id, role: "MANAGER" });
  assert.equal(demoteA.ok, true, "demoting one of two owners is allowed");
  if (!demoteA.ok) return;

  const stillOwnerRows = await prisma.userStore.findMany({ where: { storeId: store.id, role: "OWNER", status: "ACTIVE" } });
  assert.equal(stillOwnerRows.length, 1);
  assert.equal(stillOwnerRows[0]?.userId, ownerB.id);
  void bMember;
});

test("role change: invalid role is rejected, non-member is not found", async () => {
  const store = await makeStore("role3");
  const owner = await makeUser("role3-owner");
  const member = await makeUser("role3-member");
  await makeMembership(owner.id, store.id, "OWNER");
  await makeMembership(member.id, store.id, "STAFF");
  const stranger = await makeUser("role3-stranger");

  const badRole = await svc.changeRole({ storeId: store.id, userId: member.id, role: "SUPER_ADMIN" });
  assert.equal(badRole.ok, false);
  if (!badRole.ok) assert.equal(badRole.error.type, "validation");

  const noMember = await svc.changeRole({ storeId: store.id, userId: stranger.id, role: "MANAGER" });
  assert.equal(noMember.ok, false);
  if (!noMember.ok) assert.equal(noMember.error.type, "not_found");
});

// ─────────────────────────────── A3: per-user access ───────────────────────────────

test("access: DEACTIVATED membership drops out of tenant resolution but login still works for other stores", async () => {
  const storeA = await makeStore("access-a");
  const storeB = await makeStore("access-b");
  const member = await makeUser("access-member", "shared-pass-123");
  await makeMembership(member.id, storeA.id, "STAFF");
  await makeMembership(member.id, storeB.id, "MANAGER");

  const deactivate = await svc.setUserAccess({ storeId: storeA.id, userId: member.id, status: "DEACTIVATED" });
  assert.equal(deactivate.ok, true);
  if (!deactivate.ok) return;
  assert.equal(deactivate.value.status, "DEACTIVATED");

  // The exact query resolveStoreId uses for tenant resolution: ACTIVE-only.
  const activeInA = await prisma.userStore.findFirst({ where: { userId: member.id, storeId: storeA.id, status: "ACTIVE" } });
  assert.equal(activeInA, null, "store A no longer resolves as an active tenant");
  const row = await prisma.userStore.findUnique({ where: { userId_storeId: { userId: member.id, storeId: storeA.id } } });
  assert.equal(row?.status, "DEACTIVATED");

  const activeInB = await prisma.userStore.findFirst({ where: { userId: member.id, storeId: storeB.id, status: "ACTIVE" } });
  assert.ok(activeInB, "store B membership is untouched");

  // Login is store-agnostic: still issues a token (the guard 403s per-store at route level).
  const login = await svc.login({ email: email("access-member"), password: "shared-pass-123" });
  assert.equal(login.ok, true, "deactivated users can still log in (other stores)");
  if (login.ok) assert.match(login.value.token, /^eyJ/);

  const reactivate = await svc.setUserAccess({ storeId: storeA.id, userId: member.id, status: "ACTIVE" });
  assert.equal(reactivate.ok, true);
  if (reactivate.ok) {
    const back = await prisma.userStore.findFirst({ where: { userId: member.id, storeId: storeA.id, status: "ACTIVE" } });
    assert.ok(back, "reactivated membership resolves again");
  }
});

test("access: cannot deactivate the last active owner", async () => {
  const store = await makeStore("access-owner");
  const owner = await makeUser("access-owner-user");
  await makeMembership(owner.id, store.id, "OWNER");

  const r = await svc.setUserAccess({ storeId: store.id, userId: owner.id, status: "DEACTIVATED" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "conflict");
});
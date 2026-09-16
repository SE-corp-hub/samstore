// Module 1 hardening — tenant context resolution tests (real Prisma, run-scoped fixtures).
// Verifies:
//  - ACTIVE per-store membership role is what authorizes (not the global JWT role)
//  - no demo/default tenant fallback: no ACTIVE membership → 403
//  - cross-store header substitution cannot escalate roles
//  - PLATFORM_ADMIN still requires an explicit store or membership

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import { prisma } from "../persistence/prisma-repositories.js";
import { hashPassword } from "./auth.domain.js";
import { resolveTenant, TENANT_ROLES } from "./tenant-context.js";
import type { AuthPrincipal } from "./auth.guard.js";

const run = `TNT${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];

function email(tag: string) {
  return `${run}-${tag}@example.test`.toLowerCase();
}

async function makeStore(tag: string) {
  const s = await prisma.store.create({ data: { slug: `${run}-${tag}`, name: `Tenant ${run} ${tag}` } });
  storeIds.push(s.id);
  return s;
}

async function makeUser(tag: string) {
  const u = await prisma.user.create({
    data: { email: email(tag), passwordHash: await hashPassword("fixture-password-123"), role: "STAFF" },
  });
  userIds.push(u.id);
  return u;
}

async function makeMembership(userId: string, storeId: string, role: string, status = "ACTIVE") {
  return prisma.userStore.create({
    data: { userId, storeId, role: role as "OWNER", status: status as "ACTIVE" },
  });
}

function principal(userId: string, role = "STAFF", storeId?: string): AuthPrincipal {
  return { sub: userId, role, email: "x@example.test", ...(storeId ? { storeId } : {}) };
}

async function expectForbidden(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return Number(e.getStatus());
    assert.fail(`expected HttpException, got ${String(e)}`);
  }
  assert.fail("expected HttpException");
}

after(async () => {
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

test("resolves the ACTIVE membership role for the selected store (not the global role)", async () => {
  const storeA = await makeStore("a1");
  const storeB = await makeStore("b1");
  const user = await makeUser("u1");
  await makeMembership(user.id, storeA.id, "OWNER");
  await makeMembership(user.id, storeB.id, "STAFF");

  const ctxB = await resolveTenant(principal(user.id), storeB.id, TENANT_ROLES.VIEW);
  assert.equal(ctxB.storeId, storeB.id);
  assert.equal(ctxB.role, "STAFF");

  const ctxA = await resolveTenant(principal(user.id), storeA.id, TENANT_ROLES.OWNER_MANAGER);
  assert.equal(ctxA.storeId, storeA.id);
  assert.equal(ctxA.role, "OWNER");
});

test("a STAFF membership cannot pass OWNER_MANAGER-gated endpoints", async () => {
  const storeA = await makeStore("a2");
  const user = await makeUser("u2");
  await makeMembership(user.id, storeA.id, "STAFF");

  const status = await expectForbidden(resolveTenant(principal(user.id), storeA.id, TENANT_ROLES.MANAGE));
  assert.equal(status, 403);
});

test("a user with NO active membership is denied — no demo-store fallback", async () => {
  const noMembership = await makeUser("u3");
  const status = await expectForbidden(resolveTenant(principal(noMembership.id)));
  assert.equal(status, 403);
});

test("header pointing at a store the user does not belong to is forbidden", async () => {
  const storeA = await makeStore("a4");
  const storeB = await makeStore("b4");
  const user = await makeUser("u4");
  await makeMembership(user.id, storeA.id, "OWNER");

  const status = await expectForbidden(resolveTenant(principal(user.id), storeB.id));
  assert.equal(status, 403);
});

test("token storeId claim is honored only when still an ACTIVE membership", async () => {
  const storeA = await makeStore("a5");
  const user = await makeUser("u5");
  await makeMembership(user.id, storeA.id, "MANAGER");

  const ctx = await resolveTenant(principal(user.id, "MANAGER", storeA.id));
  assert.equal(ctx.storeId, storeA.id);
  assert.equal(ctx.role, "MANAGER");
});

test("without header or claim, the first ACTIVE membership is used", async () => {
  const storeA = await makeStore("a6");
  const user = await makeUser("u6");
  await makeMembership(user.id, storeA.id, "SALES_AGENT");

  const ctx = await resolveTenant(principal(user.id));
  assert.equal(ctx.storeId, storeA.id);
  assert.equal(ctx.role, "SALES_AGENT");
});

test("deactivated membership is not usable via header", async () => {
  const storeA = await makeStore("a7");
  const user = await makeUser("u7");
  await makeMembership(user.id, storeA.id, "STAFF", "DEACTIVATED");

  const status = await expectForbidden(resolveTenant(principal(user.id), storeA.id));
  assert.equal(status, 403);
});

test("a platform-admin token needs an explicit store or an active membership", async () => {
  const storeA = await makeStore("a8");
  const user = await makeUser("u8");
  await makeMembership(user.id, storeA.id, "STAFF");

  const byHeader = await resolveTenant(principal(user.id, "PLATFORM_ADMIN"), storeA.id);
  assert.equal(byHeader.storeId, storeA.id);
  assert.equal(byHeader.role, "PLATFORM_ADMIN");

  const byMembership = await resolveTenant(principal(user.id, "PLATFORM_ADMIN"));
  assert.equal(byMembership.storeId, storeA.id);

  const storeless = await makeUser("u8b");
  const status = await expectForbidden(resolveTenant(principal(storeless.id, "PLATFORM_ADMIN")));
  assert.equal(status, 403);
});
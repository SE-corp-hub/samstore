// M7 — roles × permissions deny matrix. Deny-only semantics, tenant isolation,
// default-permissive fallback, and the resolveTenant overlay. Real Prisma (repo style),
// run-scoped + deleted fixtures.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { resolveTenant, TENANT_ROLES } from "./tenant-context.js";
import { effectiveRoleSets, listRolePermissions, setRolePermission } from "./role-permissions.js";
import type { AuthPrincipal } from "./auth.guard.js";

const run = `M7T${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];
const createdUserIds: string[] = [];

function tag(s: string) {
  return `${run}-${s}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: tag(`store-${slugSeq}`), status: "ACTIVE" },
  });
  createdStoreIds.push(s.id);
  return s;
}

async function makeMember(userId: string, storeId: string, role: string) {
  const user = await prisma.user.create({
    data: { id: userId, email: tag(`${userId}@x.test`), passwordHash: "x", role },
  });
  createdUserIds.push(user.id);
  await prisma.userStore.create({
    data: { userId, storeId, role: role as "STAFF", status: "ACTIVE" },
  });
  return user;
}

async function makeStoreUser(userId: string, storeId: string, role: string) {
  const user = await prisma.user.create({
    data: { id: userId, email: tag(`${userId}@x.test`), passwordHash: "x", role },
  });
  createdUserIds.push(user.id);
  return user;
}

function principal(userId: string, role = "STAFF", storeId?: string): AuthPrincipal {
  return { sub: userId, role, email: "x@example.test", ...(storeId ? { storeId } : {}) };
}

after(async () => {
  if (createdStoreIds.length > 0) {
    await prisma.rolePermission.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.userStore.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

test("default-permissive: no rows → effective sets equal the baseline", async () => {
  const store = await makeStore();
  const effective = await effectiveRoleSets(store.id);
  assert.deepEqual([...(effective.ADMIN as string[])], [...(TENANT_ROLES.ADMIN as readonly string[])]);
  assert.deepEqual([...(effective.DELIVERY as string[])], [...(TENANT_ROLES.DELIVERY as readonly string[])]);
});

test("deny STAFF the ADMIN set removes STAFF from that set only", async () => {
  const store = await makeStore();
  const r = await setRolePermission(store.id, "actor1", "store_owner", "STAFF", "ADMIN", false);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const effective = await effectiveRoleSets(store.id);
  assert.equal((effective.ADMIN as string[]).includes("STAFF"), false);
  assert.equal((effective.VIEW as string[]).includes("STAFF"), true);
  assert.equal((effective.ADMIN as string[]).includes("MANAGER"), true);
  // PLATFORM_ADMIN is never deniable
  assert.equal((effective.ADMIN as string[]).includes("PLATFORM_ADMIN"), true);
});

test("deny-only: cannot grant a capability a role lacks in the baseline", async () => {
  const store = await makeStore();
  // STAFF is not in MANAGE baseline → grant must fail
  const r = await setRolePermission(store.id, "actor1", "store_owner", "STAFF", "MANAGE", true);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("grant (allowed=true) restores the baseline (deletes the deny row)", async () => {
  const store = await makeStore();
  const deny = await setRolePermission(store.id, "actor1", "store_owner", "STAFF", "ADMIN", false);
  assert.equal(deny.ok, true);
  if (!deny.ok) return;

  const restore = await setRolePermission(store.id, "actor1", "store_owner", "STAFF", "ADMIN", true);
  assert.equal(restore.ok, true);

  const effective = await effectiveRoleSets(store.id);
  assert.equal((effective.ADMIN as string[]).includes("STAFF"), true);
});

test("missing row == today's behaviour (default-permissive guard fallback)", async () => {
  const store = await makeStore();
  await makeMember("u1", store.id, "STAFF");
  const ctx = await resolveTenant(principal("u1", "STAFF", store.id), store.id, TENANT_ROLES.ADMIN);
  assert.equal(ctx.storeId, store.id);
});

test("resolveTenant overlay: denied role → 403; unaffected role still passes", async () => {
  const store = await makeStore();
  await makeMember("staff-u", store.id, "STAFF");
  await makeMember("mgr-u", store.id, "MANAGER");
  await setRolePermission(store.id, "actor1", "store_owner", "STAFF", "ADMIN", false);

  // STAFF denied ADMIN → 403
  try {
    await resolveTenant(principal("staff-u", "STAFF", store.id), store.id, TENANT_ROLES.ADMIN);
    assert.fail("expected 403 for denied STAFF/ADMIN");
  } catch (e) {
    assert.equal((e as any).status ?? (e as any).getStatus?.(), 403);
  }
  // MANAGER unaffected → passes
  const ctx = await resolveTenant(principal("mgr-u", "MANAGER", store.id), store.id, TENANT_ROLES.ADMIN);
  assert.equal(ctx.storeId, store.id);
  // view still allowed for STAFF
  const ctxView = await resolveTenant(principal("staff-u", "STAFF", store.id), store.id, TENANT_ROLES.VIEW);
  assert.equal(ctxView.storeId, store.id);
});

test("matrix is store-scoped (cross-tenant isolation)", async () => {
  const storeA = await makeStore();
  const storeB = await makeStore();
  await setRolePermission(storeA.id, "actor1", "store_owner", "STAFF", "ADMIN", false);

  const effA = await effectiveRoleSets(storeA.id);
  const effB = await effectiveRoleSets(storeB.id);
  assert.equal((effA.ADMIN as string[]).includes("STAFF"), false);
  assert.equal((effB.ADMIN as string[]).includes("STAFF"), true);
});

test("listRolePermissions derives allowed per role × key from baseline + rows", async () => {
  const store = await makeStore();
  await setRolePermission(store.id, "actor1", "store_owner", "STAFF", "ADMIN", false);
  const { keys, cells } = await listRolePermissions(store.id);

  assert.ok(keys.includes("ADMIN") && keys.includes("VIEW") && keys.includes("MANAGE"));
  const staffAdmin = cells.find((c) => c.role === "STAFF" && c.key === "ADMIN");
  assert.equal(staffAdmin?.allowed, false);
  const staffView = cells.find((c) => c.role === "STAFF" && c.key === "VIEW");
  assert.equal(staffView?.allowed, true);
  const ownerManage = cells.find((c) => c.role === "OWNER" && c.key === "MANAGE");
  assert.equal(ownerManage?.allowed, true);
  const agentManage = cells.find((c) => c.role === "SALES_AGENT" && c.key === "MANAGE");
  assert.equal(agentManage?.allowed, false); // not in baseline → not allowed
});
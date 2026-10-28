import { test } from "node:test";
import assert from "node:assert/strict";
import { TeamService, INVITABLE_STORE_ROLES } from "./team.service.js";

const svc = new TeamService();

test("invitable roles are manager/staff/sales-agent/delivery", () => {
  assert.deepEqual([...INVITABLE_STORE_ROLES], ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"]);
});

test("invite rejects invalid email", async () => {
  const r = await svc.invite("cmtifdks2000094ic1j9w8th7", "not-an-email", null, "STAFF");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("invite rejects non-invitable role", async () => {
  const r = await svc.invite("cmtifdks2000094ic1j9w8th7", "x@y.com", null, "OWNER");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("invite rejects unknown store", async () => {
  const r = await svc.invite("store-does-not-exist", "x@y.com", null, "STAFF");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});
// Team shows who added each person and who last set their PIN or reset their password.
test("list says who added a member and who last reset their PIN or password", async () => {
  const { prisma } = await import("../persistence/prisma-repositories.js");
  const run = `teamhist-${Date.now()}`;
  const store = await prisma.store.create({ data: { name: `${run} store`, slug: run } });
  const owner = await prisma.user.create({ data: { email: `${run}-owner@example.test`, name: "Owner Ana", passwordHash: "x", role: "STORE_OWNER" } });
  try {
    await prisma.userStore.create({ data: { userId: owner.id, storeId: store.id, role: "OWNER", status: "ACTIVE" } });
    const inv = await svc.invite(store.id, `${run}-staff@example.test`, "Staff Ben", "STAFF", null, undefined, owner.id);
    assert.equal(inv.ok, true);
    if (!inv.ok) return;
    await prisma.auditLog.create({ data: { storeId: store.id, actorType: "USER", actorId: owner.id, action: "member.people.update", entityType: "User", entityId: inv.value.userId, after: { pinChanged: true } } });
    await prisma.passwordResetHistory.create({ data: { userId: inv.value.userId, storeId: store.id, resetBy: owner.id, createdAt: new Date(Date.now() + 60_000) } });

    const list = await svc.list(store.id);
    const ben = list.find((m) => m.userId === inv.value.userId);
    assert.equal(ben?.addedBy, "Owner Ana");
    assert.equal(ben?.lastReset?.kind, "password"); // the newer of the two
    assert.equal(ben?.lastReset?.by, "Owner Ana");
    const ana = list.find((m) => m.userId === owner.id);
    assert.equal(ana?.addedBy, null); // added before this was recorded
    assert.equal(ana?.lastReset, null);
  } finally {
    const users = (await prisma.userStore.findMany({ where: { storeId: store.id }, select: { userId: true } })).map((u) => u.userId);
    await prisma.auditLog.deleteMany({ where: { storeId: store.id } });
    await prisma.passwordResetHistory.deleteMany({ where: { storeId: store.id } });
    await prisma.userStore.deleteMany({ where: { storeId: store.id } });
    await prisma.user.deleteMany({ where: { id: { in: [...users, owner.id] } } });
    await prisma.store.delete({ where: { id: store.id } });
    await prisma.$disconnect();
  }
});

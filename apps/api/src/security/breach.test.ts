import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { SecurityIncidentService, PendingNpcBreachNotifier } from "./breach.service.js";

const service = new SecurityIncidentService();
const run = `P10C${Date.now()}`;
const stores: string[] = [];

async function makeStore() {
  const s = await prisma.store.create({ data: { name: `${run} store`, slug: `${run}-${stores.length}`, status: "ACTIVE" } });
  stores.push(s.id);
  return s;
}

after(async () => {
  for (const storeId of stores) {
    await prisma.auditLog.deleteMany({ where: { storeId } });
    await prisma.securityIncident.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

test("incident creation is audited and NPC notification stays pending", async () => {
  const store = await makeStore();
  const created = await service.create(store.id, "owner-1", { title: "Suspected token exposure", severity: "HIGH", details: { source: "security review" } });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.status, "OPEN");

  const pending = await service.notifyNpc(store.id, created.value.id, "owner-1");
  assert.equal(pending.ok, true);
  if (pending.ok) assert.equal(pending.value.status, "PENDING_OPERATOR");

  assert.equal(await prisma.auditLog.count({ where: { storeId: store.id } }), 2);
  assert.equal((await service.list(store.id)).length, 1);
});

test("containment and tenant isolation", async () => {
  const a = await makeStore();
  const b = await makeStore();
  const created = await service.create(a.id, "owner-a", { title: "Incident", severity: "MEDIUM" });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const cross = await service.contain(b.id, created.value.id, "owner-b");
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.error.type, "not_found");

  const contained = await service.contain(a.id, created.value.id, "owner-a");
  assert.equal(contained.ok, true);
  if (contained.ok) assert.equal(contained.value.status, "CONTAINED");
});

test("pending notifier is honest and never claims delivery", () => {
  const n = new PendingNpcBreachNotifier();
  assert.equal(n.ready(), false);
  assert.equal(n.name, "pending");
});

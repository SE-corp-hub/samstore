// P10a: privacy retention — preview + explicit purge, tenant-scoped, consent retained.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { PrivacyRetentionService } from "./retention.service.js";

const service = new PrivacyRetentionService();
const run = `P10A${Date.now()}${Math.floor(Math.random() * 1000)}`;
const stores: string[] = [];

async function makeStore(days: number) {
  const s = await prisma.store.create({ data: { name: `${run} store`, slug: `${run}-${stores.length}`.toLowerCase(), status: "ACTIVE", settings: { create: { privacyRetentionDays: days } } } });
  stores.push(s.id);
  return s;
}

after(async () => {
  for (const storeId of stores) {
    await prisma.auditLog.deleteMany({ where: { storeId } });
    await prisma.message.deleteMany({ where: { storeId } });
    await prisma.conversation.deleteMany({ where: { storeId } });
    const customerIds = (await prisma.storeCustomer.findMany({ where: { storeId }, select: { customerId: true } })).map((x) => x.customerId);
    if (customerIds.length) await prisma.consentRecord.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.storeCustomer.deleteMany({ where: { storeId } });
    if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.storeSettings.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

test("preview + purge removes old conversation data, retains consent, and audits", async () => {
  const store = await makeStore(30);
  const old = new Date(Date.now() - 60 * 86_400_000);
  const oldConv = await prisma.conversation.create({ data: { storeId: store.id, contactPsid: "old", lastActivityAt: old, createdAt: old } });
  await prisma.message.create({ data: { storeId: store.id, conversationId: oldConv.id, sender: "customer", body: "old", createdAt: old } });
  const customer = await prisma.customer.create({ data: { name: "Privacy Customer", phone: `+6391${Date.now()}`, passwordHash: null } });
  await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: customer.id } });
  await prisma.consentRecord.create({ data: { customerId: customer.id, scope: "dpv1", channel: "web", granted: true } });
  const fresh = await prisma.conversation.create({ data: { storeId: store.id, contactPsid: "fresh", lastActivityAt: new Date(), createdAt: new Date() } });
  await prisma.message.create({ data: { storeId: store.id, conversationId: fresh.id, sender: "customer", body: "fresh", createdAt: new Date() } });

  const preview = await service.preview(store.id);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.value.conversations, 1);
  assert.equal(preview.value.messages, 1);

  const purged = await service.purge(store.id, "owner-1");
  assert.equal(purged.ok, true);
  if (!purged.ok) return;
  assert.equal(purged.value.deletedConversations, 1);
  assert.equal(await prisma.conversation.count({ where: { id: oldConv.id } }), 0);
  assert.equal(await prisma.conversation.count({ where: { id: fresh.id } }), 1);
  assert.equal(await prisma.consentRecord.count({ where: { customerId: customer.id } }), 1, "consent retained");
  assert.equal(await prisma.auditLog.count({ where: { storeId: store.id, action: "privacy.retention.purge" } }), 1);
});

test("retention disabled is safe and purge refuses destructive action", async () => {
  const store = await makeStore(0);
  const preview = await service.preview(store.id);
  assert.deepEqual(preview, { ok: true, value: { retentionDays: 0, cutoff: null, conversations: 0, messages: 0 } });
  const purge = await service.purge(store.id, "owner-1");
  assert.equal(purge.ok, false);
  if (!purge.ok) assert.equal(purge.error.type, "conflict");
});

test("retention is tenant-scoped", async () => {
  const a = await makeStore(30);
  const b = await makeStore(30);
  const old = new Date(Date.now() - 60 * 86_400_000);
  const c = await prisma.conversation.create({ data: { storeId: a.id, contactPsid: "a", lastActivityAt: old, createdAt: old } });
  await prisma.message.create({ data: { storeId: a.id, conversationId: c.id, sender: "customer", body: "a", createdAt: old } });
  const bPreview = await service.preview(b.id);
  assert.equal(bPreview.ok, true);
  if (bPreview.ok) assert.equal(bPreview.value.conversations, 0);
});

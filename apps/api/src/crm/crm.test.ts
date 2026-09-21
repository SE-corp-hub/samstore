// P8: CRM — aggregates, segmentation, tags, idempotent campaigns → outbox.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { CrmService } from "./crm.service.js";
import { OutboxWorker } from "../notifications/outbox.service.js";

const crm = new CrmService();
const run = `P8C${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE", settings: { create: {} } },
  });
  createdStoreIds.push(s.id);
  return s;
}

async function makeCustomer(storeId: string, over: { tags?: string[]; creditBalanceMinor?: number } = {}) {
  const c = await prisma.customer.create({ data: { name: `Buyer ${slugSeq}`, phone: `+63919888${String(slugSeq).padStart(5, "0")}`, email: null, passwordHash: null } });
  const sc = await prisma.storeCustomer.create({
    data: { storeId, customerId: c.id, tags: over.tags ?? [], creditBalanceMinor: over.creditBalanceMinor ?? 0 },
  });
  return { customerId: c.id, storeCustomerId: sc.id };
}

async function makeFulfilledOrder(storeId: string, storeCustomerId: string, totalMinor: number, productName: string, createdAt?: Date) {
  const seq = await prisma.storeCounter.upsert({
    where: { storeId_kind: { storeId, kind: "ORDER_SEQ" } },
    update: { value: { increment: 1 } },
    create: { storeId, kind: "ORDER_SEQ", value: 1 },
  });
  const o = await prisma.order.create({
    data: {
      orderNumber: `${run}-${storeId.slice(-5)}-${seq.value}`.toUpperCase(),
      storeId,
      status: "COMPLETED",
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: totalMinor,
      deliveryFeeMinor: 0,
      discountMinor: 0,
      totalMinor,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: "COLLECTED",
      idempotencyKey: `${run}-${storeId.slice(-5)}-${seq.value}`,
      cartToken: "",
      customerName: "Buyer",
      customerPhone: "+63",
      deliveryAddressLine1: "",
      storeCustomerId,
      createdAt: createdAt ?? new Date(),
    },
  });
  await prisma.orderItem.create({ data: { storeId, orderId: o.id, productName, sku: "X", unitPriceMinor: totalMinor, quantity: 1, lineTotalMinor: totalMinor } });
  return o;
}

async function optInMessenger(storeId: string, customerId: string, psid: string) {
  await prisma.messengerUser.create({ data: { storeId, customerId, psid, optedIn: true } });
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
      if (orderIds.length) {
        await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.campaignRecipient.deleteMany({ where: { storeId } });
      await prisma.campaign.deleteMany({ where: { storeId } });
      await prisma.messengerUser.deleteMany({ where: { storeId } });
      const customers = (await prisma.storeCustomer.findMany({ where: { storeId }, select: { customerId: true } })).map((c) => c.customerId);
      await prisma.storeCustomer.deleteMany({ where: { storeId } });
      if (customers.length) await prisma.customer.deleteMany({ where: { id: { in: customers } } });
      await prisma.notificationLog.deleteMany({ where: { storeId } });
      await prisma.outboxEvent.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.storeCounter.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("aggregates compute LTV/AOV/orders/favorite from FULFILLED orders only", async () => {
  const store = await makeStore();
  const c = await makeCustomer(store.id);
  await makeFulfilledOrder(store.id, c.storeCustomerId, 10000, "Kape");
  await makeFulfilledOrder(store.id, c.storeCustomerId, 5000, "Kape");
  await makeFulfilledOrder(store.id, c.storeCustomerId, 3000, "Turon");
  // An unfulfilled order must NOT count toward LTV.
  const seq = await prisma.storeCounter.upsert({
    where: { storeId_kind: { storeId: store.id, kind: "ORDER_SEQ" } },
    update: { value: { increment: 1 } },
    create: { storeId: store.id, kind: "ORDER_SEQ", value: 1 },
  });
  await prisma.order.create({
    data: { orderNumber: `${run}-${store.id.slice(-5)}-${seq.value}`, storeId: store.id, status: "RECEIVED", source: "online", currencyCode: "PHP", subtotalMinor: 9000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 9000, snapshot: {}, paymentMethod: "cod", paymentStatus: "PENDING", idempotencyKey: `${run}-${store.id.slice(-5)}-${seq.value}x`, cartToken: "", customerName: "B", customerPhone: "+63", deliveryAddressLine1: "", storeCustomerId: c.storeCustomerId },
  });

  const rows = await crm.aggregates(store.id);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.orders, 3);
  assert.equal(r.ltvMinor, 18000);
  assert.equal(r.aovMinor, 6000);
  assert.equal(r.favoriteProduct, "Kape");
  assert.ok(r.daysSinceLastOrder !== null);
});

test("tags set + round-trip; segmentation filters by LTV/recency/credit/tag/messenger", async () => {
  const store = await makeStore();
  const vip = await makeCustomer(store.id, { tags: ["vip"] });
  const utang = await makeCustomer(store.id, { creditBalanceMinor: 5000 });
  await makeFulfilledOrder(store.id, vip.storeCustomerId, 10000, "Kape", new Date(Date.now() - 60 * 86_400_000));

  const tags = await crm.setTags(store.id, vip.storeCustomerId, ["vip", "bday"]);
  assert.equal(tags.ok, true);
  if (!tags.ok) return;
  assert.deepEqual(tags.value.tags, ["vip", "bday"]);

  const rows = await crm.aggregates(store.id);
  const vipRow = rows.find((r) => r.storeCustomerId === vip.storeCustomerId);
  assert.equal(vipRow?.ltvMinor, 10000);
  assert.equal(vipRow?.tags.join(","), "vip,bday");

  assert.equal(crm.segment(rows, { minLtvMinor: 10000 }).length, 1);
  assert.equal(crm.segment(rows, { tag: "vip" }).length, 1);
  assert.equal(crm.segment(rows, { hasCredit: true }).length, 1);
  assert.equal(crm.segment(rows, { minLtvMinor: 99999 }).length, 0);
  // At-risk: has ordered, but not within 30 days.
  assert.equal(crm.segment(rows, { maxDaysSinceLastOrder: 30 }).length, 1);
});

test("campaign run is idempotent and enqueues one campaign.send per opted-in user", async () => {
  const store = await makeStore();
  const c = await makeCustomer(store.id);
  await makeFulfilledOrder(store.id, c.storeCustomerId, 8000, "Kape");
  await optInMessenger(store.id, c.customerId, "PSID-CAMP");

  const created = await crm.createCampaign(store.id, "Follow up", { minLtvMinor: 5000 }, "Hi! Come back for a treat!");
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const run = await crm.runCampaign(store.id, created.value.id);
  assert.equal(run.ok, true);
  if (!run.ok) return;
  assert.equal(run.value.recipients, 1);

  const ev = await prisma.outboxEvent.findFirst({ where: { storeId: store.id, eventType: "campaign.send" } });
  assert.ok(ev, "outbox event enqueued");
  assert.equal((ev?.payload as Record<string, unknown>).psid, "PSID-CAMP");

  const campaign = await prisma.campaign.findUnique({ where: { id: created.value.id } });
  assert.equal(campaign?.status, "SENT");
  assert.equal(campaign?.recipientCount, 1);

  // Idempotent: re-run is a conflict; the worker drains → suppressed NotificationLog.
  const again = await crm.runCampaign(store.id, created.value.id);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error.type, "conflict");

  const processed = await new OutboxWorker().poll(20);
  assert.equal(processed, 1);
  const log = await prisma.notificationLog.findFirst({ where: { storeId: store.id, template: "campaign.send" } });
  assert.ok(log, "campaign.send logged (suppressed)");
  assert.equal(log?.delivered, false);
});
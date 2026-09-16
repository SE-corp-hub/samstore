// Module 9 — outbox worker: PENDING events are drained to PROCESSED with the
// NotificationLog side effect; failures retry with backoff and eventually FAIL.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { OutboxWorker, enqueueOutboxEvent } from "./outbox.service.js";

const run = `OBX${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const eventIds: string[] = [];
const logIds: string[] = [];
let slugSeq = 0;

async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({ data: { slug: `${run}-s${slugSeq}`.toLowerCase(), name: `Outbox ${run}` } });
  storeIds.push(s.id);
  return s;
}

after(async () => {
  if (storeIds.length) {
    // Defensive: remove ANY outbox/notification rows that reference these stores
    // (including orphans from an aborted earlier run of this file), so the store
    // delete never hits an FK violation.
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

test("worker drains an order.received event → PROCESSED + NotificationLog row", async () => {
  const store = await makeStore();
  await enqueueOutboxEvent({
    storeId: store.id,
    aggregateType: "order",
    aggregateId: "ord-x",
    eventType: "order.received",
    payload: { orderNumber: "SAMSTO-9", psid: "psid-9", text: "Order SAMSTO-9 received." },
  });
  const ev = await prisma.outboxEvent.findFirst({ where: { storeId: store.id, eventType: "order.received" } });
  eventIds.push(ev!.id);

  assert.equal(ev?.status, "PENDING");
  const worker = new OutboxWorker();
  const processed = await worker.poll();
  assert.equal(processed, 1, "one event processed");

  const afterPoll = await prisma.outboxEvent.findUnique({ where: { id: ev!.id } });
  assert.equal(afterPoll?.status, "PROCESSED");
  assert.ok(afterPoll?.processedAt, "processedAt stamped");

  const log = await prisma.notificationLog.findFirst({ where: { storeId: store.id, template: "order.received" } });
  assert.ok(log, "NotificationLog side effect written");
  logIds.push(log!.id);
  assert.equal(log?.recipient, "psid-9");
});

test("a PROCESSED event is not re-processed (idempotent drain)", async () => {
  const store = await makeStore();
  const ev = await prisma.outboxEvent.create({
    data: {
      storeId: store.id,
      aggregateType: "order",
      aggregateId: "ord-y",
      eventType: "notification.send",
      payload: { text: "hi" },
      status: "PROCESSED",
      processedAt: new Date(),
    },
  });
  eventIds.push(ev.id);
  const worker = new OutboxWorker();
  const processed = await worker.poll();
  assert.equal(processed, 0, "PROCESSED rows are skipped");
});

test("a failing event retries with attempts++ and backoff, then FAILS after max attempts", async () => {
  const store = await makeStore();
  // Missing text makes the handler throw deterministically (guard in handle()).
  const ev = await prisma.outboxEvent.create({
    data: {
      storeId: store.id,
      aggregateType: "order",
      aggregateId: "ord-z",
      eventType: "order.received",
      payload: { orderNumber: "X" },
      status: "PENDING",
      nextAttemptAt: new Date(Date.now() - 1000),
      attempts: 4,
    },
  });
  eventIds.push(ev.id);
  const worker = new OutboxWorker();
  await worker.poll();
  const after = await prisma.outboxEvent.findUnique({ where: { id: ev.id } });
  assert.equal(after?.status, "FAILED", "max attempts reached → FAILED");
  assert.equal(after?.attempts, 5);
  assert.ok(after?.lastError && after.lastError.length > 0, "lastError recorded");
});
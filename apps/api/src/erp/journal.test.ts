// P9: ERP double-entry journal — balancing entries, auto-posting (idempotent), reports.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { JournalService } from "./journal.service.js";

const journal = new JournalService();
const run = `P9E${Date.now()}${Math.floor(Math.random() * 1000)}`;
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

async function makeOrder(storeId: string, over: { status?: string; subtotalMinor?: number; deliveryFeeMinor?: number } = {}) {
  const seq = await prisma.storeCounter.upsert({
    where: { storeId_kind: { storeId, kind: "ORDER_SEQ" } },
    update: { value: { increment: 1 } },
    create: { storeId, kind: "ORDER_SEQ", value: 1 },
  });
  const subtotal = over.subtotalMinor ?? 10000;
  const fee = over.deliveryFeeMinor ?? 2000;
  const o = await prisma.order.create({
    data: {
      orderNumber: `${run}-${storeId.slice(-5)}-${seq.value}`.toUpperCase(),
      storeId,
      status: (over.status ?? "COMPLETED") as never,
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: subtotal,
      deliveryFeeMinor: fee,
      discountMinor: 0,
      totalMinor: subtotal + fee,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: "COLLECTED",
      idempotencyKey: `${run}-${storeId.slice(-5)}-${seq.value}`,
      cartToken: "",
      customerName: "B",
      customerPhone: "+63",
      deliveryAddressLine1: "",
    },
  });
  await prisma.orderItem.create({ data: { storeId, orderId: o.id, productName: "Kape", sku: "X", unitPriceMinor: subtotal, quantity: 1, lineTotalMinor: subtotal } });
  return o;
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
      await prisma.journalEntryLine.deleteMany({ where: { storeId } });
      await prisma.journalEntry.deleteMany({ where: { storeId } });
      await prisma.account.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.storeCounter.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("chart of accounts is seeded; manual entries must balance", async () => {
  const store = await makeStore();
  await journal.ensureChart(store.id);
  const accounts = await prisma.account.findMany({ where: { storeId: store.id } });
  assert.equal(accounts.length, 9);

  const bad = await journal.postEntry(store.id, { reference: "x1", lines: [{ accountCode: "1000", debitMinor: 100 }, { accountCode: "4000", creditMinor: 99 }] });
  assert.equal(bad.ok, false);

  const ok = await journal.postEntry(store.id, { reference: "x2", lines: [{ accountCode: "1000", debitMinor: 500 }, { accountCode: "4000", creditMinor: 500 }] });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  const tb = await journal.trialBalance(store.id);
  assert.equal(tb.balanced, true);
});

test("postOrder is idempotent and posts sale + COGS (balanced, correct P&L)", async () => {
  const store = await makeStore();
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-p`, name: "Kape", priceMinor: 10000, costMinor: 4000 } });
  const seq = await prisma.storeCounter.upsert({
    where: { storeId_kind: { storeId: store.id, kind: "ORDER_SEQ" } },
    update: { value: { increment: 1 } },
    create: { storeId: store.id, kind: "ORDER_SEQ", value: 1 },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `${run}-${store.id.slice(-5)}-${seq.value}`.toUpperCase(),
      storeId: store.id,
      status: "COMPLETED",
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: 10000,
      deliveryFeeMinor: 2000,
      discountMinor: 0,
      totalMinor: 12000,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: "COLLECTED",
      idempotencyKey: `${run}-${store.id.slice(-5)}-${seq.value}`,
      cartToken: "",
      customerName: "B",
      customerPhone: "+63",
      deliveryAddressLine1: "",
    },
  });
  await prisma.orderItem.create({ data: { storeId: store.id, orderId: order.id, productId: product.id, productName: "Kape", sku: "X", unitPriceMinor: 10000, quantity: 2, lineTotalMinor: 20000 } });

  const r1 = await journal.postOrder(store.id, order.id);
  assert.equal(r1.ok, true);
  const r2 = await journal.postOrder(store.id, order.id);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.id, r2.value.id, "idempotent — same entry on replay");

  const entries = await prisma.journalEntry.count({ where: { storeId: store.id, source: "sale" } });
  assert.equal(entries, 1);

  const tb = await journal.trialBalance(store.id);
  assert.equal(tb.balanced, true);

  // P&L: revenue 12000, COGS = cost 4000 × 2 = 8000.
  const stmt = await journal.incomeStatement(store.id, new Date(0), new Date());
  assert.equal(stmt.revenueMinor, 12000);
  assert.equal(stmt.cogsMinor, 8000);
  assert.equal(stmt.grossProfitMinor, 4000);
  assert.equal(stmt.netProfitMinor, 4000);
});

test("postOrder rejects unfulfilled orders; backfill is idempotent", async () => {
  const store = await makeStore();
  const pending = await makeOrder(store.id, { status: "RECEIVED" });
  const blocked = await journal.postOrder(store.id, pending.id);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.type, "conflict");

  const done = await makeOrder(store.id, { status: "COMPLETED", subtotalMinor: 5000, deliveryFeeMinor: 0 });
  const b1 = await journal.backfill(store.id);
  assert.equal(b1.orders, 1, "only the fulfilled order posts");
  const b2 = await journal.backfill(store.id);
  assert.equal(b2.orders, 0, "second backfill posts nothing");
  const entries = await prisma.journalEntry.count({ where: { storeId: store.id, source: "sale" } });
  assert.equal(entries, 1);
});

test("expense posts DR Expenses / CR Cash, idempotent", async () => {
  const store = await makeStore();
  const expense = await prisma.expense.create({ data: { storeId: store.id, category: "rent", amountMinor: 3000, note: "Rent" } });
  const r1 = await journal.postExpense(store.id, expense.id);
  assert.equal(r1.ok, true);
  const r2 = await journal.postExpense(store.id, expense.id);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.value.id, r2.value.id);

  const stmt = await journal.incomeStatement(store.id, new Date(0), new Date());
  assert.equal(stmt.expensesMinor, 3000);
});
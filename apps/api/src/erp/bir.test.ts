// P9: BIR exports — Sales Journal + Cash Receipts Journal CSV + e-invoice honesty.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { BirService, PendingEInvoiceAdapter, EInvoiceUnavailableError } from "./bir.service.js";

const bir = new BirService();
const run = `P9B${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE", settings: { create: { tin: "123-456-789-000", vatEnabled: true, vatRateBp: 1200 } } },
  });
  createdStoreIds.push(s.id);
  return s;
}

async function makeOrder(storeId: string) {
  const seq = await prisma.storeCounter.upsert({
    where: { storeId_kind: { storeId, kind: "ORDER_SEQ" } },
    update: { value: { increment: 1 } },
    create: { storeId, kind: "ORDER_SEQ", value: 1 },
  });
  return prisma.order.create({
    data: {
      orderNumber: `${run}-${storeId.slice(-5)}-${seq.value}`.toUpperCase(),
      storeId,
      status: "COMPLETED",
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: 11200,
      deliveryFeeMinor: 800,
      discountMinor: 0,
      totalMinor: 12000,
      vatExemptMinor: 0,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: "COLLECTED",
      idempotencyKey: `${run}-${storeId.slice(-5)}-${seq.value}`,
      cartToken: "",
      customerName: 'Maria "M" Santos',
      customerPhone: "+63",
      deliveryAddressLine1: "",
    },
  });
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
      if (orderIds.length) {
        await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.storeCounter.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("Sales Journal CSV includes the fulfilled order with VAT/TIN columns", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);

  const csv = await bir.salesJournalCsv(store.id, new Date(0), new Date());
  const lines = csv.split("\n");
  assert.match(lines[0]!, /Date,Receipt No,Customer,TIN,Gross Sales,VATable Amount,VAT,Exempt Sales,Discount/);
  assert.equal(lines.length, 2, "header + one row");
  const rowCells = lines[1]!.split(",");
  assert.equal(rowCells[1], order.orderNumber);
  assert.equal(rowCells[2], '"Maria ""M"" Santos"', "CSV escaping");
  assert.equal(rowCells[3], "123-456-789-000", "store TIN printed");
  assert.equal(rowCells[4], "120", "gross sales in pesos");
  assert.equal(rowCells[5], "112", "vatable (net − delivery 8)");
  assert.equal(rowCells[6], "13.44", "12% VAT of 112");
});

test("Cash Receipts Journal CSV lists cash received", async () => {
  const store = await makeStore();
  const order = await makeOrder(store.id);
  await prisma.payment.create({ data: { storeId: store.id, orderId: order.id, method: "cash", amountMinor: 12000, type: "payment" } });

  const csv = await bir.cashReceiptsJournalCsv(store.id, new Date(0), new Date());
  const lines = csv.split("\n");
  assert.match(lines[0]!, /Date,Receipt No,Customer,Received,Change/);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.includes(order.orderNumber));
  assert.ok(lines[1]!.includes(",120,"), "received amount in pesos");
});

test("e-invoice adapter is honestly PENDING_CREDENTIALS", async () => {
  const adapter = new PendingEInvoiceAdapter();
  assert.equal(adapter.ready(), false, "no BIR_CSF_CREDENTIALS in test env");
  await assert.rejects(() => adapter.submitInvoice(), EInvoiceUnavailableError);
});
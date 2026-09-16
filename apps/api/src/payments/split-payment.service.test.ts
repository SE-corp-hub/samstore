// N2 — split / partial payments + tender/change + the payment-method registry (real DB).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import { SplitPaymentService } from "./split-payment.service.js";

const run = `N2${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const customerIds: string[] = [];
let slugSeq = 0;

after(async () => {
  if (storeIds.length) {
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.cashMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.registerSession.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.register.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.payment.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.creditEntry.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.orderClaimToken.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.orderStatusHistory.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.orderItem.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.storeCustomer.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.paymentMethod.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.storeSettings.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.storeCounter.deleteMany({ where: { storeId: { in: storeIds } } });
    if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

interface Fixture {
  storeId: string;
  orderId: string;
  storeCustomerId: string | null;
  customerId: string | null;
}

async function fixture(totalMinor = 50000, opts: { withCreditCustomer?: boolean; creditLimitMinor?: number; status?: "COMPLETED" | "RECEIVED" } = {}): Promise<Fixture> {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: { slug: `${run}-s${slugSeq}`.toLowerCase(), name: `N2 ${run}`, settings: { create: { requireOpenShift: false } } },
  });
  storeIds.push(store.id);

  let storeCustomerId: string | null = null;
  let customerId: string | null = null;
  if (opts.withCreditCustomer) {
    const customer = await prisma.customer.create({ data: { name: `N2 Buyer ${slugSeq}`, phone: null, email: null, passwordHash: null } });
    customerIds.push(customer.id);
    const sc = await prisma.storeCustomer.create({
      data: { storeId: store.id, customerId: customer.id, creditApproved: true, creditLimitMinor: opts.creditLimitMinor ?? 1_000_000, creditBalanceMinor: 0 },
    });
    storeCustomerId = sc.id;
    customerId = customer.id;
  }

  const orderId = randomId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `N2-${orderId.slice(0, 6)}`,
      storeId: store.id,
      status: opts.status ?? "COMPLETED",
      currencyCode: "PHP",
      deliveryType: "pickup",
      fulfillmentType: "PICKUP",
      subtotalMinor: totalMinor,
      totalMinor,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: "PENDING",
      idempotencyKey: randomId(),
      cartToken: randomId(),
      deliveryAddressLine1: "",
      customerName: "N2 Buyer",
      customerPhone: "+639****0003",
      storeCustomerId,
    },
  });
  return { storeId: store.id, orderId, storeCustomerId, customerId };
}

test("split payment: ₱200 cash + ₱300 utang settles the order, writes the ledger and flips COLLECTED", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(50000, { withCreditCustomer: true, creditLimitMinor: 100000 });

  const res = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-split-${fx.orderId}`,
    tenders: [
      { methodCode: "cash", amountMinor: 20000 },
      { methodCode: "credit", amountMinor: 30000 },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const s = res.ok ? res.value : null;
  assert.equal(s?.tenders.length, 2);
  assert.equal(s?.paidMinor, 50000);
  assert.equal(s?.outstandingMinor, 0);
  assert.equal(s?.settlement, "PAID");

  const order = await prisma.order.findUnique({ where: { id: fx.orderId }, select: { paymentStatus: true } });
  assert.equal(order?.paymentStatus, "COLLECTED");

  // The credit side wrote exactly one ledger entry + balance.
  const entries = await prisma.creditEntry.findMany({ where: { orderId: fx.orderId } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.amountMinor, 30000);
  assert.equal(entries[0]!.type, "purchase");
  const sc = await prisma.storeCustomer.findUnique({ where: { id: fx.storeCustomerId! }, select: { creditBalanceMinor: true } });
  assert.equal(sc?.creditBalanceMinor, 30000);
});

test("partial payment: the balance stays outstanding and PARTIAL is derived (nothing is stored)", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(50000);

  const res = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-partial-${fx.orderId}`,
    tenders: [{ methodCode: "cash", amountMinor: 20000 }],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const s = res.ok ? res.value : null;
  assert.equal(s?.settlement, "PARTIAL");
  assert.equal(s?.outstandingMinor, 30000);

  const order = await prisma.order.findUnique({ where: { id: fx.orderId }, select: { paymentStatus: true } });
  assert.equal(order?.paymentStatus, "PENDING", "not fully paid → the order's own status is untouched");

  // Settling the rest flips it.
  const rest = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-rest-${fx.orderId}`,
    tenders: [{ methodCode: "cash", amountMinor: 30000 }],
  });
  assert.equal(rest.ok, true, JSON.stringify(rest));
  assert.equal(rest.ok && rest.value.settlement, "PAID");
  assert.equal((await prisma.order.findUnique({ where: { id: fx.orderId }, select: { paymentStatus: true } }))?.paymentStatus, "COLLECTED");
});

test("overpayment is rejected and writes nothing", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(10000);

  const res = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-over-${fx.orderId}`,
    tenders: [{ methodCode: "cash", amountMinor: 12000 }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.type, "conflict");
  assert.equal(await prisma.payment.count({ where: { orderId: fx.orderId } }), 0, "no partial writes");
});

test("cash tender/change: handing over ₱500 for a ₱300 charge records ₱200 change", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(30000);

  const res = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-change-${fx.orderId}`,
    tenders: [{ methodCode: "cash", amountMinor: 30000, tenderedMinor: 50000 }],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = await prisma.payment.findFirst({ where: { orderId: fx.orderId }, select: { tenderedMinor: true, changeMinor: true, amountMinor: true } });
  assert.equal(row?.amountMinor, 30000);
  assert.equal(row?.tenderedMinor, 50000);
  assert.equal(row?.changeMinor, 20000);
  assert.equal(res.ok && res.value.changeMinor, 20000);

  // Cash tendered below the amount applied is a validation error.
  const bad = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-short-${fx.orderId}`,
    tenders: [{ methodCode: "cash", amountMinor: 1000, tenderedMinor: 500 }],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.type, "validation");
});

test("non-cash methods cannot over-tender and e-wallets require a reference", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(20000);

  const overTender = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-ew-${fx.orderId}`,
    tenders: [{ methodCode: "gcash", amountMinor: 20000, tenderedMinor: 25000, reference: "REF-1" }],
  });
  assert.equal(overTender.ok, false, "only cash may hand over more than it applies");

  const noRef = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-ew2-${fx.orderId}`,
    tenders: [{ methodCode: "gcash", amountMinor: 20000 }],
  });
  assert.equal(noRef.ok, false);
  assert.equal(noRef.ok === false && noRef.error.type, "validation");

  const ok = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-ew3-${fx.orderId}`,
    tenders: [{ methodCode: "gcash", amountMinor: 20000, reference: "GC-99887766" }],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const row = await prisma.payment.findFirst({ where: { orderId: fx.orderId }, select: { method: true, reference: true } });
  assert.equal(row?.method, "gcash");
  assert.equal(row?.reference, "GC-99887766");
});

test("replaying the same idempotency key returns the same rows (no double charge)", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(50000);
  const key = `n2-idem-${fx.orderId}`;

  const first = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, { idempotencyKey: key, tenders: [{ methodCode: "cash", amountMinor: 50000 }] });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, { idempotencyKey: key, tenders: [{ methodCode: "cash", amountMinor: 50000 }] });
  assert.equal(second.ok, true, JSON.stringify(second));

  assert.equal(await prisma.payment.count({ where: { orderId: fx.orderId } }), 1, "the retry did not create a second row");
  assert.equal(second.ok && second.value.paidMinor, 50000);
  assert.equal(first.ok && first.value.tenders[0]!.id, second.ok && second.value.tenders[0]!.id, "same tender returned");
});

test("a credit tender beyond the customer's limit is rejected atomically", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(50000, { withCreditCustomer: true, creditLimitMinor: 10000 });

  const res = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-limit-${fx.orderId}`,
    tenders: [
      { methodCode: "cash", amountMinor: 20000 },
      { methodCode: "credit", amountMinor: 30000 },
    ],
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(await prisma.payment.count({ where: { orderId: fx.orderId } }), 0, "the whole command rolled back");
  assert.equal(await prisma.creditEntry.count({ where: { orderId: fx.orderId } }), 0);
  assert.equal((await prisma.storeCustomer.findUnique({ where: { id: fx.storeCustomerId! }, select: { creditBalanceMinor: true } }))?.creditBalanceMinor, 0);
});

test("cash tenders attach to the open drawer shift; non-cash tenders do not", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(50000);

  const { RegisterService } = await import("../registers/register.service.js");
  const registers = new RegisterService();
  const opened = await registers.openSession(fx.storeId, "cashier-1", { openingFloatMinor: 0 });
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const res = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-shift-${fx.orderId}`,
    tenders: [
      { methodCode: "cash", amountMinor: 20000 },
      { methodCode: "gcash", amountMinor: 30000, reference: "GC-1" },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const rows = await prisma.payment.findMany({ where: { orderId: fx.orderId }, select: { method: true, registerSessionId: true } });
  const byMethod = new Map(rows.map((r) => [r.method, r.registerSessionId]));
  const sessionId = opened.ok ? opened.value.sessionId : null;
  assert.equal(byMethod.get("cash"), sessionId, "cash belongs to the shift");
  assert.equal(byMethod.get("gcash"), sessionId, "non-cash tenders are listed in the shift too (just not as drawer cash)");

  const summary = await registers.currentSession(fx.storeId);
  assert.equal(summary?.live.cashSalesMinor, 20000, "only the cash tender counts as drawer cash");
  assert.equal(summary?.live.nonCashSalesMinor, 30000, "the e-wallet tender shows as a non-cash taking");
  assert.equal(summary?.live.expectedMinor, 20000, "expected drawer cash ignores the e-wallet");
});

test("tenant isolation: an order from another store is not payable", async () => {
  const svc = new SplitPaymentService();
  const a = await fixture(10000);
  const b = await fixture(10000);

  const res = await svc.recordTenders(b.storeId, "cashier-1", a.orderId, {
    idempotencyKey: `n2-tenant-${a.orderId}`,
    tenders: [{ methodCode: "cash", amountMinor: 10000 }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.type, "not_found");
});

test("payment methods: seeded defaults, per-store custom method, disable blocks use", async () => {
  const svc = new SplitPaymentService();
  const fx = await fixture(20000);

  const seeded = await svc.listMethods(fx.storeId);
  const codes = seeded.map((m) => m.code).sort();
  assert.deepEqual(codes, ["bank_transfer", "cash", "credit", "gcash", "maya"]);

  const created = await svc.upsertMethod(fx.storeId, { code: "palawan", label: "Palawan Express", kind: "TRANSFER", requiresReference: true, sortOrder: 9 });
  assert.equal(created.ok, true, JSON.stringify(created));

  const useCustom = await svc.recordTenders(fx.storeId, "cashier-1", fx.orderId, {
    idempotencyKey: `n2-custom-${fx.orderId}`,
    tenders: [{ methodCode: "palawan", amountMinor: 20000, reference: "PL-77" }],
  });
  assert.equal(useCustom.ok, true, JSON.stringify(useCustom));

  const disabled = await svc.upsertMethod(fx.storeId, { code: "palawan", label: "Palawan Express", kind: "TRANSFER", requiresReference: true, enabled: false });
  assert.equal(disabled.ok, true);
  const fx2 = await fixture(10000);
  await svc.upsertMethod(fx2.storeId, { code: "cash", label: "Cash", kind: "CASH", enabled: false });
  const blocked = await svc.recordTenders(fx2.storeId, "cashier-1", fx2.orderId, {
    idempotencyKey: `n2-disabled-${fx2.orderId}`,
    tenders: [{ methodCode: "cash", amountMinor: 10000 }],
  });
  assert.equal(blocked.ok, false, "a disabled method cannot be used");
  assert.equal(blocked.ok === false && blocked.error.type, "conflict");

  const badKind = await svc.upsertMethod(fx.storeId, { code: "weird", label: "Weird", kind: "CRYPTO" });
  assert.equal(badKind.ok, false);
});
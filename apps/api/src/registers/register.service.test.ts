// N1 — cash drawer / shifts / Z-report (real DB). Covers the module's acceptance list:
// open + close with variance, no double-open, no double-close, movements rejected after
// close, derived expected cash, cross-tenant isolation.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import { RegisterService } from "./register.service.js";

const run = `N1${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
let slugSeq = 0;

after(async () => {
  if (storeIds.length) {
    await prisma.cashMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.payment.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.order.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.registerSession.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.register.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.storeSettings.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

async function storeFixture(requireOpenShift = true) {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: { slug: `${run}-s${slugSeq}`.toLowerCase(), name: `N1 ${run}`, settings: { create: { requireOpenShift } } },
  });
  storeIds.push(store.id);
  return store.id;
}

/** A counter sale order + its cash tender, linked to the session like the POS does. */
async function cashSale(storeId: string, sessionId: string, totalMinor: number, changeMinor = 0) {
  const orderId = randomId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `N1-${orderId.slice(0, 6)}`,
      storeId,
      status: "COMPLETED",
      currencyCode: "PHP",
      deliveryType: "pickup",
      fulfillmentType: "PICKUP",
      subtotalMinor: totalMinor,
      totalMinor,
      snapshot: {},
      paymentMethod: "cash",
      paymentStatus: "COLLECTED",
      idempotencyKey: randomId(),
      cartToken: randomId(),
      deliveryAddressLine1: "",
      customerName: "N1 Buyer",
      customerPhone: "+639****0001",
      registerSessionId: sessionId,
    },
  });
  await prisma.payment.create({
    data: { orderId, storeId, method: "cash", amountMinor: totalMinor, changeMinor, type: "payment", createdBy: "test", registerSessionId: sessionId },
  });
  return orderId;
}

test("open shift → cash sale + cash-in → close with a short count records the variance", async () => {
  const svc = new RegisterService();
  const storeId = await storeFixture();

  assert.equal(await svc.currentSession(storeId), null);

  const opened = await svc.openSession(storeId, "cashier-1", { openingFloatMinor: 50_000 });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.ok && opened.value.status, "OPEN");
  assert.equal(opened.ok && opened.value.live.expectedMinor, 50_000, "drawer starts at the opening float");

  await cashSale(storeId, opened.ok ? opened.value.sessionId : "", 30_000, 2_000);
  const move = await svc.addMovement(storeId, "owner-1", { type: "CASH_OUT", amountMinor: 10_000, reason: "bank drop" });
  assert.equal(move.ok, true, JSON.stringify(move));

  const mid = await svc.currentSession(storeId);
  assert.equal(mid?.live.cashSalesMinor, 30_000);
  assert.equal(mid?.live.cashOutMinor, 10_000);
  assert.equal(mid?.live.expectedMinor, 70_000, "50,000 float + 30,000 sales − 10,000 out");

  // Short by ₱5.00
  const closed = await svc.closeSession(storeId, "cashier-1", { countedMinor: 65_000, notes: "short" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const s = closed.ok ? closed.value : null;
  assert.equal(s?.status, "CLOSED");
  assert.equal(s?.expectedMinor, 70_000);
  assert.equal(s?.countedMinor, 65_000);
  assert.equal(s?.varianceMinor, -5_000, "negative variance = short");
  assert.equal(await svc.currentSession(storeId), null, "no open shift remains");
});

test("a second open shift is rejected (and the DB enforces one open shift per store)", async () => {
  const svc = new RegisterService();
  const storeId = await storeFixture();

  const first = await svc.openSession(storeId, "cashier-1", { openingFloatMinor: 10_000 });
  assert.equal(first.ok, true);
  const second = await svc.openSession(storeId, "cashier-2", { openingFloatMinor: 10_000 });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.error.type, "conflict");

  // The partial unique index is the real guarantee — a raw insert must fail too.
  const register = await svc.ensureRegister(storeId);
  await assert.rejects(
    () => prisma.registerSession.create({ data: { storeId, registerId: register.id, openedBy: "raw" } }),
    (e: unknown) => (e as { code?: string }).code === "P2002",
    "a concurrent double-open cannot create two open shifts",
  );
});

test("a closed shift rejects new movements and cannot be closed twice", async () => {
  const svc = new RegisterService();
  const storeId = await storeFixture();
  await svc.openSession(storeId, "cashier-1", { openingFloatMinor: 100_000 });
  const closed = await svc.closeSession(storeId, "cashier-1", { countedMinor: 100_000 });
  assert.equal(closed.ok, true);

  const movement = await svc.addMovement(storeId, "cashier-1", { type: "CASH_IN", amountMinor: 1_000, reason: "late" });
  assert.equal(movement.ok, false, "movements after close are rejected");
  assert.equal(movement.ok === false && movement.error.type, "conflict");

  const again = await svc.closeSession(storeId, "cashier-1", { countedMinor: 100_000 });
  assert.equal(again.ok, false, "double close rejected");
});

test("cash refunds come out of the drawer; credit sales do not", async () => {
  const svc = new RegisterService();
  const storeId = await storeFixture();
  const opened = await svc.openSession(storeId, "cashier-1", { openingFloatMinor: 0 });
  const sessionId = opened.ok ? opened.value.sessionId : "";

  const orderId = await cashSale(storeId, sessionId, 20_000);
  // A refund row is negative and reduces the drawer (same shape as payments.service.refundOrder).
  await prisma.payment.create({ data: { orderId, storeId, method: "cash", amountMinor: -8_000, type: "refund", note: "REFUND: damaged", createdBy: "cashier-1", registerSessionId: sessionId } });
  // A utang (credit) sale is recorded against the shift for reporting but is NOT cash.
  const creditOrderId = randomId();
  await prisma.order.create({
    data: {
      id: creditOrderId, orderNumber: `N1-${creditOrderId.slice(0, 6)}`, storeId, status: "COMPLETED", currencyCode: "PHP",
      deliveryType: "pickup", fulfillmentType: "PICKUP", subtotalMinor: 15_000, totalMinor: 15_000, snapshot: {},
      paymentMethod: "credit", paymentStatus: "PENDING", idempotencyKey: randomId(), cartToken: randomId(), deliveryAddressLine1: "",
      customerName: "N1 Utang", customerPhone: "+639****0002",
      registerSessionId: sessionId,
    },
  });
  await prisma.payment.create({ data: { orderId: creditOrderId, storeId, method: "credit", amountMinor: 15_000, type: "payment", createdBy: "cashier-1", registerSessionId: sessionId } });

  const report = await svc.report(storeId, "x");
  assert.equal(report.ok, true, JSON.stringify(report));
  const t = report.ok ? report.value.session.live : null;
  assert.equal(t?.cashSalesMinor, 20_000);
  assert.equal(t?.cashRefundsMinor, 8_000);
  assert.equal(t?.nonCashSalesMinor, 15_000, "credit sales are reported but not in the drawer");
  assert.equal(t?.expectedMinor, 12_000, "0 float + 20,000 cash − 8,000 refund (credit excluded)");
  assert.equal(t?.ordersCount, 2);
  const methods = new Map((t?.byMethod ?? []).map((m) => [m.method, m.amountMinor]));
  assert.equal(methods.get("credit"), 15_000);
  assert.equal(methods.get("cash"), 12_000);
});

test("X-report needs an open shift; Z-report returns the closed shift's final figures", async () => {
  const svc = new RegisterService();
  const storeId = await storeFixture();

  const noShift = await svc.report(storeId, "x");
  assert.equal(noShift.ok, false);
  assert.equal(noShift.ok === false && noShift.error.type, "not_found");

  await svc.openSession(storeId, "cashier-1", { openingFloatMinor: 5_000 });
  const x = await svc.report(storeId, "x");
  assert.equal(x.ok, true);
  assert.equal(x.ok && x.value.kind, "x");
  assert.equal(x.ok && x.value.session.status, "OPEN");

  await svc.closeSession(storeId, "cashier-1", { countedMinor: 5_000, notes: "balanced" });
  const z = await svc.report(storeId, "z");
  assert.equal(z.ok, true, JSON.stringify(z));
  assert.equal(z.ok && z.value.session.status, "CLOSED");
  assert.equal(z.ok && z.value.session.varianceMinor, 0);
  assert.equal(z.ok && z.value.kind, "z");
});

test("requireOpenSession honours the store setting and the cross-tenant boundary", async () => {
  const svc = new RegisterService();
  const strict = await storeFixture(true);
  const lax = await storeFixture(false);

  const blocked = await svc.requireOpenSession(strict);
  assert.equal(blocked.ok, false, "a cash sale with no shift is rejected when requireOpenShift is on");
  assert.equal(blocked.ok === false && blocked.error.type, "conflict");

  const allowed = await svc.requireOpenSession(lax);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.ok && allowed.value, null, "stores that opt out get no session (off-counter sale)");

  await svc.openSession(strict, "cashier-1", { openingFloatMinor: 0 });
  const nowOk = await svc.requireOpenSession(strict);
  assert.equal(nowOk.ok, true);
  assert.ok(nowOk.ok && typeof nowOk.value === "string");

  // Cross-tenant: store B never sees store A's session.
  const other = await svc.currentSession(lax);
  assert.equal(other, null, "store B has no open shift even though store A does");
  const foreign = await svc.report(strict, "x");
  assert.equal(foreign.ok, true);
  const foreignId = foreign.ok ? foreign.value.session.sessionId : "";
  const denial = await svc.report(lax, "x", foreignId);
  assert.equal(denial.ok, false, "a session id from another store does not resolve");
});

test("opening float validation and the FLOAT movement audit trail", async () => {
  const svc = new RegisterService();
  const storeId = await storeFixture();

  const bad = await svc.openSession(storeId, "cashier-1", { openingFloatMinor: -1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error.type, "validation");

  const opened = await svc.openSession(storeId, "cashier-1", { openingFloatMinor: 20_000 });
  assert.equal(opened.ok, true);
  const sessionId = opened.ok ? opened.value.sessionId : "";
  const movements = await prisma.cashMovement.findMany({ where: { storeId, sessionId } });
  assert.equal(movements.length, 1, "the opening float is recorded as a movement");
  assert.equal(movements[0]!.type, "FLOAT");
  assert.equal(movements[0]!.amountMinor, 20_000);

  // The float must not be double-counted in the expected cash.
  const summary = await svc.currentSession(storeId);
  assert.equal(summary?.live.expectedMinor, 20_000);
  assert.equal(summary?.live.cashInMinor, 0, "FLOAT is not counted as CASH_IN");
});

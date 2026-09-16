import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PosService } from "./pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";

// The test runner does not load .env — source DATABASE_URL from the repo root
// (cwd is apps/api under `npm test`, repo root under the targeted gate command).
if (!process.env.DATABASE_URL) {
  for (const p of ["../.env", ".env"]) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const m = raw.match(/^DATABASE_URL="?([^"\n]+)"?/m);
      if (m) {
        process.env.DATABASE_URL = m[1];
        break;
      }
    } catch {
      // try next candidate path
    }
  }
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not found — cannot run POS integration tests");
}

// Prisma resolves the URL lazily, but keep the dynamic import AFTER env is set.
const { prisma } = await import("../persistence/prisma-repositories.js");
const { randomId } = await import("../persistence/repositories.js");

const svc = new PosService(new LoyaltyService());

// ─── DB-backed fixtures (unique store per test; cleaned up in reverse order) ───────

const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAA";

async function makeFixture() {
  const tag = randomId().replace(/-/g, "").slice(0, 10);
  const storeId = `posx_${tag}`;
  const productId = randomId();
  await prisma.store.create({ data: { id: storeId, slug: `posx-${tag}`, name: "POS Test Store" } });
  // N1: these tests exercise the sale plumbing, not the cash-drawer gate — opt out
  // explicitly. The gate itself is covered by the dedicated test below and by
  // registers/register.service.test.ts.
  await prisma.storeSettings.create({ data: { storeId, creditLimitMinor: 500000, creditTermDays: 30, requireOpenShift: false } });
  const customer = await prisma.customer.create({
    data: { name: `POS Test Customer ${tag}`, phone: null, email: null, passwordHash: null },
  });
  const sc = await prisma.storeCustomer.create({
    data: { storeId, customerId: customer.id, creditApproved: true, creditLimitMinor: 200000, loyaltyBalancePoints: 5000 },
  });
  await prisma.product.create({ data: { id: productId, storeId, sku: `SKU-${tag}`, name: "POS Test Product", priceMinor: 10000 } });
  await prisma.stockLevel.create({ data: { storeId, productId, quantityOnHand: 100 } });
  return { storeId, productId, storeCustomerId: sc.id, customerId: customer.id };
}

async function fixtureOrderCount(storeId: string): Promise<number> {
  return prisma.order.count({ where: { storeId } });
}

async function cleanupFixture(storeId: string, customerId: string) {
  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length > 0) {
    await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  await prisma.storeCounter.deleteMany({ where: { storeId } });
  await prisma.stockMovement.deleteMany({ where: { storeId } }); // M4 ledger FK (before product delete)
  await prisma.stockLevel.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.storeSettings.deleteMany({ where: { storeId } });
  await prisma.storeCustomer.deleteMany({ where: { storeId } });
  // Fix #2: createAtomic writes the outbox event in-transaction and the live
  // worker drains it into a NotificationLog row — clear both before the store.
  await prisma.outboxEvent.deleteMany({ where: { id: storeId } });
  await prisma.notificationLog.deleteMany({ where: { id: storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
}

// ─── original unit-style tests (validation before persistence) ─────────────────────

test("empty items rejected", async () => {
  const r = await svc.sell("storeX", "actorX", { items: [], paymentMethod: "cash" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("invalid quantity rejected", async () => {
  for (const q of [0, -1, 1.5, 100]) {
    const r = await svc.sell("storeX", "actorX", { items: [{ productId: "p", quantity: q }], paymentMethod: "cash" });
    assert.equal(r.ok, false, `qty ${q} should be rejected`);
    if (!r.ok) assert.equal(r.error.type, "validation");
  }
});

test("invalid payment method rejected", async () => {
  const r = await svc.sell("storeX", "actorX", {
    items: [{ productId: "p", quantity: 1 }],
    paymentMethod: "card" as "cash",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("unknown store returns not_found", async () => {
  const r = await svc.sell("store-does-not-exist", "actorX", {
    items: [{ productId: "p", quantity: 1 }],
    paymentMethod: "cash",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("payment effects treat COMPLETED as collected", async () => {
  const { paymentEffectFor } = await import("../domain/order-state.js");
  assert.equal(paymentEffectFor("COMPLETED", "PENDING"), "COLLECTED");
  assert.equal(paymentEffectFor("DELIVERED", "PENDING"), "COLLECTED");
});

// ─── v4 pre-orders ──────────────────────────────────────────────────────────────────

test("pre-order create requires a linked customer", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.createPreOrder(fx.storeId, "actorX", { items: [{ productId: fx.productId, quantity: 1 }] });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.type, "validation");
      assert.ok(JSON.stringify(r.error).includes("linked customer"));
    }
    assert.equal(await fixtureOrderCount(fx.storeId), 0);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("pre-order create ok: ON_HOLD, listed with dueAt, excluded from holds", async () => {
  const fx = await makeFixture();
  try {
    const dueAt = "2026-10-01T00:00:00.000Z";
    const r = await svc.createPreOrder(fx.storeId, "actorX", {
      customerId: fx.storeCustomerId,
      items: [{ productId: fx.productId, quantity: 2 }],
      startAt: "2026-09-01T00:00:00.000Z",
      dueAt,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.status, "ON_HOLD");
    assert.equal(r.value.totalMinor, 20000); // 2 × ₱100.00

    const listed = await svc.listPreorders(fx.storeId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, r.value.orderId);
    assert.equal(listed[0]!.dueAt, dueAt);
    assert.equal(listed[0]!.status, "ON_HOLD");
    assert.equal(listed[0]!.items.length, 1);

    // G) counter hold strip must not show pre-orders.
    const holds = await svc.listHolds(fx.storeId);
    assert.equal(holds.length, 0);

    const row = await prisma.order.findUnique({ where: { id: r.value.orderId } });
    assert.equal(row?.source, "PRE_ORDER");
    assert.equal(row?.paymentMethod, "credit");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("finalize requires signature (missing / invalid rejected)", async () => {
  const fx = await makeFixture();
  try {
    const created = await svc.createPreOrder(fx.storeId, "actorX", {
      customerId: fx.storeCustomerId,
      items: [{ productId: fx.productId, quantity: 1 }],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    for (const bad of [{}, { signatureData: "" }, { signatureData: "   " }]) {
      const r = await svc.finalizePreorder(fx.storeId, "actorX", created.value.orderId, bad as never);
      assert.equal(r.ok, false, `sig ${JSON.stringify(bad)} should be rejected`);
      if (!r.ok) {
        assert.equal(r.error.type, "validation");
        assert.ok(JSON.stringify(r.error).includes("Signature is required"));
      }
    }
    for (const bad of ["not-a-data-url", "data:image/png;base64," + "A".repeat(2_000_001)]) {
      const r = await svc.finalizePreorder(fx.storeId, "actorX", created.value.orderId, { signatureData: bad });
      assert.equal(r.ok, false, `sig prefix/length should be rejected`);
      if (!r.ok) assert.equal(r.error.type, "validation");
    }
    // Nothing changed: still ON_HOLD, no credit entry.
    const row = await prisma.order.findUnique({ where: { id: created.value.orderId } });
    assert.equal(row?.status, "ON_HOLD");
    assert.equal(await prisma.creditEntry.count({ where: { orderId: created.value.orderId } }), 0);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("finalize ok: COMPLETED + signature + CreditEntry; 2nd call → not_found", async () => {
  const fx = await makeFixture();
  try {
    const created = await svc.createPreOrder(fx.storeId, "actorX", {
      customerId: fx.storeCustomerId,
      items: [{ productId: fx.productId, quantity: 1 }],
      startAt: "2026-09-01T00:00:00.000Z",
      dueAt: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const r = await svc.finalizePreorder(fx.storeId, "actorX", created.value.orderId, { signatureData: SIGNATURE });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.status, "COMPLETED");
    assert.equal(r.value.orderId, created.value.orderId);
    assert.equal(r.value.totalMinor, 10000);
    assert.ok(r.value.creditEntryId.length > 0);
    assert.ok(!Number.isNaN(Date.parse(r.value.signatureAt)));

    const row = await prisma.order.findUnique({ where: { id: created.value.orderId } });
    assert.equal(row?.status, "COMPLETED");
    assert.equal(row?.signatureData, SIGNATURE);
    assert.ok(row?.signatureAt instanceof Date);
    assert.equal(row?.storeCustomerId, fx.storeCustomerId);

    const entry = await prisma.creditEntry.findFirst({ where: { orderId: created.value.orderId } });
    assert.ok(entry);
    assert.equal(entry!.amountMinor, 10000);
    assert.equal(entry!.type, "purchase");
    assert.equal(entry!.dueAt?.toISOString(), "2026-10-01T00:00:00.000Z");

    const sc = await prisma.storeCustomer.findUnique({ where: { id: fx.storeCustomerId } });
    assert.equal(sc?.creditBalanceMinor, 10000);

    const hist = await prisma.orderStatusHistory.findMany({
      where: { orderId: created.value.orderId, actorType: "pos_finalize" },
    });
    assert.equal(hist.length, 1);

    // Idempotency: already COMPLETED → guard misses → not_found.
    const again = await svc.finalizePreorder(fx.storeId, "actorX", created.value.orderId, { signatureData: SIGNATURE });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error.type, "not_found");
    // Only one credit entry was ever written.
    assert.equal(await prisma.creditEntry.count({ where: { orderId: created.value.orderId } }), 1);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("finalize unknown / non-preorder id → not_found", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.finalizePreorder(fx.storeId, "actorX", randomId(), { signatureData: SIGNATURE });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.type, "not_found");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

// ─── v4 signature on utang sales ────────────────────────────────────────────────────

test("credit sell without signature rejected; cash sell does not require one", async () => {
  const fx = await makeFixture();
  try {
    for (const [label, sig] of [["missing", undefined], ["blank", "   "], ["not a data-url", "fingerprint"]]) {
      const r = await svc.sell(fx.storeId, "actorX", {
        customerId: fx.storeCustomerId,
        items: [{ productId: fx.productId, quantity: 1 }],
        paymentMethod: "credit",
        signatureData: sig,
      });
      assert.equal(r.ok, false, `${label} signature should be rejected`);
      if (!r.ok) {
        assert.equal(r.error.type, "validation");
        assert.ok(JSON.stringify(r.error).includes("Signature is required"));
      }
    }
    assert.equal(await fixtureOrderCount(fx.storeId), 0);

    // Cash needs no signature.
    const cash = await svc.sell(fx.storeId, "actorX", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      tenderedMinor: 10000,
    });
    assert.equal(cash.ok, true);
    if (!cash.ok) return;
    assert.equal(cash.value.totalMinor, 10000);
    assert.equal(cash.value.changeMinor, 0);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("loyalty points on a cash sale rejected", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.sell(fx.storeId, "actorX", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      loyaltyPoints: 100,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.type, "validation");
      assert.ok(JSON.stringify(r.error).includes("Loyalty redemption requires a credit sale"));
    }
    assert.equal(await fixtureOrderCount(fx.storeId), 0);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("credit sell with signature + loyalty redeem: discount applied, balances/ledger updated", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.sell(fx.storeId, "actorX", {
      customerId: fx.storeCustomerId,
      items: [{ productId: fx.productId, quantity: 1 }], // ₱100.00 = 10000 minor
      paymentMethod: "credit",
      signatureData: SIGNATURE,
      loyaltyPoints: 100, // 100 pts → ₱1.00 = 100 minor off
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.totalMinor, 9900);
    assert.equal(r.value.loyaltyPointsRedeemed, 100);
    assert.equal(r.value.paymentMethod, "credit");

    const row = await prisma.order.findUnique({ where: { id: r.value.orderId } });
    assert.equal(row?.discountMinor, 100);
    assert.equal(row?.totalMinor, 9900);
    assert.equal(row?.signatureData, SIGNATURE);
    assert.ok(row?.signatureAt instanceof Date);

    const entry = await prisma.creditEntry.findFirst({ where: { orderId: r.value.orderId } });
    assert.equal(entry?.amountMinor, 9900);

    const sc = await prisma.storeCustomer.findUnique({ where: { id: fx.storeCustomerId } });
    assert.equal(sc?.creditBalanceMinor, 9900);
    assert.equal(sc?.loyaltyBalancePoints, 4900);

    const ledger = await prisma.loyaltyEntry.findFirst({ where: { orderId: r.value.orderId, type: "REDEEM" } });
    assert.ok(ledger);
    assert.equal(ledger!.points, -100);
    assert.equal(ledger!.balanceAfter, 4900);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("credit sell with loyalty redeem: insufficient points rejected, nothing written", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.sell(fx.storeId, "actorX", {
      customerId: fx.storeCustomerId,
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "credit",
      signatureData: SIGNATURE,
      loyaltyPoints: 8000, // discount (₱80) fits the total, but 8000 > 5000 balance
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.type, "conflict");
      assert.ok(r.error.message!.includes("Insufficient points"));
    }
    assert.equal(await fixtureOrderCount(fx.storeId), 0);
    const sc = await prisma.storeCustomer.findUnique({ where: { id: fx.storeCustomerId } });
    assert.equal(sc?.loyaltyBalancePoints, 5000);
    assert.equal(sc?.creditBalanceMinor, 0);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("completeHold credit requires signature; with signature + redeem works", async () => {
  const fx = await makeFixture();
  try {
    const held = await svc.hold(fx.storeId, "actorX", { items: [{ productId: fx.productId, quantity: 1 }] });
    assert.equal(held.ok, true);
    if (!held.ok) return;
    const holdId = held.value.orderId;

    // No signature → rejected before any write.
    const noSig = await svc.completeHold(fx.storeId, "actorX", holdId, {
      paymentMethod: "credit",
      customerId: fx.storeCustomerId,
    });
    assert.equal(noSig.ok, false);
    if (!noSig.ok) {
      assert.equal(noSig.error.type, "validation");
      assert.ok(JSON.stringify(noSig.error).includes("Signature is required"));
    }

    // With signature + loyalty redeem.
    const done = await svc.completeHold(fx.storeId, "actorX", holdId, {
      paymentMethod: "credit",
      customerId: fx.storeCustomerId,
      signatureData: SIGNATURE,
      loyaltyPoints: 100,
    });
    assert.equal(done.ok, true);
    if (!done.ok) return;
    assert.equal(done.value.totalMinor, 9900);
    assert.equal(done.value.loyaltyPointsRedeemed, 100);

    const row = await prisma.order.findUnique({ where: { id: holdId } });
    assert.equal(row?.status, "COMPLETED");
    assert.equal(row?.signatureData, SIGNATURE);
    assert.equal(row?.discountMinor, 100);

    const entry = await prisma.creditEntry.findFirst({ where: { orderId: holdId } });
    assert.equal(entry?.amountMinor, 9900);

    const sc = await prisma.storeCustomer.findUnique({ where: { id: fx.storeCustomerId } });
    assert.equal(sc?.loyaltyBalancePoints, 4900);
    assert.equal(sc?.creditBalanceMinor, 9900);

    // Hold strip: completed hold no longer listed.
    assert.equal((await svc.listHolds(fx.storeId)).length, 0);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("markForDelivery: requires address, rejects non-completed, converts POS sale to OUT_FOR_DELIVERY", async () => {
  const fx = await makeFixture();
  try {
    // 1. Short/missing address rejected.
    const noAddr = await svc.markForDelivery(fx.storeId, "actorX", "x", { addressLine1: "ab" });
    assert.equal(noAddr.ok, false);
    if (!noAddr.ok) assert.equal(noAddr.error.type, "validation");

    // 2. Make a completed POS sale first.
    const sale = await svc.sell(fx.storeId, "actorX", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      tenderedMinor: 10000,
    });
    assert.equal(sale.ok, true);
    if (!sale.ok) return;
    const orderId = sale.value.orderId;
    const row0 = await prisma.order.findUnique({ where: { id: orderId } });
    assert.equal(row0?.status, "COMPLETED");

    // 3. Convert → OUT_FOR_DELIVERY with address + deliveryType.
    const conv = await svc.markForDelivery(fx.storeId, "actorX", orderId, { addressLine1: "123 Mabini St, QC", landmark: "near gate" });
    assert.equal(conv.ok, true);
    if (!conv.ok) return;
    assert.equal(conv.value.status, "OUT_FOR_DELIVERY");
    const row = await prisma.order.findUnique({ where: { id: orderId } });
    assert.equal(row?.status, "OUT_FOR_DELIVERY");
    assert.equal(row?.deliveryType, "delivery");
    assert.equal(row?.deliveryAddressLine1, "123 Mabini St, QC");
    assert.equal(row?.landmark, "near gate");
    // Payment preserved (cash sale → collected/paid).
    assert.equal(row?.paymentStatus, "COLLECTED");
    const hist = await prisma.orderStatusHistory.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    assert.equal(hist[hist.length - 1]!.toStatus, "OUT_FOR_DELIVERY");
    assert.equal(hist[hist.length - 1]!.reason, "POS sale marked for delivery");

    // 4. Re-converting an OUT_FOR_DELIVERY order is rejected.
    const again = await svc.markForDelivery(fx.storeId, "actorX", orderId, { addressLine1: "elsewhere" });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error.type, "conflict");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("completeHold sendForDelivery: delivery-tagged order → OUT_FOR_DELIVERY with payment captured; pickup stays COMPLETED", async () => {
  const fx = await makeFixture();
  try {
    // 1. Hold a delivery-tagged order (deliveryType=delivery + address).
    const held = await svc.hold(fx.storeId, "actorX", { items: [{ productId: fx.productId, quantity: 1 }] });
    assert.equal(held.ok, true);
    if (!held.ok) return;
    const holdId = held.value.orderId;
    await prisma.order.update({
      where: { id: holdId },
      data: { deliveryType: "delivery", deliveryAddressLine1: "123 Mabini St, QC" },
    });

    // 2. Complete with sendForDelivery=true → OUT_FOR_DELIVERY, cash collected.
    const done = await svc.completeHold(fx.storeId, "actorX", holdId, {
      paymentMethod: "cash", tenderedMinor: 10000, sendForDelivery: true,
    });
    assert.equal(done.ok, true);
    if (!done.ok) return;
    assert.equal(done.value.status, "OUT_FOR_DELIVERY");
    const row = await prisma.order.findUnique({ where: { id: holdId } });
    assert.equal(row?.status, "OUT_FOR_DELIVERY");
    assert.equal(row?.paymentStatus, "COLLECTED");
    const hist = await prisma.orderStatusHistory.findMany({ where: { orderId: holdId }, orderBy: { createdAt: "asc" } });
    assert.equal(hist[hist.length - 1]!.toStatus, "OUT_FOR_DELIVERY");
    assert.equal(hist[hist.length - 1]!.reason, "paid at counter → send for delivery");

    // 3. Pickup order with sendForDelivery=true → stays COMPLETED (never routed to delivery).
    const held2 = await svc.hold(fx.storeId, "actorX", { items: [{ productId: fx.productId, quantity: 1 }] });
    assert.equal(held2.ok, true);
    if (!held2.ok) return;
    const hold2Id = held2.value.orderId;
    const done2 = await svc.completeHold(fx.storeId, "actorX", hold2Id, {
      paymentMethod: "cash", tenderedMinor: 10000, sendForDelivery: true,
    });
    assert.equal(done2.ok, true);
    if (!done2.ok) return;
    assert.equal(done2.value.status, "COMPLETED");
    const row2 = await prisma.order.findUnique({ where: { id: hold2Id } });
    assert.equal(row2?.status, "COMPLETED"); // pickup ignores sendForDelivery
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("N1: a cash sale is blocked without an open shift, and the sale records the shift once opened", async () => {
  const fx = await makeFixture();
  try {
    // Opt this store INTO the shift requirement (the shared fixture opts out).
    await prisma.storeSettings.update({ where: { storeId: fx.storeId }, data: { requireOpenShift: true } });

    const blocked = await svc.sell(fx.storeId, "actorX", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      tenderedMinor: 10000,
    });
    assert.equal(blocked.ok, false, "no open shift → no cash sale");
    if (!blocked.ok) {
      assert.equal(blocked.error.type, "conflict");
      assert.ok(JSON.stringify(blocked.error).includes("open shift"));
    }
    assert.equal(await fixtureOrderCount(fx.storeId), 0, "the blocked sale wrote nothing");

    // Credit sales never touch the drawer → still allowed while the drawer is closed.
    const creditOk = await svc.sell(fx.storeId, "actorX", {
      customerId: fx.storeCustomerId,
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "credit",
      signatureData: "data:image/png;base64," + "A".repeat(40),
    });
    assert.equal(creditOk.ok, true, "credit sale does not need the drawer");
    if (!creditOk.ok) return;

    // Open the drawer → the same cash sale now succeeds and is linked to the shift.
    const { RegisterService } = await import("../registers/register.service.js");
    const registers = new RegisterService();
    const opened = await registers.openSession(fx.storeId, "actorX", { openingFloatMinor: 0 });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const sessionId = opened.ok ? opened.value.sessionId : "";

    const cash = await svc.sell(fx.storeId, "actorX", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      tenderedMinor: 10000,
    });
    assert.equal(cash.ok, true, JSON.stringify(cash));
    if (!cash.ok) return;

    const order = await prisma.order.findUnique({ where: { id: cash.value.orderId }, select: { registerSessionId: true } });
    assert.equal(order?.registerSessionId, sessionId, "the counter sale is bound to the open shift");
    const payment = await prisma.payment.findFirst({ where: { orderId: cash.value.orderId }, select: { registerSessionId: true, method: true, amountMinor: true } });
    assert.equal(payment?.registerSessionId, sessionId, "the cash tender is bound to the shift");
    assert.equal(payment?.method, "cash");

    // …and the drawer report sees it.
    const summary = await registers.currentSession(fx.storeId);
    assert.equal(summary?.live.cashSalesMinor, 10000);
    assert.equal(summary?.live.expectedMinor, 10000);
  } finally {
    await prisma.cashMovement.deleteMany({ where: { storeId: fx.storeId } });
    await prisma.registerSession.deleteMany({ where: { storeId: fx.storeId } });
    await prisma.register.deleteMany({ where: { storeId: fx.storeId } });
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

// ── M1: multi-tender counter sales ──────────────────────────────────────────────

test("M1: a POS sale with cash + gcash tenders writes one row per tender and settles COLLECTED", async () => {
  const fx = await makeFixture();
  try {
    const res = await svc.sell(fx.storeId, "cashier-m1", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      tenders: [
        { methodCode: "cash", amountMinor: 6000, tenderedMinor: 10000 }, // ₱60 applied, ₱100 handed → ₱40 change
        { methodCode: "gcash", amountMinor: 4000, reference: "GC-M1-1" },
      ],
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.value.totalMinor, 10000, "the two tenders cover the ₱100 sale");
    assert.equal(res.value.changeMinor, 4000, "change comes back from the cash tender");

    const rows = await prisma.payment.findMany({
      where: { orderId: res.value.orderId },
      select: { method: true, amountMinor: true, changeMinor: true, reference: true },
    });
    assert.equal(rows.length, 2, "one Payment row per tender");
    const cash = rows.find((r) => r.method === "cash");
    const gcash = rows.find((r) => r.method === "gcash");
    assert.equal(cash?.amountMinor, 6000);
    assert.equal(cash?.changeMinor, 4000);
    assert.equal(gcash?.amountMinor, 4000);
    assert.equal(gcash?.reference, "GC-M1-1");

    const order = await prisma.order.findUnique({ where: { id: res.value.orderId }, select: { paymentStatus: true } });
    assert.equal(order?.paymentStatus, "COLLECTED", "no credit tender → nothing outstanding");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("M1: a counter sale that is not settled in full is rejected and writes nothing", async () => {
  const fx = await makeFixture();
  try {
    const before = await fixtureOrderCount(fx.storeId);
    const res = await svc.sell(fx.storeId, "cashier-m1", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      tenders: [
        { methodCode: "cash", amountMinor: 6000, tenderedMinor: 6000 }, // ₱40 short of ₱100
        { methodCode: "gcash", amountMinor: 1000, reference: "GC-M1-2" },
      ],
    });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.error.type, "conflict");
    assert.equal(await fixtureOrderCount(fx.storeId), before, "no order was created");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("M1: a cash+utang counter sale needs the signature and leaves utang outstanding", async () => {
  const fx = await makeFixture();
  try {
    const unsigned = await svc.sell(fx.storeId, "cashier-m1", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      customerId: fx.storeCustomerId,
      tenders: [
        { methodCode: "cash", amountMinor: 5000, tenderedMinor: 5000 },
        { methodCode: "credit", amountMinor: 5000 },
      ],
    });
    assert.equal(unsigned.ok, false, "no signature → the credit tender is refused");
    assert.equal(unsigned.ok === false && unsigned.error.type, "validation");

    const res = await svc.sell(fx.storeId, "cashier-m1", {
      items: [{ productId: fx.productId, quantity: 1 }],
      paymentMethod: "cash",
      customerId: fx.storeCustomerId,
      signatureData: "data:image/png;base64,AAAA",
      tenders: [
        { methodCode: "cash", amountMinor: 5000, tenderedMinor: 5000 },
        { methodCode: "credit", amountMinor: 5000 },
      ],
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;

    const order = await prisma.order.findUnique({ where: { id: res.value.orderId }, select: { paymentStatus: true } });
    assert.equal(order?.paymentStatus, "PENDING", "the utang part is not collected");
    const entries = await prisma.creditEntry.findMany({ where: { orderId: res.value.orderId }, select: { amountMinor: true } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.amountMinor, 5000, "only the credit tender hits the ledger");
    assert.equal(await prisma.payment.count({ where: { orderId: res.value.orderId } }), 2, "both tenders are payment rows");
  } finally {
    await prisma.creditEntry.deleteMany({ where: { storeId: fx.storeId } });
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});
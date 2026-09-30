// Counter price override — DB-backed proof that a POS sale and a pre-order draft
// (and a pre-order edit) honour an explicit, reasoned price deviation, and that the
// deviation is recorded on the order item instead of silently changing the catalog.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PosService } from "./pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { PaymentsService } from "../payments/payments.service.js";

// The test runner does not load .env — source DATABASE_URL from the repo root.
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
      /* try next candidate path */
    }
  }
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not found — cannot run price-override integration tests");
}

const { prisma } = await import("../persistence/prisma-repositories.js");
const { randomId } = await import("../persistence/repositories.js");

const svc = new PosService(new LoyaltyService());
const payments = new PaymentsService();
const CASHIER = "cashier-user-1";

const CATALOG = 10_000; // ₱100.00

async function makeFixture() {
  const tag = randomId().replace(/-/g, "").slice(0, 10);
  const storeId = `povx_${tag}`;
  const productId = randomId();
  await prisma.store.create({ data: { id: storeId, slug: `povx-${tag}`, name: "Price Override Store" } });
  await prisma.storeSettings.create({ data: { storeId, creditLimitMinor: 500000, creditTermDays: 30, requireOpenShift: false } });
  const customer = await prisma.customer.create({ data: { name: `PO Buyer ${tag}`, phone: null, email: null, passwordHash: null } });
  const sc = await prisma.storeCustomer.create({
    data: { storeId, customerId: customer.id, creditApproved: true, creditLimitMinor: 200000 },
  });
  await prisma.product.create({ data: { id: productId, storeId, sku: `SKU-${tag}`, name: "Override Product", priceMinor: CATALOG } });
  await prisma.stockLevel.create({ data: { storeId, productId, quantityOnHand: 100 } });
  return { storeId, productId, customerId: customer.id, storeCustomerId: sc.id };
}

async function cleanupFixture(storeId: string, customerId: string) {
  const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
  if (orderIds.length > 0) {
    await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.voucherRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  await prisma.storeCounter.deleteMany({ where: { storeId } });
  await prisma.stockMovement.deleteMany({ where: { storeId } });
  await prisma.productVariant.deleteMany({ where: { storeId } });
  await prisma.stockLevel.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.storeSettings.deleteMany({ where: { storeId } });
  await prisma.storeCustomer.deleteMany({ where: { storeId } });
  await prisma.outboxEvent.deleteMany({ where: { storeId } });
  await prisma.notificationLog.deleteMany({ where: { storeId } });
  await prisma.cashMovement.deleteMany({ where: { storeId } });
  await prisma.registerSession.deleteMany({ where: { storeId } });
  await prisma.register.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
}

test("a cash sale honours a reasoned price override and records who changed it and why", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.sell(fx.storeId, CASHIER, {
      items: [{ productId: fx.productId, quantity: 2, unitPriceMinorOverride: 9_500, priceOverrideReason: "regular customer price" }],
      paymentMethod: "cash",
    });
    assert.equal(r.ok, true, "the sale completes with an override");
    if (!r.ok) return;

    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: r.value.orderId } });
    assert.equal(item.unitPriceMinor, 9_500, "the line is sold at the override price");
    assert.equal(item.lineTotalMinor, 19_000);
    assert.equal(item.priceOverridden, true);
    assert.equal(item.priceOverrideReason, "regular customer price");
    assert.equal(item.priceOverriddenById, CASHIER);
    assert.ok(item.priceOverriddenAt instanceof Date, "the override is timestamped");
    assert.equal(r.value.totalMinor, 19_000, "the total follows the override");

    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.value.orderId } });
    assert.equal(order.subtotalMinor, 19_000);
    const snapshot = order.snapshot as { lines?: { priceOverridden?: boolean; unitPriceMinor?: number }[] };
    assert.equal(snapshot.lines?.[0]?.priceOverridden, true, "the frozen snapshot explains the price");
    assert.equal(snapshot.lines?.[0]?.unitPriceMinor, 9_500);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: fx.productId } });
    assert.equal(product.priceMinor, CATALOG, "the catalog price is never mutated by a counter override");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("a sale without an override is unchanged and records no deviation", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.sell(fx.storeId, CASHIER, {
      items: [{ productId: fx.productId, quantity: 2 }],
      paymentMethod: "cash",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: r.value.orderId } });
    assert.equal(item.unitPriceMinor, CATALOG);
    assert.equal(item.priceOverridden, false);
    assert.equal(item.priceOverrideReason, null);
    assert.equal(item.priceOverriddenById, null);
    assert.equal(r.value.totalMinor, 2 * CATALOG);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("a deviating override without a reason is refused and nothing is written", async () => {
  const fx = await makeFixture();
  try {
    const r = await svc.sell(fx.storeId, CASHIER, {
      items: [{ productId: fx.productId, quantity: 1, unitPriceMinorOverride: 1 }],
      paymentMethod: "cash",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.type, "validation");
      assert.ok(JSON.stringify(r.error).includes("reason"), "the reason requirement is explained");
    }
    assert.equal(await prisma.order.count({ where: { storeId: fx.storeId } }), 0, "no order survives a rejected override");
    const level = await prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId } });
    assert.equal(level.quantityOnHand, 100, "stock untouched");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("an out-of-band override price is refused", async () => {
  const fx = await makeFixture();
  try {
    for (const override of [-100, 100_000_001, 95.5]) {
      const r = await svc.sell(fx.storeId, CASHIER, {
        items: [{ productId: fx.productId, quantity: 1, unitPriceMinorOverride: override, priceOverrideReason: "typo fix" }],
        paymentMethod: "cash",
      });
      assert.equal(r.ok, false, `override ${override} must be rejected`);
      if (!r.ok) assert.equal(r.error.type, "validation");
    }
    assert.equal(await prisma.order.count({ where: { storeId: fx.storeId } }), 0);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("a pre-order draft stores an override and its edit can change the price again", async () => {
  const fx = await makeFixture();
  try {
    const created = await svc.createPreOrder(fx.storeId, CASHIER, {
      customerId: fx.storeCustomerId,
      items: [{ productId: fx.productId, quantity: 2, unitPriceMinorOverride: 9_000, priceOverrideReason: "advance order price" }],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const draftItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created.value.orderId } });
    assert.equal(draftItem.unitPriceMinor, 9_000);
    assert.equal(draftItem.priceOverridden, true);
    assert.equal(created.value.totalMinor, 18_000);

    // The Edit modal re-prices the same draft.
    const edited = await svc.replaceItems(
      fx.storeId,
      CASHIER,
      created.value.orderId,
      { items: [{ productId: fx.productId, quantity: 2, unitPriceMinorOverride: 8_500, priceOverrideReason: "price agreed at pickup" }] },
      { source: "PRE_ORDER" },
    );
    assert.equal(edited.ok, true);
    if (!edited.ok) return;

    const after = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created.value.orderId } });
    assert.equal(after.unitPriceMinor, 8_500, "the edited price wins");
    assert.equal(after.priceOverrideReason, "price agreed at pickup");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.value.orderId } });
    assert.equal(order.totalMinor, 17_000, "the draft total follows the edited price");
    // Stock was consumed once at draft creation and is untouched by the re-price.
    const level = await prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId } });
    assert.equal(level.quantityOnHand, 98);
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("a pre-order edit cannot touch a POS hold (source is scoped)", async () => {
  const fx = await makeFixture();
  try {
    const held = await svc.hold(fx.storeId, CASHIER, { items: [{ productId: fx.productId, quantity: 1 }] });
    assert.equal(held.ok, true);
    if (!held.ok) return;

    const wrongRoute = await svc.replaceItems(
      fx.storeId,
      CASHIER,
      held.value.orderId,
      { items: [{ productId: fx.productId, quantity: 3 }] },
      { source: "PRE_ORDER" },
    );
    assert.equal(wrongRoute.ok, false, "a POS hold is not editable through the pre-order route");
    if (!wrongRoute.ok) assert.equal(wrongRoute.error.type, "not_found");

    const rightRoute = await svc.replaceItems(
      fx.storeId,
      CASHIER,
      held.value.orderId,
      { items: [{ productId: fx.productId, quantity: 3 }] },
      { source: "pos" },
    );
    assert.equal(rightRoute.ok, true, "the hold route still works");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

test("a variant line is measured against the VARIANT price, and the receipt explains the change", async () => {
  const fx = await makeFixture();
  try {
    const variant = await prisma.productVariant.create({
      data: { storeId: fx.storeId, productId: fx.productId, name: "Large", sku: `VAR-${fx.storeId.slice(-6)}`, priceMinor: 20_000, quantityOnHand: 5 },
    });
    // 19,500 deviates from the variant price (₱200.00) but equals nothing about the
    // product price — the baseline must be the variant's own price.
    const r = await svc.sell(fx.storeId, CASHIER, {
      items: [{ productId: fx.productId, variantId: variant.id, quantity: 1, unitPriceMinorOverride: 19_500, priceOverrideReason: "bulk variant price" }],
      paymentMethod: "cash",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: r.value.orderId } });
    assert.equal(item.variantId, variant.id);
    assert.equal(item.unitPriceMinor, 19_500);
    assert.equal(item.priceOverridden, true);

    const receipt = await payments.receipt(r.value.orderId, fx.storeId);
    assert.ok(receipt, "the receipt renders");
    assert.equal(receipt.items[0]?.unitPriceMinor, 19_500);
    assert.equal(receipt.items[0]?.priceOverridden, true);
    assert.equal(receipt.items[0]?.priceOverrideReason, "bulk variant price");
  } finally {
    await cleanupFixture(fx.storeId, fx.customerId);
  }
});

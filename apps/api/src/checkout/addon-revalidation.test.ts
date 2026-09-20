// P3c: add-on price revalidation at checkout (real DB + Prisma repos).
// An add-on option's price is re-priced from the LIVE group at checkout; a
// deactivated/vanished option is dropped. A stale add-on total is never charged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import {
  PrismaStoreRepository,
  PrismaCatalogRepository,
  PrismaCartRepository,
  PrismaOrderRepository,
  PrismaOrderSequenceRepository,
} from "../persistence/prisma-repositories.js";
import { CheckoutService } from "../checkout/checkout.service.js";
import { VoucherPublicService } from "../voucher/voucher-public.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import type { CheckoutRequest } from "@sam-store/contracts";

const run = `P3A${Date.now().toString().slice(-6)}`;
const storeIds: string[] = [];
let slugSeq = 0;

after(async () => {
  for (const storeId of storeIds) {
    const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
    if (orderIds.length) {
      await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.voucherRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.notificationLog.deleteMany({ where: { storeId } });
      await prisma.outboxEvent.deleteMany({ where: { storeId } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.cartItem.deleteMany({ where: { storeId } });
    await prisma.cart.deleteMany({ where: { storeId } });
    await prisma.productAddonOption.deleteMany({ where: { addon: { storeId } } });
    await prisma.productAddon.deleteMany({ where: { storeId } });
    await prisma.stockLevel.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.storeSettings.deleteMany({ where: { storeId } });
    await prisma.storeCounter.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

async function makeFixture() {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: {
      slug: `${String(slugSeq).padStart(2, "0")}${run}`,
      name: `P3A ${run}`,
      settings: { create: { deliveryFeeMinor: 5000, allowGuestOrders: true } },
    },
  });
  storeIds.push(store.id);

  const product = await prisma.product.create({ data: { storeId: store.id, sku: `P3A-${slugSeq}-A`, name: "P3A Drink", priceMinor: 10000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 20, quantityReserved: 0 } });

  // Add-on group + one option priced at ₱10 at add-time.
  const group = await prisma.productAddon.create({
    data: { storeId: store.id, productId: product.id, name: "Extras", required: false, sortOrder: 1 },
  });
  const option = await prisma.productAddonOption.create({
    data: { storeId: store.id, addonId: group.id, name: "Milk", priceMinor: 1000, isActive: true, sortOrder: 1 },
  });

  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `cart_${run}_${slugSeq}`, status: "OPEN" } });
  // Simulate the add-time server-side pricing snapshot CartService would have written.
  await prisma.cartItem.create({
    data: {
      cartId: cart.id,
      storeId: store.id,
      productId: product.id,
      variantId: "",
      addonKey: option.id,
      addons: [{ addonId: group.id, optionId: option.id, name: "Milk", priceMinor: 1000 }],
      addonsTotalMinor: 1000,
      quantity: 1,
      unitPriceMinor: 10000,
    },
  });

  return { store, product, group, option, cart };
}

function makeCheckoutService() {
  return new CheckoutService(
    new PrismaStoreRepository(),
    new PrismaCatalogRepository(),
    new PrismaCartRepository(),
    new PrismaOrderRepository(),
    new PrismaOrderSequenceRepository(),
    "test-claim-secret-0123456789",
    undefined,
    new VoucherPublicService(),
    new LoyaltyService(),
    async (token: string) => token.replace("jwt-", ""),
  );
}

function request(cartToken: string): CheckoutRequest {
  return {
    cartToken,
    customerName: "P3A Buyer",
    customerPhone: "+639170000999",
    deliveryAddressLine1: "1 P3A St",
    deliveryType: "delivery",
    paymentMethod: "cod",
    consentGranted: true,
    idempotencyKey: `p3ack-${cartToken}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

test("P3c: option price raised after add is re-priced at checkout and reported", async () => {
  const fx = await makeFixture();
  // Admin raises the option from ₱10 to ₱15 between add-time and checkout.
  await prisma.productAddonOption.update({ where: { id: fx.option.id }, data: { priceMinor: 1500 } });

  const r = await makeCheckoutService().checkout(request(fx.cart.token));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // subtotal (10000 + 1500) + delivery 5000 = 16500 — live price, not the stale ₱10.
  assert.equal(r.value.totalMinor, 16500);

  const order = await prisma.order.findUnique({ where: { id: r.value.orderId }, include: { items: true } });
  assert.equal(order?.subtotalMinor, 11500);
  assert.equal(order?.items.length, 1);
  const item = order?.items[0];
  const addons = (item?.addons as { addonId?: string; optionId?: string; name?: string; priceMinor?: number }[] | null) ?? [];
  assert.equal(addons.length, 1);
  assert.equal(addons[0]?.priceMinor, 1500, "order snapshot carries the LIVE price");

  const snap = (order?.snapshot as Record<string, unknown> | null) ?? {};
  assert.deepEqual(snap.addonPriceChanges, [
    { productId: fx.product.id, optionId: fx.option.id, name: "Milk", fromMinor: 1000, toMinor: 1500 },
  ]);
  assert.deepEqual(snap.removedAddonOptionIds ?? [], []);
});

test("P3c: deactivated option is dropped at checkout — never a stale total", async () => {
  const fx = await makeFixture();
  // Admin deactivates the option after the customer added it to the cart.
  await prisma.productAddonOption.update({ where: { id: fx.option.id }, data: { isActive: false } });

  const r = await makeCheckoutService().checkout(request(fx.cart.token));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // The ₱10 add-on is dropped: subtotal 10000 + delivery 5000 = 15000.
  assert.equal(r.value.totalMinor, 15000);

  const order = await prisma.order.findUnique({ where: { id: r.value.orderId }, include: { items: true } });
  assert.equal(order?.subtotalMinor, 10000);
  const item = order?.items[0];
  assert.deepEqual((item?.addons as unknown[] | null) ?? [], []);

  const snap = (order?.snapshot as Record<string, unknown> | null) ?? {};
  assert.deepEqual(snap.removedAddonOptionIds, [fx.option.id]);
  assert.deepEqual(snap.addonPriceChanges ?? [], []);
});

test("P3c: option price lowered after add is re-priced (customer pays less)", async () => {
  const fx = await makeFixture();
  await prisma.productAddonOption.update({ where: { id: fx.option.id }, data: { priceMinor: 500 } });

  const r = await makeCheckoutService().checkout(request(fx.cart.token));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // subtotal (10000 + 500) + delivery 5000 = 15500.
  assert.equal(r.value.totalMinor, 15500);

  const order = await prisma.order.findUnique({ where: { id: r.value.orderId } });
  const snap = (order?.snapshot as Record<string, unknown> | null) ?? {};
  assert.deepEqual(snap.addonPriceChanges, [
    { productId: fx.product.id, optionId: fx.option.id, name: "Milk", fromMinor: 1000, toMinor: 500 },
  ]);
});
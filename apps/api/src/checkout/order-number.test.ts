// P3i: order numbers — a store with orderNumberPrefix configured gets PIN-YYYY-NNNNNN
// numbers through the real checkout path; unset keeps the legacy slug format.
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
import type { CheckoutRequest } from "@sam-store/contracts";

const run = `P3I${Date.now().toString().slice(-6)}`;
const storeIds: string[] = [];
let slugSeq = 0;

after(async () => {
  for (const storeId of storeIds) {
    try {
      const orderIds = (await prisma.order.findMany({ where: { storeId }, select: { id: true } })).map((o) => o.id);
      if (orderIds.length) {
        await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.voucherRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.cartItem.deleteMany({ where: { storeId } });
      await prisma.cart.deleteMany({ where: { storeId } });
      await prisma.stockLevel.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.storeCounter.deleteMany({ where: { storeId } });
      // Sweep again right before the store goes — other files' workers can leave rows.
      await prisma.notificationLog.deleteMany({ where: { storeId } });
      await prisma.outboxEvent.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // Best-effort cleanup — a leftover row must not fail the run (see P3a sweeper note).
    }
  }
  await prisma.$disconnect();
});

async function makeFixture(prefix: string | null) {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: {
      slug: `${String(slugSeq).padStart(2, "0")}${run}`,
      name: `P3I ${run}`,
      settings: { create: { deliveryFeeMinor: 5000, allowGuestOrders: true, orderNumberPrefix: prefix } },
    },
  });
  storeIds.push(store.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `P3I-${slugSeq}-A`, name: "P3I A", priceMinor: 10000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 20, quantityReserved: 0 } });
  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `cart_${run}_${slugSeq}`, status: "OPEN" } });
  await prisma.cartItem.create({ data: { cartId: cart.id, storeId: store.id, productId: product.id, quantity: 1, unitPriceMinor: 10000 } });
  return { store, cart };
}

function makeService() {
  return new CheckoutService(
    new PrismaStoreRepository(),
    new PrismaCatalogRepository(),
    new PrismaCartRepository(),
    new PrismaOrderRepository(),
    new PrismaOrderSequenceRepository(),
    "test-claim-secret-0123456789",
  );
}

function request(cartToken: string): CheckoutRequest {
  return {
    cartToken,
    customerName: "P3I Buyer",
    customerPhone: "+639170000999",
    deliveryAddressLine1: "1 P3I St",
    deliveryType: "delivery",
    paymentMethod: "cod",
    consentGranted: true,
    idempotencyKey: `p3ick-${cartToken}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

test("configured prefix → PIN-YYYY-NNNNNN order numbers", async () => {
  const fx = await makeFixture("PIN");
  const r = await makeService().checkout(request(fx.cart.token));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const year = new Date().getFullYear().toString();
  assert.match(r.value.orderNumber, new RegExp(`^PIN-${year}-\\d{6}$`), `got ${r.value.orderNumber}`);
});

test("blank prefix keeps the legacy slug format", async () => {
  const fx = await makeFixture(null);
  const r = await makeService().checkout(request(fx.cart.token));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.value.orderNumber, /^[A-Z0-9]{1,6}-\d{6}$/, `got ${r.value.orderNumber}`);
});
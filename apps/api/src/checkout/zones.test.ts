// P5a: delivery zones through the real checkout — zone fee + snapshot, out-of-coverage
// conflict, and legacy flat fee when no zones are configured.
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
import { AddressService } from "../address/address.service.js";
import type { CheckoutRequest } from "@sam-store/contracts";

const run = `P5Z${Date.now().toString().slice(-6)}`;
const storeIds: string[] = [];
let slugSeq = 0;

after(async () => {
  for (const storeId of storeIds) {
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
      await prisma.notificationLog.deleteMany({ where: { storeId } });
      await prisma.outboxEvent.deleteMany({ where: { storeId } });
      await prisma.deliveryZone.deleteMany({ where: { storeId } });
      await prisma.cartItem.deleteMany({ where: { storeId } });
      await prisma.cart.deleteMany({ where: { storeId } });
      await prisma.stockLevel.deleteMany({ where: { storeId } });
      await prisma.product.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.storeCounter.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

async function addrChain() {
  const city = await prisma.phCity.findFirst({ include: { barangays: { take: 1 }, province: { include: { region: true } } } });
  if (!city || city.barangays.length === 0) throw new Error("No seeded PH address rows — run db:seed:addresses");
  return { city, barangay: city.barangays[0]! };
}

async function makeFixture(zones: { name: string; cityCode: string | null; feeMinor: number; etaMinutes: number }[] | null) {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: {
      slug: `${String(slugSeq).padStart(2, "0")}${run}`,
      name: `P5Z ${run}`,
      settings: { create: { deliveryFeeMinor: 5000, allowGuestOrders: true } },
    },
  });
  storeIds.push(store.id);
  if (zones) {
    await prisma.deliveryZone.createMany({ data: zones.map((z, i) => ({ storeId: store.id, ...z, sortOrder: i })) });
  }
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `P5Z-${slugSeq}-A`, name: "P5Z A", priceMinor: 10000 } });
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
    undefined, undefined, undefined, undefined, undefined,
    new AddressService(), // AddressGateway (P1)
  );
}

function msgOf(error: { message?: string } | { errors?: string[] }): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("errors" in error && Array.isArray(error.errors)) return error.errors.join(", ");
  return "";
}

function request(cartToken: string, addr: { regionCode: string; provinceCode: string; cityCode: string; barangayCode: string }): CheckoutRequest {
  return {
    cartToken,
    customerName: "P5Z Buyer",
    customerPhone: "+639170000999",
    deliveryAddressLine1: "1 P5Z St",
    deliveryType: "delivery",
    paymentMethod: "cod",
    consentGranted: true,
    ...addr,
    idempotencyKey: `p5zk-${cartToken}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

test("zone fee + ETA apply at checkout and are snapshotted", async () => {
  const { city, barangay } = await addrChain();
  const fx = await makeFixture([{ name: "Covered City", cityCode: city.code, feeMinor: 9000, etaMinutes: 25 }]);
  const r = await makeService().checkout(request(fx.cart.token, {
    regionCode: city.province.region.code,
    provinceCode: city.province.code,
    cityCode: city.code,
    barangayCode: barangay.code,
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // subtotal 10000 + zone fee 9000 = 19000
  assert.equal(r.value.totalMinor, 19000);
  const order = await prisma.order.findUnique({ where: { id: r.value.orderId } });
  assert.equal(order?.deliveryFeeMinor, 9000);
  assert.equal(order?.deliveryZoneName, "Covered City");
  assert.equal(order?.etaMinutes, 25);
  const snap = (order?.snapshot as Record<string, unknown> | null) ?? {};
  assert.equal((snap.deliveryZone as { name?: string } | undefined)?.name, "Covered City");
});

test("an unmatched delivery address is OUT OF COVERAGE", async () => {
  const { city, barangay } = await addrChain();
  // A zone that only covers a DIFFERENT (fake) city.
  const fx = await makeFixture([{ name: "Elsewhere", cityCode: "0000", feeMinor: 999, etaMinutes: 10 }]);
  const r = await makeService().checkout(request(fx.cart.token, {
    regionCode: city.province.region.code,
    provinceCode: city.province.code,
    cityCode: city.code,
    barangayCode: barangay.code,
  }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(msgOf(r.error), /outside our coverage/i);
});

test("no zones → legacy flat fee, no zone snapshot", async () => {
  const { city, barangay } = await addrChain();
  const fx = await makeFixture(null);
  const r = await makeService().checkout(request(fx.cart.token, {
    regionCode: city.province.region.code,
    provinceCode: city.province.code,
    cityCode: city.code,
    barangayCode: barangay.code,
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.totalMinor, 15000, "flat 5000 fee");
  const order = await prisma.order.findUnique({ where: { id: r.value.orderId } });
  assert.equal(order?.deliveryZoneName, null);
});
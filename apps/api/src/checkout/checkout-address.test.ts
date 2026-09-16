// P1: checkout with PH address codes — snapshot codes+names on the order, reject
// partial/invalid selections (real DB + real CheckoutService wired like AppModule).
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
import { CheckoutService } from "./checkout.service.js";
import { AddressService } from "../address/address.service.js";
import type { CheckoutRequest } from "@sam-store/contracts";

const run = `P1C${Date.now().toString().slice(-6)}`;
const regionCode = `${run}REG`;
const provinceCode = `${run}PROV`;
const cityCode = `${run}CITY`;
const barangayCode = `${run}BRGY`;

const storeIds: string[] = [];
const regionIds: string[] = [];
let slugSeq = 0;

const checkoutService = new CheckoutService(
  new PrismaStoreRepository(),
  new PrismaCatalogRepository(),
  new PrismaCartRepository(),
  new PrismaOrderRepository(),
  new PrismaOrderSequenceRepository(),
  "test-claim-secret-0123456789",
  undefined, // onOrderPlaced
  undefined, // voucher
  undefined, // loyalty
  undefined, // resolveCustomer
  undefined, // credit
  new AddressService(), // AddressGateway (P1)
);

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
    await prisma.stockLevel.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.storeSettings.deleteMany({ where: { storeId } });
    await prisma.storeCounter.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  if (regionIds.length) {
    await prisma.phBarangay.deleteMany({ where: { city: { province: { regionId: { in: regionIds } } } } });
    await prisma.phCity.deleteMany({ where: { province: { regionId: { in: regionIds } } } });
    await prisma.phProvince.deleteMany({ where: { regionId: { in: regionIds } } });
    await prisma.phRegion.deleteMany({ where: { id: { in: regionIds } } });
  }
  await prisma.$disconnect();
});

async function makeStore() {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: {
      // Lead with a store-unique zero-padded number so formatOrderNumber's
      // 6-char slug prefix differs across stores (orderNumber is globally unique).
      slug: `${String(slugSeq).padStart(2, "0")}${run}`,
      name: `P1 Checkout ${run}`,
      settings: { create: { deliveryFeeMinor: 5000, allowGuestOrders: true } },
    },
  });
  storeIds.push(store.id);
  const product = await prisma.product.create({
    data: { storeId: store.id, sku: `P1C-${store.id.slice(-4)}`, name: "P1 Product", priceMinor: 9900 },
  });
  await prisma.stockLevel.create({
    data: { storeId: store.id, productId: product.id, quantityOnHand: 25, quantityReserved: 0 },
  });
  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `p1cart${store.id.slice(-4)}`, status: "OPEN" } });
  await prisma.cartItem.create({
    data: { cartId: cart.id, storeId: store.id, productId: product.id, quantity: 2, unitPriceMinor: 9900 },
  });

  const rCode = `${regionCode}${slugSeq}`;
  const pCode = `${provinceCode}${slugSeq}`;
  const cCode = `${cityCode}${slugSeq}`;
  const bCode = `${barangayCode}${slugSeq}`;

  const region = await prisma.phRegion.create({ data: { code: rCode, name: `P1 Checkout Region ${slugSeq}` } });
  regionIds.push(region.id);
  const province = await prisma.phProvince.create({
    data: { code: pCode, name: `P1 Checkout Province ${slugSeq}`, regionId: region.id },
  });
  const city = await prisma.phCity.create({
    data: { code: cCode, name: `P1 Checkout City ${slugSeq}`, type: "city", provinceId: province.id },
  });
  await prisma.phBarangay.create({
    data: { code: bCode, name: `P1 Checkout Barangay ${slugSeq}`, cityId: city.id },
  });

  return {
    store,
    cart,
    codes: { regionCode: rCode, provinceCode: pCode, cityCode: cCode, barangayCode: bCode },
  };
}

function request(cartToken: string, over: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    cartToken,
    customerName: "P1 Buyers",
    customerPhone: "+639170000123",
    deliveryAddressLine1: "123 Test St",
    deliveryType: "delivery",
    paymentMethod: "cod",
    idempotencyKey: `p1ck-${cartToken}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

test("checkout persists PH codes + frozen name snapshot and resolves order number", async () => {
  const { store, cart, codes } = await makeStore();
  const result = await checkoutService.checkout(
    request(cart.token, { ...codes }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const order = await prisma.order.findUnique({ where: { id: result.value.orderId } });
  assert.ok(order);
  assert.equal(order.deliveryRegionCode, codes.regionCode);
  assert.equal(order.deliveryProvinceCode, codes.provinceCode);
  assert.equal(order.deliveryCityCode, codes.cityCode);
  assert.equal(order.deliveryBarangayCode, codes.barangayCode);
  assert.match(order.deliveryRegionName ?? "", /^P1 Checkout Region /);
  assert.match(order.deliveryProvinceName ?? "", /^P1 Checkout Province /);
  assert.match(order.deliveryCityName ?? "", /^P1 Checkout City /);
  assert.match(order.deliveryBarangayName ?? "", /^P1 Checkout Barangay /);
  assert.ok(JSON.stringify(order.snapshot).includes("phAddress"));
  assert.equal(order.deliveryFeeMinor, 5000);
  void store;
});

test("partial codes are rejected as validation", async () => {
  const { cart, codes } = await makeStore();
  const { barangayCode: _skip, ...partial } = codes;
  const result = await checkoutService.checkout(
    request(cart.token, partial), // missing barangay
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.type, "validation");
    assert.ok(result.error.errors.some((e) => /Complete the full address/i.test(e)));
  }
  void _skip;
});

test("pickup rejects address codes", async () => {
  const { cart, codes } = await makeStore();
  const result = await checkoutService.checkout(
    request(cart.token, { deliveryType: "pickup", ...codes }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.type, "validation");
    assert.ok(result.error.errors.some((e) => /Address codes are only accepted for delivery/i.test(e)));
  }
});

test("broken parent chain is rejected through AddressGateway", async () => {
  const { cart, codes } = await makeStore();
  const result = await checkoutService.checkout(
    request(cart.token, { ...codes, regionCode: `${run}XXX` }), // unknown region
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.type, "validation");
    assert.ok(result.error.errors.some((e) => /Address selection is invalid/i.test(e)));
  }
});

test("legacy free-text checkout (no codes) still works", async () => {
  const { cart } = await makeStore();
  const result = await checkoutService.checkout(request(cart.token));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const order = await prisma.order.findUnique({ where: { id: result.value.orderId } });
  assert.ok(order);
  assert.equal(order.deliveryRegionCode, null);
  assert.equal(order.deliveryRegionName, null);
});
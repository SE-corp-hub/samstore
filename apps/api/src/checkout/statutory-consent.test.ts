// P3b: statutory 20% discount (Senior Citizen / PWD) + DPA consent gate
// through the real checkout path (real DB + Prisma repos).
// Covers: consent required, senior discount maths, invalid claims rejected,
// store toggle off → conflict, stacking after vouchers (capped), ConsentRecord.
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

const run = `P3S${Date.now().toString().slice(-6)}`;
const storeIds: string[] = [];
const customerIds: string[] = [];
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
    await prisma.voucherRedemption.deleteMany({ where: { storeId } });
    await prisma.voucher.deleteMany({ where: { storeId } });
    const customers = (await prisma.storeCustomer.findMany({ where: { storeId }, select: { customerId: true } })).map((c) => c.customerId);
    await prisma.storeCustomer.deleteMany({ where: { storeId } });
    if (customers.length) {
      await prisma.consentRecord.deleteMany({ where: { customerId: { in: customers } } });
      await prisma.customer.deleteMany({ where: { id: { in: customers } } });
    }
    await prisma.cartItem.deleteMany({ where: { storeId } });
    await prisma.cart.deleteMany({ where: { storeId } });
    await prisma.stockLevel.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.storeSettings.deleteMany({ where: { storeId } });
    await prisma.storeCounter.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

async function makeFixture(over: { seniorPwdEnabled?: boolean; voucherDiscountMinor?: number } = {}) {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: {
      slug: `${String(slugSeq).padStart(2, "0")}${run}`,
      name: `P3S ${run}`,
      settings: {
        create: {
          deliveryFeeMinor: 5000,
          allowGuestOrders: true,
          seniorPwdDiscountEnabled: over.seniorPwdEnabled ?? false,
        },
      },
    },
  });
  storeIds.push(store.id);

  const product = await prisma.product.create({ data: { storeId: store.id, sku: `P3S-${slugSeq}-A`, name: "P3S A", priceMinor: 10000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 20, quantityReserved: 0 } });

  let storeCustomer: { id: string; customerId: string } | null = null;
  if (over.seniorPwdEnabled === true || over.voucherDiscountMinor) {
    const customer = await prisma.customer.create({ data: { name: `Buyer ${slugSeq}`, phone: `+63919000001${slugSeq}`, email: null, passwordHash: null } });
    customerIds.push(customer.id);
    storeCustomer = await prisma.storeCustomer.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        loyaltyBalancePoints: 0,
        creditApproved: true,
        creditLimitMinor: 1000000,
        creditBalanceMinor: 0,
      },
    });
  }

  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `cart_${run}_${slugSeq}`, status: "OPEN" } });
  await prisma.cartItem.create({ data: { cartId: cart.id, storeId: store.id, productId: product.id, quantity: 1, unitPriceMinor: 10000 } });

  const voucher = over.voucherDiscountMinor
    ? await prisma.voucher.create({
        data: {
          storeId: store.id,
          code: `V${slugSeq}`,
          discountMinor: over.voucherDiscountMinor,
          type: "fixed",
          percentBp: null,
          firstOrderOnly: false,
          perCustomerLimit: null,
          scopeType: "all",
          scopeRefId: null,
          stackable: true,
          minOrderMinor: 0,
        },
      })
    : null;

  return { store, product, cart, storeCustomer, voucher };
}

function makeCheckoutService() {
  const svc = new CheckoutService(
    new PrismaStoreRepository(),
    new PrismaCatalogRepository(),
    new PrismaCartRepository(),
    new PrismaOrderRepository(),
    new PrismaOrderSequenceRepository(),
    "test-claim-secret-0123456789",
    undefined,
    new VoucherPublicService(),
    new LoyaltyService(),
    async (token: string) => token.replace("jwt-", ""), // resolveCustomer stub: token "jwt-<customerId>"
  );
  return svc;
}

function request(cartToken: string, over: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    cartToken,
    customerName: "P3S Buyer",
    customerPhone: "+639170000999",
    deliveryAddressLine1: "1 P3S St",
    deliveryType: "delivery",
    paymentMethod: "cod",
    consentGranted: true,
    idempotencyKey: `p3sck-${cartToken}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

function msgOf(error: { message?: string } | { errors?: string[] }): string {
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("errors" in error && Array.isArray(error.errors)) return error.errors.join(", ");
  return "";
}

test("an order cannot be placed without the DPA privacy consent", async () => {
  const fx = await makeFixture();
  const svc = makeCheckoutService();
  const r = await svc.checkout(request(fx.cart.token, { consentGranted: false }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(msgOf(r.error), /privacy consent/i);
});

test("senior discount: 20% of the subtotal (delivery excluded) is applied and captured", async () => {
  const fx = await makeFixture({ seniorPwdEnabled: true });
  const svc = makeCheckoutService();
  const r = await svc.checkout(request(fx.cart.token, {
    statutoryType: "senior",
    statutoryId: "SC-123-456",
    statutoryName: "Maria Santos",
    customerToken: `jwt-${fx.storeCustomer?.customerId}`,
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // subtotal 10000 → 20% = 2000 off; + delivery 5000 → total 13000
  assert.equal(r.value.totalMinor, 13000);
  const order = await prisma.order.findUnique({ where: { id: r.value.orderId } });
  assert.equal(order?.discountMinor, 2000);
  assert.equal(order?.statutoryType, "senior");
  assert.equal(order?.statutoryId, "SC-123-456", "ID normalized to upper case");
  assert.equal(order?.statutoryName, "Maria Santos");
  const snap = (order?.snapshot as Record<string, unknown> | null) ?? {};
  assert.equal((snap.statutory as { type?: string } | null)?.type, "senior");
});

test("an invalid statutory claim is rejected with validation errors", async () => {
  const fx = await makeFixture({ seniorPwdEnabled: true });
  const svc = makeCheckoutService();
  const badTypeReq = {
    ...request(fx.cart.token, { statutoryId: "SC-123-456", statutoryName: "Maria Santos" }),
    statutoryType: "student",
  } as unknown as CheckoutRequest;
  const bad = await svc.checkout(badTypeReq);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(msgOf(bad.error), /statutoryType/);

  const shortId = await svc.checkout(request(fx.cart.token, {
    statutoryType: "pwd",
    statutoryId: "ab",
    statutoryName: "Juan Dela Cruz",
  }));
  assert.equal(shortId.ok, false);
  if (!shortId.ok) assert.match(msgOf(shortId.error), /ID number/);

  const shortName = await svc.checkout(request(fx.cart.token, {
    statutoryType: "senior",
    statutoryId: "SC-123-456",
    statutoryName: "A",
  }));
  assert.equal(shortName.ok, false);
  if (!shortName.ok) assert.match(msgOf(shortName.error), /name/i);
});

test("a store that disabled the statutory discount rejects the claim", async () => {
  const fx = await makeFixture({ seniorPwdEnabled: false });
  const svc = makeCheckoutService();
  const r = await svc.checkout(request(fx.cart.token, {
    statutoryType: "pwd",
    statutoryId: "PWD-987-654",
    statutoryName: "Juan Dela Cruz",
  }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(msgOf(r.error), /does not accept statutory discounts/i);
});

test("statutory stacks after a voucher but never exceeds the remaining subtotal", async () => {
  const fx = await makeFixture({ seniorPwdEnabled: true, voucherDiscountMinor: 9000 });
  const svc = makeCheckoutService();
  const r = await svc.checkout(request(fx.cart.token, {
    voucherCode: fx.voucher?.code,
    statutoryType: "senior",
    statutoryId: "SC-123-456",
    statutoryName: "Maria Santos",
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // subtotal 10000 → voucher 9000 + statutory capped at remaining 1000 → total 15000 − 10000 = 5000
  assert.equal(r.value.totalMinor, 5000);
  const order = await prisma.order.findUnique({ where: { id: r.value.orderId } });
  assert.equal(order?.discountMinor, 10000);
});

test("a customer-account checkout records an auditable DPA ConsentRecord", async () => {
  const fx = await makeFixture({ seniorPwdEnabled: true });
  const svc = makeCheckoutService();
  const r = await svc.checkout(request(fx.cart.token, {
    statutoryType: "pwd",
    statutoryId: "PWD-987-654",
    statutoryName: "Juan Dela Cruz",
    customerToken: `jwt-${fx.storeCustomer?.customerId}`,
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const consent = await prisma.consentRecord.findFirst({ where: { customerId: fx.storeCustomer?.customerId } });
  assert.ok(consent, "ConsentRecord written for the customer");
  assert.equal(consent?.scope, "dpv1");
  assert.equal(consent?.channel, "web");
  assert.equal(consent?.granted, true);
});
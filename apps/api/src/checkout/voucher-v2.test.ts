// P3a: voucher engine v2 through the real checkout path (real DB + Prisma repos).
// percent / free-delivery / first-order-only / per-customer / product-scope / stackable.
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

const run = `P3V${Date.now().toString().slice(-6)}`;
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
    await prisma.voucherRedemption.deleteMany({ where: { storeId } });
    await prisma.voucher.deleteMany({ where: { storeId } });
    const customers = (await prisma.storeCustomer.findMany({ where: { storeId }, select: { customerId: true } })).map((c) => c.customerId);
    await prisma.storeCustomer.deleteMany({ where: { storeId } });
    if (customers.length) await prisma.customer.deleteMany({ where: { id: { in: customers } } });
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

async function makeFixture(over: { voucher?: Partial<{ type: string; percentBp: number | null; discountMinor: number; firstOrderOnly: boolean; perCustomerLimit: number | null; scopeType: string; scopeRefId: string | null; stackable: boolean; minOrderMinor: number }>; priorOrders?: number; loyaltyPoints?: number } = {}) {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: {
      slug: `${String(slugSeq).padStart(2, "0")}${run}`,
      name: `P3 ${run}`,
      settings: { create: { deliveryFeeMinor: 5000, allowGuestOrders: true } },
    },
  });
  storeIds.push(store.id);

  const product = await prisma.product.create({ data: { storeId: store.id, sku: `P3-${slugSeq}-A`, name: "P3 A", priceMinor: 10000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 20, quantityReserved: 0 } });
  const productB = await prisma.product.create({ data: { storeId: store.id, sku: `P3-${slugSeq}-B`, name: "P3 B", priceMinor: 20000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: productB.id, quantityOnHand: 20, quantityReserved: 0 } });

  const voucher = await prisma.voucher.create({
    data: {
      storeId: store.id,
      code: `V${slugSeq}`,
      discountMinor: over.voucher?.discountMinor ?? 0,
      type: over.voucher?.type ?? "fixed",
      percentBp: over.voucher?.percentBp ?? null,
      firstOrderOnly: over.voucher?.firstOrderOnly ?? false,
      perCustomerLimit: over.voucher?.perCustomerLimit ?? null,
      scopeType: over.voucher?.scopeType ?? "all",
      scopeRefId: over.voucher?.scopeRefId ?? null,
      stackable: over.voucher?.stackable ?? false,
      minOrderMinor: over.voucher?.minOrderMinor ?? 0,
    },
  });

  // Customer profile (guests skip by not passing customerToken; the profile exists for account tests)
  let storeCustomer: { id: string; customerId: string } | null = null;
  {
    const customer = await prisma.customer.create({ data: { name: `Buyer ${slugSeq}`, phone: `+63919000000${slugSeq}`, email: null, passwordHash: null } });
    storeCustomer = await prisma.storeCustomer.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        loyaltyBalancePoints: over.loyaltyPoints ?? 0,
        creditApproved: true,
        creditLimitMinor: 1000000,
        creditBalanceMinor: 0,
      },
    });
    for (let i = 0; i < (over.priorOrders ?? 0); i += 1) {
      await prisma.order.create({
        data: {
          id: `p3prior-${run}-${slugSeq}-${i}`,
          orderNumber: `P3PRIOR-${run}-${slugSeq}-${i}`,
          storeId: store.id,
          status: "COMPLETED",
          source: "online",
          currencyCode: "PHP",
          subtotalMinor: 1000,
          deliveryFeeMinor: 0,
          discountMinor: 0,
          totalMinor: 1000,
          snapshot: {},
          paymentMethod: "cod",
          paymentStatus: "COLLECTED",
          idempotencyKey: `p3prior-${run}-${slugSeq}-${i}`,
          cartToken: "",
          customerName: "Prior",
          customerPhone: "+63",
          deliveryAddressLine1: "",
          storeCustomerId: storeCustomer.id,
        },
      });
    }
  }

  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `cart_${run}_${slugSeq}`, status: "OPEN" } });
  await prisma.cartItem.create({ data: { cartId: cart.id, storeId: store.id, productId: product.id, quantity: 1, unitPriceMinor: 10000 } });

  return { store, product, productB, voucher, cart, storeCustomer };
}

function makeCheckoutService() {
  const loyalty = new LoyaltyService();
  const svc = new CheckoutService(
    new PrismaStoreRepository(),
    new PrismaCatalogRepository(),
    new PrismaCartRepository(),
    new PrismaOrderRepository(),
    new PrismaOrderSequenceRepository(),
    "test-claim-secret-0123456789",
    undefined,
    new VoucherPublicService(),
    loyalty,
    async (token: string) => token.replace("jwt-", ""), // resolveCustomer stub: token "jwt-<customerId>"
  );
  return { svc, loyalty };
}

function request(cartToken: string, over: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    cartToken,
    customerName: "P3 Buyer",
    customerPhone: "+639170000999",
    deliveryAddressLine1: "1 P3 St",
    deliveryType: "delivery",
    paymentMethod: "cod",
    idempotencyKey: `p3ck-${cartToken}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

function msgOf(error: { message?: string } | { errors?: string[] }): string {
  return "message" in error && typeof error.message === "string" ? error.message : "";
}

test("percent voucher: 10% of the subtotal is discounted", async () => {
  const fx = await makeFixture({ voucher: { type: "percent", percentBp: 1000, discountMinor: 0, stackable: true } });
  const { svc } = makeCheckoutService();
  const r = await svc.checkout(request(fx.cart.token, { voucherCode: fx.voucher.code }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // subtotal 10000 → 10% = 1000 off; + delivery 5000 → total 14000
  assert.equal(r.value.totalMinor, 14000);
  const order = await prisma.order.findUnique({ where: { id: r.value.orderId } });
  assert.equal(order?.discountMinor, 1000);
  const red = await prisma.voucherRedemption.findFirst({ where: { orderId: order?.id } });
  assert.ok(red);
  void fx;
});

test("free-delivery voucher waives the delivery fee", async () => {
  const fx = await makeFixture({ voucher: { type: "free_delivery", discountMinor: 0, stackable: true } });
  const { svc } = makeCheckoutService();
  const r = await svc.checkout(request(fx.cart.token, { voucherCode: fx.voucher.code }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.totalMinor, 10000, "subtotal only — delivery fee waived");
  const order = await prisma.order.findUnique({ where: { id: r.value.orderId } });
  assert.equal(order?.deliveryFeeMinor, 5000, "fee still recorded");
  assert.equal(order?.discountMinor, 5000, "fee discounted away");
});

test("first-order-only voucher: repeat customers and guests rejected, first-timer accepted", async () => {
  const fxRepeat = await makeFixture({ voucher: { type: "fixed", discountMinor: 500, firstOrderOnly: true, stackable: true }, priorOrders: 2 });
  const { svc } = makeCheckoutService();
  const asCustomer = (fx: typeof fxRepeat) =>
    request(fx.cart.token, { voucherCode: fx.voucher.code, customerToken: `jwt-${fx.storeCustomer?.customerId}` });
  const repeat = await svc.checkout(asCustomer(fxRepeat));
  assert.equal(repeat.ok, false);
  if (!repeat.ok) assert.match(msgOf(repeat.error), /first orders only/i);

  const fxGuest = await makeFixture({ voucher: { type: "fixed", discountMinor: 500, firstOrderOnly: true, stackable: true }, priorOrders: 0 });
  const guest = await svc.checkout(request(fxGuest.cart.token, { voucherCode: fxGuest.voucher.code }));
  assert.equal(guest.ok, false);
  if (!guest.ok) assert.match(msgOf(guest.error), /first orders only/i);

  const fxFirst = await makeFixture({ voucher: { type: "fixed", discountMinor: 500, firstOrderOnly: true, stackable: true }, priorOrders: 0 });
  const first = await svc.checkout(asCustomer(fxFirst));
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value.totalMinor, 10000 + 5000 - 500);
});

test("per-customer limit: second redemption is rejected", async () => {
  const fx = await makeFixture({ voucher: { type: "fixed", discountMinor: 300, perCustomerLimit: 1, stackable: true }, priorOrders: 0 });
  const { svc } = makeCheckoutService();
  const asCustomer = () => request(fx.cart.token, { voucherCode: fx.voucher.code, customerToken: `jwt-${fx.storeCustomer?.customerId}` });

  // First checkout consumes the voucher → success.
  const first = await svc.checkout(asCustomer());
  assert.equal(first.ok, true);
  // Second attempt (fresh cart, same customer) → per-customer limit.
  const cart2 = await prisma.cart.create({ data: { storeId: fx.store.id, token: `cart2_${run}_${slugSeq}`, status: "OPEN" } });
  await prisma.cartItem.create({ data: { cartId: cart2.id, storeId: fx.store.id, productId: fx.product.id, quantity: 1, unitPriceMinor: 10000 } });
  const second = await svc.checkout(request(cart2.token, { voucherCode: fx.voucher.code, customerToken: `jwt-${fx.storeCustomer?.customerId}` }));
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(msgOf(second.error), /already used/i);
});

test("product-scoped voucher: matches only carts containing that product", async () => {
  const fxMatch = await makeFixture({ voucher: { type: "fixed", discountMinor: 400, scopeType: "product", scopeRefId: "P3-REF", stackable: true } });
  await prisma.voucher.update({ where: { id: fxMatch.voucher.id }, data: { scopeRefId: fxMatch.product.id } });
  const { svc } = makeCheckoutService();
  const ok = await svc.checkout(request(fxMatch.cart.token, { voucherCode: fxMatch.voucher.code }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.totalMinor, 10000 + 5000 - 400);

  const fxMiss = await makeFixture({ voucher: { type: "fixed", discountMinor: 400, scopeType: "product", scopeRefId: "P3-REF", stackable: true } });
  await prisma.voucher.update({ where: { id: fxMiss.voucher.id }, data: { scopeRefId: fxMiss.productB.id } });
  const dbV = await prisma.voucher.findUnique({ where: { id: fxMiss.voucher.id } });
  const cartItems = await prisma.cartItem.findMany({ where: { cartId: fxMiss.cart.id } });
  void dbV; void cartItems;
  const miss = await svc.checkout(request(fxMiss.cart.token, { voucherCode: fxMiss.voucher.code }));
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(msgOf(miss.error), /does not apply/i);
});

test("non-stackable voucher blocks loyalty points; stackable allows both", async () => {
  const fxNo = await makeFixture({ voucher: { type: "fixed", discountMinor: 200, stackable: false }, loyaltyPoints: 5000, priorOrders: 0 });
  const { svc } = makeCheckoutService();
  const blocked = await svc.checkout(request(fxNo.cart.token, {
    voucherCode: fxNo.voucher.code,
    customerToken: `jwt-${fxNo.storeCustomer?.customerId}`,
    loyaltyPoints: 100,
  }));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(msgOf(blocked.error), /cannot be combined/i);

  const fxOk = await makeFixture({ voucher: { type: "fixed", discountMinor: 200, stackable: true }, loyaltyPoints: 5000, priorOrders: 0 });
  const combined = await svc.checkout(request(fxOk.cart.token, {
    voucherCode: fxOk.voucher.code,
    customerToken: `jwt-${fxOk.storeCustomer?.customerId}`,
    loyaltyPoints: 100,
  }));
  assert.equal(combined.ok, true);
});

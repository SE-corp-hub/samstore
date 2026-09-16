// P2a: variants + add-ons through the real stack (real DB + Prisma repos).
// - add variant/add-on lines: correct price, distinct lines per add-on combo
// - stock guard on variant counters
// - checkout reserves VARIANT stock atomically + snapshots variant name/add-ons
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
import { CartService } from "../cart/cart.service.js";
import { CheckoutService } from "../checkout/checkout.service.js";
import type { CheckoutRequest } from "@sam-store/contracts";

const run = `P2C${Date.now().toString().slice(-6)}`;
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
    await prisma.stockLevel.deleteMany({ where: { storeId } });
    await prisma.productAddonOption.deleteMany({ where: { addon: { storeId } } });
    await prisma.productAddon.deleteMany({ where: { storeId } });
    await prisma.productVariant.deleteMany({ where: { storeId } });
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
      name: `P2A ${run}`,
      settings: { create: { deliveryFeeMinor: 5000, allowGuestOrders: true } },
    },
  });
  storeIds.push(store.id);

  // Plain product with StockLevel
  const plain = await prisma.product.create({
    data: { storeId: store.id, sku: `P2-PLAIN-${slugSeq}`, name: "Plain", priceMinor: 9900 },
  });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: plain.id, quantityOnHand: 10, quantityReserved: 0 } });

  // Variant product with its own stock + add-on group
  const kape = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `P2-KAPE-${slugSeq}`,
      name: "Kape P2A",
      priceMinor: 10000,
      variants: {
        create: [
          { name: "Hot", sku: `P2-KAPE-H-${slugSeq}`, priceMinor: 10000, quantityOnHand: 5, quantityReserved: 0 },
          { name: "Iced", sku: `P2-KAPE-I-${slugSeq}`, priceMinor: 12000, quantityOnHand: 5, quantityReserved: 0 },
        ],
      },
      addons: {
        create: [
          {
            name: "Extras",
            options: {
              create: [
                { name: "Extra shot", priceMinor: 2000 },
                { name: "Milk", priceMinor: 3000 },
              ],
            },
          },
        ],
      },
    },
    include: { variants: true, addons: { include: { options: true } } },
  });

  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `cart_${run}_${slugSeq}`, status: "OPEN" } });
  return { store, plain, kape, cart };
}

const cartService = new CartService(new PrismaCartRepository(), new PrismaCatalogRepository());
const checkoutService = new CheckoutService(
  new PrismaStoreRepository(),
  new PrismaCatalogRepository(),
  new PrismaCartRepository(),
  new PrismaOrderRepository(),
  new PrismaOrderSequenceRepository(),
  "test-claim-secret-0123456789",
);

test("add variant + add-ons prices the line server-side and keeps distinct combos apart", async () => {
  const fx = await makeFixture();
  const hot = fx.kape.variants.find((v) => v.name === "Hot")!;
  const shot = fx.kape.addons[0]!.options.find((o) => o.name === "Extra shot")!;
  const milk = fx.kape.addons[0]!.options.find((o) => o.name === "Milk")!;

  const cart1 = await cartService.addItem(fx.cart.token, fx.kape.id, 1, { variantId: hot.id, addons: [{ addonId: fx.kape.addons[0]!.id, optionId: shot.id }] });
  assert.equal(cart1.ok, true);
  const cart2 = await cartService.addItem(fx.cart.token, fx.kape.id, 1, { variantId: hot.id, addons: [{ addonId: fx.kape.addons[0]!.id, optionId: milk.id }] });
  assert.equal(cart2.ok, true);
  const cart3 = await cartService.addItem(fx.cart.token, fx.plain.id, 1);
  assert.equal(cart3.ok, true);

  const final = await cartService.getCart(fx.cart.token);
  assert.equal(final.ok, true);
  if (!final.ok) return;
  const lines = final.value.items;
  assert.equal(lines.length, 3, "hot+shot, hot+milk, plain are 3 distinct lines");

  const hotShot = lines.find((l) => l.productId === fx.kape.id && l.variant?.id === hot.id && l.addons.some((a) => a.optionId === shot.id));
  assert.ok(hotShot);
  assert.equal(hotShot?.unitPriceMinor, 10000, "hot variant price");
  assert.equal(hotShot?.addonsTotalMinor, 2000, "extra shot priced server-side");
  assert.equal(hotShot?.lineTotalMinor, 12000);

  const hotMilk = lines.find((l) => l.productId === fx.kape.id && l.variant?.id === hot.id && l.addons.some((a) => a.optionId === milk.id));
  assert.ok(hotMilk);
  assert.equal(hotMilk?.addonsTotalMinor, 3000);

  const plainLine = lines.find((l) => l.productId === fx.plain.id);
  assert.equal(plainLine?.unitPriceMinor, 9900);
  assert.equal(plainLine?.addonsTotalMinor, 0);
});

test("variant stock guard: cannot over-commit variant availability", async () => {
  const fx = await makeFixture();
  const iced = fx.kape.variants.find((v) => v.name === "Iced")!; // onHand 5
  for (let i = 0; i < 5; i += 1) {
    const r = await cartService.addItem(fx.cart.token, fx.kape.id, 1, { variantId: iced.id });
    assert.equal(r.ok, true);
  }
  const over = await cartService.addItem(fx.cart.token, fx.kape.id, 1, { variantId: iced.id });
  assert.equal(over.ok, false);
  if (!over.ok) {
    const msg = "message" in over.error ? over.error.message : "";
    assert.match(msg, /Only 5 in stock/i);
  }
});

test("cross-product variant is rejected", async () => {
  const fx = await makeFixture();
  const hot = fx.kape.variants.find((v) => v.name === "Hot")!;
  const r = await cartService.addItem(fx.cart.token, fx.plain.id, 1, { variantId: hot.id });
  assert.equal(r.ok, false);
  if (!r.ok) {
    const errors = "errors" in r.error ? r.error.errors : [];
    assert.match(errors.join() ?? "", /Variant does not belong/i);
  }
});

test("checkout reserves VARIANT stock atomically and snapshots variant + add-ons", async () => {
  const fx = await makeFixture();
  const iced = fx.kape.variants.find((v) => v.name === "Iced")!;
  const shot = fx.kape.addons[0]!.options.find((o) => o.name === "Extra shot")!;

  const add = await cartService.addItem(fx.cart.token, fx.kape.id, 2, {
    variantId: iced.id,
    addons: [{ addonId: fx.kape.addons[0]!.id, optionId: shot.id }],
  });
  assert.equal(add.ok, true);
  const line = add.value.items[0]!;
  const unitTotal = line.unitPriceMinor + line.addonsTotalMinor; // 12000 + 2000

  const req: CheckoutRequest = {
    cartToken: fx.cart.token,
    customerName: "P2 Buyer",
    customerPhone: "+639170000321",
    deliveryAddressLine1: "1 P2 St",
    deliveryType: "delivery",
    paymentMethod: "cod",
    idempotencyKey: `p2ck-${fx.cart.token}-${Date.now()}`,
  };
  const result = await checkoutService.checkout(req);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const order = await prisma.order.findUnique({ where: { id: result.value.orderId }, include: { items: true } });
  assert.ok(order);
  assert.equal(order.subtotalMinor, unitTotal * 2, "add-on costs included in subtotal");
  assert.equal(order.totalMinor, unitTotal * 2 + 5000);

  const item = order.items.find((i) => i.productId === fx.kape.id);
  assert.ok(item);
  assert.equal(item.variantId, iced.id);
  assert.equal(item.variantName, "Iced");
  assert.ok(JSON.stringify(item.addons).includes("Extra shot"));

  const variantNow = await prisma.productVariant.findUnique({ where: { id: iced.id } });
  assert.equal(variantNow?.quantityReserved, 2, "variant stock reserved atomically");
  const movement = await prisma.stockMovement.findFirst({
    where: { orderId: order.id, variantId: iced.id, type: "RESERVE" },
  });
  assert.ok(movement, "variant reservation audited in StockMovement");
  assert.equal(movement?.delta, 2);
});
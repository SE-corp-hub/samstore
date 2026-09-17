// P2b: POS variant selling (real DB).
// - sell on utang with a variant: order priced/snapshotted from the VARIANT, its
//   counter decremented, variant RESERVE/CONSUME movement audited
// - beyond-variant-stock rejected; cross-product variant rejected; hold+void restores
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { RegisterService } from "../registers/register.service.js";

const run = `P2PV${Date.now().toString().slice(-6)}`;
const storeIds: string[] = [];
let seq = 0;

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
    await prisma.payment.deleteMany({ where: { storeId } });
    const customers = (await prisma.storeCustomer.findMany({ where: { storeId }, select: { customerId: true } })).map((c) => c.customerId);
    await prisma.storeCustomer.deleteMany({ where: { storeId } });
    if (customers.length) {
      await prisma.consentRecord.deleteMany({ where: { customerId: { in: customers } } });
      await prisma.storeCustomerAddress.deleteMany({ where: { storeCustomer: { customerId: { in: customers } } } });
      await prisma.customer.deleteMany({ where: { id: { in: customers } } });
    }
    await prisma.productVariant.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.storeCounter.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

const svc = new PosService(new LoyaltyService(), new RegisterService());

async function makeFixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${String(seq).padStart(2, "0")}${run}`, name: `P2 PV ${run}` } });
  storeIds.push(store.id);

  const kape = await prisma.product.create({
    data: {
      storeId: store.id,
      sku: `PV-KAPE-${seq}`,
      name: "PV Kape",
      priceMinor: 10000,
      variants: {
        create: [
          { name: "Hot", sku: `PV-KAPE-H-${seq}`, priceMinor: 10000, quantityOnHand: 5, quantityReserved: 0 },
          { name: "Iced", sku: `PV-KAPE-I-${seq}`, priceMinor: 12000, quantityOnHand: 3, quantityReserved: 0 },
        ],
      },
    },
    include: { variants: true },
  });

  const customer = await prisma.customer.create({ data: { name: "PV Buyer", phone: `+63918000000${seq}`, email: null, passwordHash: null } });
  const sc = await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: customer.id, creditApproved: true, creditLimitMinor: 1000000, creditBalanceMinor: 0 } });
  const sig = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`;

  return { store, kape, customerId: sc.id, sig };
}

test("POS utang sale with a variant: variant price, snapshot, and counter decrement", async () => {
  const fx = await makeFixture();
  const iced = fx.kape.variants.find((v) => v.name === "Iced")!;

  const sell = await svc.sell(fx.store.id, "tester", {
    items: [{ productId: fx.kape.id, variantId: iced.id, quantity: 2 }],
    paymentMethod: "credit",
    customerId: fx.customerId,
    signatureData: fx.sig,
  });
  assert.equal(sell.ok, true);
  if (!sell.ok) return;
  assert.equal(sell.value.totalMinor, 24000, "2 × iced @12000");

  const order = await prisma.order.findUnique({ where: { id: sell.value.orderId }, include: { items: true } });
  assert.ok(order);
  assert.equal(order.subtotalMinor, 24000);
  const item = order.items.find((i) => i.productId === fx.kape.id);
  assert.ok(item);
  assert.equal(item.variantId, iced.id);
  assert.equal(item.variantName, "Iced");
  assert.equal(item.sku, iced.sku);
  assert.equal(item.unitPriceMinor, 12000);

  const variantNow = await prisma.productVariant.findUnique({ where: { id: iced.id } });
  assert.equal(variantNow?.quantityOnHand, 1, "5 - 2 = 3 → iced started 3, now 1");

  const movement = await prisma.stockMovement.findFirst({ where: { orderId: order.id, variantId: iced.id, type: "CONSUME" } });
  assert.ok(movement, "variant consume movement audited");
  assert.equal(movement?.delta, -2);
});

test("POS sale beyond variant stock is rejected", async () => {
  const fx = await makeFixture();
  const iced = fx.kape.variants.find((v) => v.name === "Iced")!; // 3 on hand
  const sell = await svc.sell(fx.store.id, "tester", {
    items: [{ productId: fx.kape.id, variantId: iced.id, quantity: 4 }],
    paymentMethod: "credit",
    customerId: fx.customerId,
    signatureData: fx.sig,
  });
  assert.equal(sell.ok, false);
  if (!sell.ok) {
    assert.equal(sell.error.type, "conflict");
    if ("message" in sell.error) assert.match(sell.error.message, /Only 3 in stock/i);
  }
});

test("POS rejects a variant that does not belong to the product", async () => {
  const fx = await makeFixture();
  const hot = fx.kape.variants.find((v) => v.name === "Hot")!;
  const plain = await prisma.product.create({ data: { storeId: fx.store.id, sku: `PV-PLAIN-${seq}`, name: "PV Plain", priceMinor: 5000 } });
  const sell = await svc.sell(fx.store.id, "tester", {
    items: [{ productId: plain.id, variantId: hot.id, quantity: 1 }],
    paymentMethod: "credit",
    customerId: fx.customerId,
    signatureData: fx.sig,
  });
  assert.equal(sell.ok, false);
  if (!sell.ok) {
    assert.equal(sell.error.type, "validation");
  }
});

test("POS hold with a variant reserves variant stock and void restores it", async () => {
  const fx = await makeFixture();
  const hot = fx.kape.variants.find((v) => v.name === "Hot")!; // 5
  const held = await svc.hold(fx.store.id, "tester", { items: [{ productId: fx.kape.id, variantId: hot.id, quantity: 2 }], customerId: fx.customerId });
  assert.equal(held.ok, true);
  if (!held.ok) return;

  const doneOrder = await prisma.order.findUnique({ where: { id: held.value.orderId }, include: { items: true } });
  assert.ok(doneOrder);
  assert.equal(doneOrder.status, "ON_HOLD");
  const item = doneOrder.items.find((i) => i.productId === fx.kape.id);
  assert.equal(item?.variantId, hot.id);
  assert.equal(item?.variantName, "Hot");

  const variantNow = await prisma.productVariant.findUnique({ where: { id: hot.id } });
  assert.equal(variantNow?.quantityOnHand, 3, "5 - 2");

  const vo = await svc.voidHold(fx.store.id, "tester", held.value.orderId, "test void");
  assert.equal(vo.ok, true);
  const afterVoid = await prisma.productVariant.findUnique({ where: { id: hot.id } });
  assert.equal(afterVoid?.quantityOnHand, 5, "restored after void");
});
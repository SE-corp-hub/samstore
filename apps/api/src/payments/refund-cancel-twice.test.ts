// Inventory audit 2026-11-21: a refund, a void, a cancelled pre-order or a change of a pre-order's items
// tapped twice at the same moment (double tap, a slow line and a retry, the offline queue sending again,
// two tablets) must give the money and the rice back ONCE.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { PaymentsService } from "./payments.service.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { OrderAdminService } from "../admin/order-admin.service.js";
import { clearStoreActivity } from "../admin/clear-store-activity.js";
import type { Actor } from "../people/people.service.js";

const run = `twice${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const key = () => `tap-${randomBytes(8).toString("hex")}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];

after(async () => {
  for (const storeId of storeIds) {
    await clearStoreActivity(storeId, { apply: true });
    const where = { storeId };
    await prisma.auditLog.deleteMany({ where });
    await prisma.priceHistory.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.delete({ where: { id: storeId } });
  }
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  const store = await prisma.store.create({ data: { slug: `${run}-${storeIds.length}`, name: "Twice" } });
  storeIds.push(store.id);
  const storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const sack = await prisma.product.create({ data: { storeId, sku: `${run}-S25-${storeIds.length}`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  await prisma.stockLevel.create({ data: { storeId, productId: sack.id, warehouseId: s1.id, quantityOnHand: 20 } });
  const user = await prisma.user.create({ data: { email: `${run}-${storeIds.length}@twice.test`, passwordHash: "x", name: "Lucy", role: "STORE_OWNER" } });
  userIds.push(user.id);
  await prisma.userStore.create({ data: { userId: user.id, storeId, role: "OWNER" } });
  const owner: Actor = { userId: user.id, role: "OWNER", homeLocationId: null };
  const cust = await prisma.customer.create({ data: { name: "Aling Nena" } });
  customerIds.push(cust.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId, customerId: cust.id, creditApproved: true, creditUnlimited: true } });
  const onShelf = async () => (await prisma.stockLevel.findFirstOrThrow({ where: { storeId, productId: sack.id, warehouseId: s1.id } })).quantityOnHand;
  return { storeId, s1, sack, owner, sc, onShelf };
}

test("refund tapped twice at once: the cash and the rice go back once", async () => {
  const fx = await fixture();
  const sale = await new BentaService().sell(fx.storeId, fx.owner, { idempotencyKey: key(), locationId: fx.s1.id, lines: [{ productId: fx.sack.id, quantity: 3 }], payment: { method: "cash" } });
  assert.ok(sale.ok);
  assert.equal(await fx.onShelf(), 17);
  const pay = new PaymentsService();
  const both = await Promise.all([pay.refundOrder(sale.value.orderId, fx.storeId, fx.owner.userId, undefined, "x"), pay.refundOrder(sale.value.orderId, fx.storeId, fx.owner.userId, undefined, "x")]);
  assert.deepEqual(both.map((r) => r.ok).sort(), [false, true], "one refund goes through, the other is refused");
  assert.equal(await fx.onShelf(), 20, "3 sacks back, not 6");
  const back = await prisma.payment.aggregate({ where: { orderId: sale.value.orderId, type: "refund" }, _sum: { amountMinor: true } });
  assert.equal(back._sum.amountMinor, -390_000, "₱3,900 given back once (it was ₱7,800)");
});

test("void of a credit sale tapped twice at once: the rice goes back once, and a void puts back only what the sale took", async () => {
  const fx = await fixture();
  const sale = await new BentaService().sell(fx.storeId, fx.owner, {
    idempotencyKey: key(), locationId: fx.s1.id, lines: [{ productId: fx.sack.id, quantity: 2 }], payment: { method: "utang" }, customerId: fx.sc.id,
    signatures: [{ signerKind: "CUSTOMER", signerName: "Nena", imagePng: PNG }],
  });
  assert.ok(sale.ok);
  assert.equal(await fx.onShelf(), 18);
  const pay = new PaymentsService();
  const both = await Promise.all([pay.voidOrder(sale.value.orderId, fx.storeId, fx.owner.userId, "x"), pay.voidOrder(sale.value.orderId, fx.storeId, fx.owner.userId, "x")]);
  assert.deepEqual(both.map((r) => r.ok).sort(), [false, true]);
  assert.equal(await fx.onShelf(), 20, "2 sacks back, not 4");
  const owed = await prisma.storeCustomer.findUniqueOrThrow({ where: { id: fx.sc.id }, select: { creditBalanceMinor: true } });
  assert.equal(owed.creditBalanceMinor, 0);
});

test("pre-order cancelled twice at once: its rice goes back once", async () => {
  const fx = await fixture();
  const pos = new PosService(new LoyaltyService());
  const who = { userId: fx.owner.userId, role: "OWNER", homeLocationId: null } as never;
  const po = await pos.createPreOrder(fx.storeId, who, { customerId: fx.sc.id, items: [{ productId: fx.sack.id, quantity: 2 }], idempotencyKey: key(), locationId: fx.s1.id });
  assert.ok(po.ok);
  assert.equal(await fx.onShelf(), 18);
  const both = await Promise.all([pos.voidHold(fx.storeId, who, po.value.orderId, "x"), pos.voidHold(fx.storeId, who, po.value.orderId, "x")]);
  assert.deepEqual(both.map((r) => r.ok).sort(), [false, true]);
  assert.equal(await fx.onShelf(), 20, "2 sacks back, not 4");
});

test("a pre-order's items changed twice at once (Orders → Change items): the shelf follows the last save, and a pre-order may still go below zero", async () => {
  const fx = await fixture();
  const pos = new PosService(new LoyaltyService());
  const who = { userId: fx.owner.userId, role: "OWNER", homeLocationId: null } as never;
  const po = await pos.createPreOrder(fx.storeId, who, { customerId: fx.sc.id, items: [{ productId: fx.sack.id, quantity: 2 }], idempotencyKey: key(), locationId: fx.s1.id });
  assert.ok(po.ok);
  const orders = new OrderAdminService();
  const both = await Promise.all([
    orders.replaceOrderItems(fx.storeId, po.value.orderId, [{ productId: fx.sack.id, quantity: 3 }], fx.owner.userId, "OWNER"),
    orders.replaceOrderItems(fx.storeId, po.value.orderId, [{ productId: fx.sack.id, quantity: 3 }], fx.owner.userId, "OWNER"),
  ]);
  assert.ok(both.every((r) => r.ok), JSON.stringify(both));
  assert.equal(await fx.onShelf(), 17, "3 sacks on the pre-order → 17 left (it was 16: the old 2 went back twice)");

  // Bigger than the shelf: a pre-order is allowed below zero, as when it was made.
  const big = await orders.replaceOrderItems(fx.storeId, po.value.orderId, [{ productId: fx.sack.id, quantity: 25 }], fx.owner.userId, "OWNER");
  assert.ok(big.ok, JSON.stringify(big));
  assert.equal(await fx.onShelf(), -5);
  const cancel = await pos.voidHold(fx.storeId, who, po.value.orderId, "x");
  assert.ok(cancel.ok);
  assert.equal(await fx.onShelf(), 20);
});

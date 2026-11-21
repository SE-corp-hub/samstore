// Per-kilo audit 2026-11-21: kilo rice (stock kept in grams) through Returns and Orders → Change items.
//  - A return of kilo rice is entered in kilos: "2" used to mean 2 GRAMS back on the shelf.
//  - The Returns sale list showed a 25 kg sack sale in kilos (2 sacks read "0.002 kg").
//  - Change items on an order with a kilo line priced the grams as pieces (2 kg at ₱56 → ₱112,000) and
//    dropped how the line was sold (kilos, "₱100 worth") and where it was taken from.
//  - Change items on an agent order before it is approved took rice off the shelf (it is taken on the trips),
//    and Receive in Orders moved an agent order on with no trips, so its rice never left the shelf.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { TransferFlowService } from "./transfer-flow.service.js";
import { AgentOrderService } from "../agent/agent-order.service.js";
import { OrderAdminService } from "../admin/order-admin.service.js";
import { clearStoreActivity } from "../admin/clear-store-activity.js";
import { checkChain } from "../domain/stock-book.js";
import { PeopleService, type Actor } from "../people/people.service.js";
import "../utang/utang.service.js"; // registers the money side of a return (REFUND approvals)

const run = `kiloret${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const sig = [{ signerKind: "STAFF", imagePng: PNG }];
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
    await prisma.rackSack.deleteMany({ where });
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
  const n = storeIds.length;
  const store = await prisma.store.create({ data: { slug: `${run}-${n}`, name: "Kilo returns" } });
  storeIds.push(store.id);
  const storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true, sellPerKilo: true } });
  const sack = await prisma.product.create({ data: { storeId, sku: `${run}-S25-${n}`, name: "Sinandomeng 25 kg", priceMinor: 135_000, costMinor: 125_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const kilo = await prisma.product.create({ data: { storeId, sku: `${run}-K-${n}`, name: "Sinandomeng per kilo", priceMinor: 5_600, costMinor: 5_000, stockBaseUnit: "g", stockBaseQuantity: 1, soldByWeight: true, unit: "kilo" } });
  await prisma.stockLevel.create({ data: { storeId, productId: sack.id, warehouseId: s1.id, quantityOnHand: 10 } });
  await prisma.stockLevel.create({ data: { storeId, productId: kilo.id, warehouseId: s1.id, quantityOnHand: 20_000 } });
  const user = await prisma.user.create({ data: { email: `${run}-${n}@kilo.test`, passwordHash: "x", name: "Lucy", role: "STORE_OWNER", pinHash: await bcrypt.hash("2468", 4) } });
  userIds.push(user.id);
  await prisma.userStore.create({ data: { userId: user.id, storeId, role: "OWNER" } });
  const owner: Actor = { userId: user.id, role: "OWNER", homeLocationId: null };
  const cust = await prisma.customer.create({ data: { name: "Aling Nena" } });
  customerIds.push(cust.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId, customerId: cust.id, creditApproved: true, creditUnlimited: true } });
  const onShelf = async (productId: string) => (await prisma.stockLevel.findFirstOrThrow({ where: { storeId, productId, warehouseId: s1.id } })).quantityOnHand;
  const chainOk = async (productId: string) => {
    const rows = await prisma.stockMovement.findMany({ where: { storeId, productId, warehouseId: s1.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    return checkChain(rows, await onShelf(productId)).status;
  };
  const sell = async (lines: object[]) => {
    const r = await new BentaService().sell(storeId, owner, { idempotencyKey: key(), locationId: s1.id, lines: lines as never, payment: { method: "cash" } });
    assert.ok(r.ok, JSON.stringify(r));
    return r.value.orderId;
  };
  return { storeId, s1, sack, kilo, owner, sc, onShelf, chainOk, sell };
}

test("a return of kilo rice is entered in kilos, and the refund is worked out per kilo", async () => {
  const fx = await fixture();
  const flow = new TransferFlowService();
  const orderId = await fx.sell([{ productId: fx.kilo.id, kilos: "2.5" }]);
  assert.equal(await fx.onShelf(fx.kilo.id), 17_500);

  // "2" as a count would be 2 grams: refused for kilo rice.
  const asCount = await flow.createReturn(fx.storeId, fx.owner, { locationId: fx.s1.id, productId: fx.kilo.id, quantity: 2, condition: "GOOD", reason: "too much", orderId, signatures: sig });
  assert.equal(asCount.ok, false, "kilo rice needs kilos (it put 2 grams back)");
  assert.equal(await fx.onShelf(fx.kilo.id), 17_500);

  const ret = await flow.createReturn(fx.storeId, fx.owner, { locationId: fx.s1.id, productId: fx.kilo.id, kilos: "1.5", condition: "GOOD", reason: "too much", orderId, signatures: sig });
  assert.ok(ret.ok, JSON.stringify(ret));
  assert.equal(await fx.onShelf(fx.kilo.id), 19_000, "1.5 kg back on the shelf");

  // Only 1 kg is left of that sale.
  const tooMuch = await flow.createReturn(fx.storeId, fx.owner, { locationId: fx.s1.id, productId: fx.kilo.id, kilos: "2", condition: "GOOD", reason: "more", orderId, signatures: sig });
  assert.equal(tooMuch.ok, false);
  assert.match(JSON.stringify(tooMuch), /2\.5 kg/);
  // Kilos for a sack are refused too.
  assert.equal((await flow.createReturn(fx.storeId, fx.owner, { locationId: fx.s1.id, productId: fx.sack.id, kilos: "1", condition: "GOOD", reason: "x", signatures: sig })).ok, false);

  const recent = await flow.recentReturns(fx.storeId, fx.owner);
  assert.equal(recent[0]?.loose, true);

  // Approving "refund the payment" gives back 1.5 kg × ₱56 = ₱84.
  assert.ok((await new PeopleService().decideApproval(fx.storeId, ret.value.approvalId, fx.owner, { decision: "APPROVE", pin: "2468" })).ok);
  const back = await prisma.payment.findMany({ where: { orderId, type: "refund" }, select: { amountMinor: true } });
  assert.deepEqual(back.map((p) => Math.abs(p.amountMinor)), [8_400]);
  assert.equal(await fx.chainOk(fx.kilo.id), "ok");
});

test("the Returns sale list shows a sack sale in sacks and a kilo sale in kilos", async () => {
  const fx = await fixture();
  const flow = new TransferFlowService();
  await fx.sell([{ productId: fx.sack.id, quantity: 2 }]);
  await fx.sell([{ productId: fx.kilo.id, kilos: "3" }]);
  const sacks = await flow.salesFor(fx.storeId, fx.owner, { locationId: fx.s1.id, productId: fx.sack.id });
  assert.ok(sacks.ok);
  assert.deepEqual(sacks.value.sales.map((s) => [s.bought, s.loose]), [[2, false]], "2 sacks (it read 0.002 kg)");
  const kilos = await flow.salesFor(fx.storeId, fx.owner, { locationId: fx.s1.id, productId: fx.kilo.id });
  assert.ok(kilos.ok);
  assert.deepEqual(kilos.value.sales.map((s) => [s.bought, s.loose]), [[3_000, true]]);
});

test("Change items on an order with kilo rice: priced per kilo, the kilo line and how it was sold are kept", async () => {
  const fx = await fixture();
  const agent = new AgentOrderService();
  const made = await agent.create(fx.storeId, fx.owner, { idempotencyKey: key(), locationId: fx.s1.id, customerId: fx.sc.id, address: "Bauan", lines: [{ productId: fx.kilo.id, amountMinor: 10_000 }, { productId: fx.sack.id, quantity: 1 }] } as never);
  assert.ok(made.ok, JSON.stringify(made));
  const orderId = (made.value as { id: string }).id;
  const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  const pesoLine = before.items.find((i) => i.productId === fx.kilo.id)!;
  assert.equal(pesoLine.soldBy, "PESO");
  assert.equal(before.totalMinor, 145_000);

  const orders = new OrderAdminService();
  const same = await orders.replaceOrderItems(fx.storeId, orderId, before.items.map((i) => ({ productId: i.productId!, quantity: i.quantity })), fx.owner.userId, "OWNER");
  assert.ok(same.ok, JSON.stringify(same));
  const kept = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  assert.equal(kept.totalMinor, 145_000, "nothing changed, the total stays ₱1,450 (it became ₱100,135,000)");
  const k = kept.items.find((i) => i.productId === fx.kilo.id)!;
  assert.deepEqual([k.soldBy, k.grams, k.lineTotalMinor, k.enteredAmountMinor], ["PESO", pesoLine.quantity, 10_000, 10_000]);
  assert.equal(kept.items.find((i) => i.productId === fx.sack.id)!.grams, 25_000);

  // 3 kg instead: priced per kilo, sold by the kilo now.
  const more = await orders.replaceOrderItems(fx.storeId, orderId, [{ productId: fx.kilo.id, quantity: 3_000 }, { productId: fx.sack.id, quantity: 1 }], fx.owner.userId, "OWNER");
  assert.ok(more.ok, JSON.stringify(more));
  assert.equal(more.value.totalMinor, 135_000 + 16_800);
  const k3 = (await prisma.orderItem.findMany({ where: { orderId, productId: fx.kilo.id } }))[0]!;
  assert.deepEqual([k3.soldBy, k3.grams, k3.lineTotalMinor], ["KILO", 3_000, 16_800]);

  // Not approved yet: no rice left the shelf, and none may leave on a change.
  assert.equal(await fx.onShelf(fx.kilo.id), 20_000, "the shelf is untouched until the order is approved (it lost 3 kg − 1.785 kg)");
  assert.equal(await fx.onShelf(fx.sack.id), 10);

  // Receive / Send for delivery in Orders would move it on without the trips: it is approved in Agent orders.
  assert.equal((await orders.transition(fx.storeId, orderId, "CONFIRMED")).ok, false, "Receive in Orders never took the rice");
  assert.equal((await orders.sendForDelivery(fx.storeId, orderId)).ok, false);

  // Approved: the rice goes on the trips, so the order can no longer be changed here.
  const ok = await agent.approve(fx.storeId, fx.owner, orderId, {});
  assert.ok(ok.ok, JSON.stringify(ok));
  const late = await orders.replaceOrderItems(fx.storeId, orderId, [{ productId: fx.kilo.id, quantity: 1_000 }], fx.owner.userId, "OWNER");
  assert.equal(late.ok, false);
  assert.equal(await fx.chainOk(fx.kilo.id), "ok");
});

test("Change items on a held POS sale with kilo rice: the grams follow the shelf, and a sack line stays under 999", async () => {
  const fx = await fixture();
  // A POS hold took 2 kg off the shelf.
  const { PosService } = await import("../pos/pos.service.js");
  const { LoyaltyService } = await import("../loyalty/loyalty.service.js");
  const pos = new PosService(new LoyaltyService());
  const who = { userId: fx.owner.userId, role: "OWNER", homeLocationId: null } as never;
  const held = await pos.createPreOrder(fx.storeId, who, { customerId: fx.sc.id, items: [{ productId: fx.sack.id, quantity: 1 }], idempotencyKey: key(), locationId: fx.s1.id });
  assert.ok(held.ok, JSON.stringify(held));
  const orders = new OrderAdminService();
  const r = await orders.replaceOrderItems(fx.storeId, held.value.orderId, [{ productId: fx.sack.id, quantity: 1 }, { productId: fx.kilo.id, quantity: 2_500 }], fx.owner.userId, "OWNER");
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.totalMinor, 135_000 + 14_000);
  assert.equal(await fx.onShelf(fx.kilo.id), 17_500);
  assert.equal(await fx.onShelf(fx.sack.id), 9);
  const tooMany = await orders.replaceOrderItems(fx.storeId, held.value.orderId, [{ productId: fx.sack.id, quantity: 1_000 }], fx.owner.userId, "OWNER");
  assert.equal(tooMany.ok, false);
  assert.equal(await fx.chainOk(fx.kilo.id), "ok");
});

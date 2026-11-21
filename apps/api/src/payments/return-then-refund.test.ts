// Inventory audit 2026-11-21: a customer brings back part of a sale with Returns, then the owner refunds
// the whole sale. The returned rice already came back (good) or was put aside (damaged), so the refund
// must not put it on the shelf a second time.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { PaymentsService } from "./payments.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import { clearStoreActivity } from "../admin/clear-store-activity.js";
import bcrypt from "bcryptjs";
import { PeopleService, type Actor } from "../people/people.service.js";

const run = `retref${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const sig = [{ signerKind: "STAFF", imagePng: PNG }];
const storeIds: string[] = [];
const userIds: string[] = [];

after(async () => {
  for (const storeId of storeIds) {
    await clearStoreActivity(storeId, { apply: true });
    const where = { storeId };
    await prisma.auditLog.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.delete({ where: { id: storeId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("2 sacks sold, 1 brought back with Returns, then the whole sale refunded: only the other sack goes back on the shelf", async () => {
  const store = await prisma.store.create({ data: { slug: run, name: "Return then refund" } });
  storeIds.push(store.id);
  const storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const sack = await prisma.product.create({ data: { storeId, sku: `${run}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  await prisma.stockLevel.create({ data: { storeId, productId: sack.id, warehouseId: s1.id, quantityOnHand: 10 } });
  const user = await prisma.user.create({ data: { email: `${run}@ret.test`, passwordHash: "x", name: "Lucy", role: "STORE_OWNER", pinHash: await bcrypt.hash("2468", 4) } });
  userIds.push(user.id);
  await prisma.userStore.create({ data: { userId: user.id, storeId, role: "OWNER" } });
  const owner: Actor = { userId: user.id, role: "OWNER", homeLocationId: null };
  const onShelf = async () => (await prisma.stockLevel.findFirstOrThrow({ where: { storeId, productId: sack.id, warehouseId: s1.id } })).quantityOnHand;
  const sell = async () => {
    const r = await new BentaService().sell(storeId, owner, { idempotencyKey: `tap-${randomBytes(8).toString("hex")}`, locationId: s1.id, lines: [{ productId: sack.id, quantity: 2 }], payment: { method: "cash" } });
    assert.ok(r.ok, JSON.stringify(r));
    return r.value.orderId;
  };
  const flow = new TransferFlowService();
  const pay = new PaymentsService();

  // Good return: the sack is back on the shelf already.
  const a = await sell();
  assert.equal(await onShelf(), 8);
  const ret = await flow.createReturn(storeId, owner, { locationId: s1.id, productId: sack.id, quantity: 1, condition: "GOOD", reason: "one too many", orderId: a, signatures: sig });
  assert.ok(ret.ok);
  assert.equal(await onShelf(), 9);
  assert.ok((await pay.refundOrder(a, storeId, owner.userId, undefined, "customer changed mind")).ok);
  assert.equal(await onShelf(), 10, "back to 10 (it was 11: the returned sack came back twice)");
  // The return still waits in Para sa iyo for "refund the payment". The whole ₱2,600 went back already:
  // approving it now must not give ₱1,300 more.
  const moneyBefore = await prisma.payment.count({ where: { orderId: a, type: "refund" } });
  assert.ok((await new PeopleService().decideApproval(storeId, ret.value.approvalId, owner, { decision: "APPROVE", pin: "2468" })).ok);
  assert.equal(await prisma.payment.count({ where: { orderId: a, type: "refund" } }), moneyBefore, "no second refund for the returned sack");

  // Damaged return: that sack was put aside; refunding the sale must not put it back on the shelf.
  const b = await sell();
  assert.equal(await onShelf(), 8);
  assert.ok((await flow.createReturn(storeId, owner, { locationId: s1.id, productId: sack.id, quantity: 1, condition: "DAMAGED", reason: "wet sack", orderId: b, signatures: sig })).ok);
  assert.equal(await onShelf(), 8);
  assert.ok((await pay.refundOrder(b, storeId, owner.userId, undefined, "refund")).ok);
  assert.equal(await onShelf(), 9, "only the good sack comes back");

  // Nothing returned: the refund puts both back, as before.
  const c = await sell();
  assert.ok((await pay.refundOrder(c, storeId, owner.userId, undefined, "refund")).ok);
  assert.equal(await onShelf(), 9);
});

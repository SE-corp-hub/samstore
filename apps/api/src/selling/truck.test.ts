// Truck delivery, against the real DB: 100 Mango arrive on a supplier order. 7 go to two pre-orders straight
// from the truck (one of them was taken at Store 2), the rest to the shelves. Every sack ends up in one place,
// the shelves are right, the supplier order is filled, and a truck that does not add up is refused.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { clearStoreActivity } from "../admin/clear-store-activity.js";
import { TruckService } from "./truck.service.js";
import type { Actor, SignatureInput } from "../people/people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const sig: SignatureInput[] = [{ signerKind: "STAFF", imagePng: PNG }];
const run = `trk${Date.now()}${Math.floor(Math.random() * 1000)}`;
const key = () => `tap-${randomBytes(8).toString("hex")}`;
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
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
    await prisma.supplier.deleteMany({ where });
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
  const store = await prisma.store.create({ data: { slug: `${run}-${n}`, name: "Truck" } });
  storeIds.push(store.id);
  const storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const wh = await prisma.warehouse.create({ data: { storeId, name: "Bodega", code: "WH", type: "WAREHOUSE" } });
  const mango = await prisma.product.create({ data: { storeId, sku: `${run}-M25-${n}`, name: "Mango 25kg", priceMinor: 112_000, costMinor: 100_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${n}-${name}@truck.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  const owner = await mk("owner", "OWNER", null);
  const staff = await mk("staff", "STAFF", s1.id);
  const cust = async (name: string) => {
    const c = await prisma.customer.create({ data: { name } });
    customerIds.push(c.id);
    return prisma.storeCustomer.create({ data: { storeId, customerId: c.id, creditApproved: true, creditUnlimited: true } });
  };
  const supplier = await prisma.supplier.create({ data: { storeId, name: "Mill" } });
  const po = await prisma.purchaseOrder.create({
    data: { storeId, docNumber: "PO-000001", supplierId: supplier.id, supplierName: "Mill", locationId: wh.id, status: "OPEN", createdById: owner.userId, lines: { create: [{ storeId, productId: mango.id, quantity: 100, unitCostMinor: 100_000 }] } },
    include: { lines: true },
  });
  const onHand = async (w: string) => (await prisma.stockLevel.findFirst({ where: { storeId, productId: mango.id, warehouseId: w } }))?.quantityOnHand ?? 0;
  return { storeId, s1, s2, wh, mango, owner, staff, cust, po, onHand };
}

test("a truck of 100: 7 to pre-orders from the truck, 93 to shelves; every sack in one place", async () => {
  const fx = await fixture();
  const pos = new PosService(new LoyaltyService());
  const who = { userId: fx.owner.userId, role: "OWNER", homeLocationId: null } as never;
  const nena = await fx.cust("Aling Nena");
  const ben = await fx.cust("Kuya Ben");
  // Taken before the truck: the shelves had none, so they went below zero.
  const p1 = await pos.createPreOrder(fx.storeId, who, { customerId: nena.id, items: [{ productId: fx.mango.id, quantity: 5 }], idempotencyKey: key(), locationId: fx.s1.id });
  const p2 = await pos.createPreOrder(fx.storeId, who, { customerId: ben.id, items: [{ productId: fx.mango.id, quantity: 2 }], idempotencyKey: key(), locationId: fx.s2.id });
  assert.ok(p1.ok && p2.ok, msg(p1) + msg(p2));
  assert.equal(await fx.onHand(fx.s1.id), -5);
  assert.equal(await fx.onHand(fx.s2.id), -2);

  const trucks = new TruckService();
  const base = { locationId: fx.s1.id, unloadLocationId: fx.wh.id, purchaseOrderId: fx.po.id, preorders: [p1.value.orderId, p2.value.orderId], signatures: sig };
  // Does not add up: 3 still on the truck.
  const short = await trucks.finish(fx.storeId, fx.owner, { ...base, lines: [{ productId: fx.mango.id, good: 98, damaged: 2 }], shelves: [{ locationId: fx.wh.id, productId: fx.mango.id, quantity: 80 }, { locationId: fx.s2.id, productId: fx.mango.id, quantity: 8 }] });
  assert.equal(short.ok, false);
  assert.match(msg(short), /3 still on the truck/);
  // Counter staff cannot do a truck.
  assert.equal((await trucks.finish(fx.storeId, fx.staff, { ...base, lines: [{ productId: fx.mango.id, good: 98 }] })).ok, false);

  const done = await trucks.finish(fx.storeId, fx.owner, { ...base, lines: [{ productId: fx.mango.id, good: 98, damaged: 2 }], shelves: [{ locationId: fx.wh.id, productId: fx.mango.id, quantity: 80 }, { locationId: fx.s2.id, productId: fx.mango.id, quantity: 8 }, { locationId: fx.s1.id, productId: fx.mango.id, quantity: 3 }] });
  assert.equal(done.ok, true, msg(done));
  if (!done.ok) return;
  assert.match(done.value.docNumber, /^TRK-/);
  // Shelves: Store 1 had −5 for Nena; Ben's order moved to Store 1 (Store 2 back to 0, Store 1 −7), then +7 for the
  // customers and +3 for its shelf. Store 2 +8, Bodega +80.
  assert.equal(await fx.onHand(fx.s1.id), 3);
  assert.equal(await fx.onHand(fx.s2.id), 8);
  assert.equal(await fx.onHand(fx.wh.id), 80);
  // Both pre-orders are now Store 1's, still waiting to be paid.
  const orders = await prisma.order.findMany({ where: { id: { in: [p1.value.orderId, p2.value.orderId] } }, select: { sellingLocationId: true, status: true } });
  assert.deepEqual(orders.map((o) => [o.sellingLocationId, o.status]), [[fx.s1.id, "ON_HOLD"], [fx.s1.id, "ON_HOLD"]]);
  // The supplier order: 98 good received (the 2 damaged are not paid), one Stock in per store, all tagged.
  const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { orderId: fx.po.id } });
  assert.equal(line.receivedQty, 98);
  const ins = await prisma.stockIn.findMany({ where: { storeId: fx.storeId, truckId: done.value.id }, include: { lines: true } });
  assert.equal(ins.length, 3);
  assert.equal(ins.reduce((a, d) => a + d.lines.reduce((b, l) => b + l.quantity, 0), 0), 98);
  const sum = done.value.summary;
  assert.equal(sum.lines[0]!.toCustomers, 7);
  assert.equal(sum.lines[0]!.damaged, 2);
  assert.equal(sum.preorders.find((p) => p.orderId === p2.value.orderId)?.fromName, "Bahay Tindahan");
  assert.equal((await trucks.list(fx.storeId, fx.owner)).ok, true);

  // The handed-out pre-order is paid the usual way, at Store 1.
  const paid = await pos.finalizePreorder(fx.storeId, who, p1.value.orderId, { paymentMethod: "cash", tenderedMinor: 560_000 } as never);
  assert.equal(paid.ok, true, msg(paid));
  assert.equal(await fx.onHand(fx.s1.id), 3, "paying takes no more rice");
});

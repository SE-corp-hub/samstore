// The old drawer rule ("Open the cash drawer before taking cash", Z-read off) is about CASH only,
// and each store looks at its own drawer:
//   * GCash / bank at a store with no open drawer: sold (it used to be refused with a cash message,
//     and the POS showed no way to open the drawer for GCash);
//   * cash, or a split with cash: refused until a drawer is open;
//   * another store's open day is not this store's drawer.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "./benta.service.js";
import { RegisterService } from "../registers/register.service.js";
import type { Actor } from "../people/people.service.js";

const run = `drw${Date.now()}${Math.floor(Math.random() * 1000)}`;
let storeId = "";
const userIds: string[] = [];

after(async () => {
  if (storeId) {
    const where = { storeId };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    if (orderIds.length) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.cashMovement.deleteMany({ where });
    await prisma.registerSession.deleteMany({ where });
    await prisma.register.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const key = () => `tap-${randomBytes(8).toString("hex")}`;
const why = (r: { ok: boolean; error?: unknown }) => JSON.stringify((r as { error?: unknown }).error ?? "");

test("drawer rule: cash only, and each store's own drawer", async () => {
  const store = await prisma.store.create({ data: { slug: run, name: "Drawer rule" } });
  storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: true, dayOpenClose: false } });
  const bogs = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true, dayOpenClose: true } });
  const lipa = await prisma.warehouse.create({ data: { storeId, name: "Lipa", code: "S3", type: "STORE" } });
  const rice = await prisma.product.create({ data: { storeId, sku: `${run}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" } });
  await prisma.stockLevel.createMany({ data: [bogs.id, lipa.id].map((warehouseId) => ({ storeId, productId: rice.id, warehouseId, quantityOnHand: 50 })) });
  const u = await prisma.user.create({ data: { email: `${run}@drw.test`, passwordHash: "x", name: "Owner", role: "STORE_OWNER" } });
  userIds.push(u.id);
  await prisma.userStore.create({ data: { userId: u.id, storeId, role: "OWNER" } });
  const owner: Actor = { userId: u.id, role: "OWNER", homeLocationId: null };
  const counter = new BentaService();
  const sell = (payment: Record<string, unknown>) => counter.sell(storeId, owner, { idempotencyKey: key(), locationId: lipa.id, lines: [{ productId: rice.id, quantity: 1 }], payment } as never);

  // Bogs and Lucy has its day open (Z-read on there); Lipa uses the old drawer rule and has none open.
  const reg = await prisma.register.create({ data: { storeId, locationId: bogs.id, name: "Bogs and Lucy drawer" } });
  await prisma.registerSession.create({ data: { storeId, registerId: reg.id, locationId: bogs.id, openedBy: u.id, openingFloatMinor: 0 } });

  const gcash = await sell({ method: "gcash", reference: "G-1" });
  assert.ok(gcash.ok, `GCash needs no cash drawer: ${why(gcash)}`);
  const bank = await sell({ method: "bank", reference: "B-1" });
  assert.ok(bank.ok, `bank needs no cash drawer: ${why(bank)}`);
  const cash = await sell({ method: "cash", tenderedMinor: 130_000 });
  assert.equal(cash.ok, false, "cash at Lipa: Bogs and Lucy's open day is not Lipa's drawer");
  assert.match(why(cash), /cash drawer/);
  const split = await sell({ method: "split", tenders: [{ method: "cash", amountMinor: 30_000, tenderedMinor: 30_000 }, { method: "gcash", amountMinor: 100_000, reference: "G-2" }] });
  assert.equal(split.ok, false, "a split with cash needs the drawer too");
  assert.equal(await new RegisterService().currentSessionAt(storeId, lipa.id), null, "the POS drawer check agrees: Lipa shows Open the cash drawer");

  // Lipa opens the drawer: cash sells, and is tied to that drawer.
  const opened = await new RegisterService().openSession(storeId, u.id, { openingFloatMinor: 0 });
  assert.ok(opened.ok);
  const cash2 = await sell({ method: "cash", tenderedMinor: 130_000 });
  assert.ok(cash2.ok, why(cash2));
  const order = await prisma.order.findFirstOrThrow({ where: { storeId, orderNumber: cash2.ok ? cash2.value.orderNumber : "" } });
  assert.equal(order.registerSessionId, opened.ok ? opened.value.sessionId : "");
});

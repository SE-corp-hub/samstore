// Bug hunt 2026-11-21: rice brought back with Returns never came off the sales or the profit. The
// customer got ₱1,300 back (or ₱1,300 off the credit), the cash book gave it back, but the daily report,
// Store report, Compare stores and Reports → Profit still showed the sack as sold.
// Rule 7 of the sales book: an approved return comes off on the day it was approved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import { RiceReportsService } from "./rice-reports.service.js";
import { ReportsService } from "./reports.service.js";
import { clearStoreActivity } from "../admin/clear-store-activity.js";
import { PeopleService, type Actor } from "../people/people.service.js";
import { dayRange, manilaDate } from "../domain/reports.js";
import "../utang/utang.service.js"; // registers the REFUND approval handler (the money back)

const run = `retrep${Date.now()}${Math.floor(Math.random() * 1000)}`;
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

test("returned rice comes off the sales and the profit once the owner approves the money back", async () => {
  const store = await prisma.store.create({ data: { slug: run, name: "Returns in reports" } });
  storeIds.push(store.id);
  const storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const sack = await prisma.product.create({ data: { storeId, sku: `${run}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  await prisma.stockLevel.create({ data: { storeId, productId: sack.id, warehouseId: s1.id, quantityOnHand: 50 } });
  const user = await prisma.user.create({ data: { email: `${run}@ret.test`, passwordHash: "x", name: "Lucy", role: "STORE_OWNER", pinHash: await bcrypt.hash("2468", 4) } });
  userIds.push(user.id);
  await prisma.userStore.create({ data: { userId: user.id, storeId, role: "OWNER" } });
  const owner: Actor = { userId: user.id, role: "OWNER", homeLocationId: null };
  const flow = new TransferFlowService();
  const people = new PeopleService();
  const today = manilaDate(new Date());

  const sell = async () => {
    const r = await new BentaService().sell(storeId, owner, { idempotencyKey: `tap-${randomBytes(8).toString("hex")}`, locationId: s1.id, lines: [{ productId: sack.id, quantity: 2 }], payment: { method: "cash" } });
    assert.ok(r.ok, JSON.stringify(r));
    return r.value.orderId;
  };
  const giveBack = async (orderId: string, condition: "GOOD" | "DAMAGED", approve = true) => {
    const r = await flow.createReturn(storeId, owner, { locationId: s1.id, productId: sack.id, quantity: 1, condition, reason: "brought back", orderId, signatures: sig });
    assert.ok(r.ok, JSON.stringify(r));
    if (approve) assert.ok((await people.decideApproval(storeId, r.value.approvalId, owner, { decision: "APPROVE", pin: "2468" })).ok);
  };
  const day = async () => {
    const r = await new RiceReportsService().daily(storeId, owner, { date: today });
    assert.ok(r.ok, JSON.stringify(r));
    return r.value.sections.find((s) => s.location.id === s1.id)!.sales;
  };

  // 2 sacks sold, 1 good sack brought back: 1 sack sold, its cost only.
  const a = await sell();
  await giveBack(a, "GOOD");
  let d = await day();
  assert.deepEqual([d.count, d.totalMinor, d.cashMinor, d.costMinor], [1, 130_000, 130_000, 115_000], "the good sack that came back is off the sales and its cost is off too");
  assert.deepEqual(d.takenBack, { count: 1, totalMinor: 130_000 });

  // 2 more sold, 1 damaged sack brought back: the money comes off, the damaged sack's cost stays (a loss).
  const b = await sell();
  await giveBack(b, "DAMAGED");
  d = await day();
  assert.deepEqual([d.count, d.totalMinor, d.costMinor], [2, 260_000, 115_000 * 3], "the damaged sack's ₱1,150 stays in the cost");

  // A return still waiting in Para sa iyo gave no money back yet: nothing comes off.
  const c = await sell();
  await giveBack(c, "GOOD", false);
  d = await day();
  assert.deepEqual([d.count, d.totalMinor], [3, 520_000]);

  // A sale with a return, then refunded whole: the whole sale comes off once (not the return again).
  await new PaymentsService().refundOrder(a, storeId, owner.userId, undefined, "customer changed mind");
  d = await day();
  assert.deepEqual([d.count, d.totalMinor, d.cashMinor], [2, 390_000, 390_000]);

  // Reports → Profit reads the same book.
  const { from, to } = dayRange(today);
  const p = await new ReportsService().profitSummary(storeId, from, new Date(to.getTime() - 1));
  assert.equal(p.netRevenueMinor, 390_000);
});

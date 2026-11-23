// Open day + Close day (Z-read) on POS, against the real DB.
//   * switch off: selling works as before, with no day;
//   * switch on: no sale before Open day; X-read and Z-read add up (change fund + cash, GCash);
//   * a count that does not match needs a reason; bills and coins must add up;
//   * after the close the store cannot sell or open again; a sale that waited offline still goes in,
//     and its cash lands after the close (the Z-read never moves);
//   * only the owner reopens; the next close is Z-0002; the old close path is closed while the switch is on;
//   * an offline cash sale keeps its sale time in the cash book (switch on or off).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { RiceReportsService } from "./rice-reports.service.js";
import { DayCloseService } from "./day-close.service.js";
import { CashService } from "../cash/cash.service.js";
import { ExpensesService } from "../expenses/expenses.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { manilaDate } from "../domain/reports.js";
import { PeopleService, type Actor } from "../people/people.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import bcrypt from "bcryptjs";
import "../utang/utang.service.js"; // registers the REFUND approval handler (the money back)

const run = `zrd${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const SIG = [{ signerKind: "STAFF", imagePng: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==" }];

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.dailyClose.deleteMany({ where });
    if (orderIds.length) {
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.cashMovement.deleteMany({ where });
    await prisma.cashHandover.deleteMany({ where });
    await prisma.cashIn.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.stockReturn.deleteMany({ where });
    await prisma.expense.deleteMany({ where });
    await prisma.registerSession.deleteMany({ where });
    await prisma.register.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const must = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
const why = (r: { ok: boolean; error?: unknown }) => JSON.stringify((r as { error?: unknown }).error ?? "");
const key = () => `tap-${randomBytes(8).toString("hex")}`;
let seq = 0;

async function fixture(dayOpenClose: boolean) {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`, name: `Z ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false, dayOpenClose } });
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const bt = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const rice = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" } });
  await prisma.stockLevel.createMany({ data: [main.id, bt.id].map((warehouseId) => ({ storeId: store.id, productId: rice.id, warehouseId, quantityOnHand: 50 })) });
  const person = async (name: string, role: "OWNER" | "STAFF", homeLocationId: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@zrd.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId } });
    return { userId: u.id, role, homeLocationId };
  };
  return { storeId: store.id, main: main.id, bt: bt.id, rice: rice.id, owner: await person("owner", "OWNER", null), staff: await person("lucy", "STAFF", main.id) };
}

test("Open day, X-read, Z-read, after the close, reopen", async () => {
  const counter = new BentaService();
  const day = new DayCloseService();
  const reports = new RiceReportsService();
  const fx = await fixture(true);
  const today = manilaDate(new Date());
  const sell = (method: "cash" | "gcash", extra: Record<string, unknown> = {}) =>
    counter.sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: fx.rice, quantity: 1 }], payment: { method, ...(method === "gcash" ? { reference: `G${randomBytes(4).toString("hex")}` } : {}) }, ...extra } as never);

  // Not open yet: no sale of any kind.
  const early = await sell("gcash");
  assert.equal(early.ok, false);
  assert.match(why(early), /not open yet/);
  const st0 = must(await day.status(fx.storeId, fx.staff, {}));
  assert.equal(st0.on, true);
  assert.equal(st0.open, null);

  // Open with a ₱1,000 change fund (twice is fine: the second is a no-op).
  must(await day.open(fx.storeId, fx.staff, { openingFloatMinor: 100_000 }));
  const st1 = must(await day.open(fx.storeId, fx.staff, { openingFloatMinor: 100_000 }));
  assert.equal(st1.open?.floatMinor, 100_000);
  assert.equal(st1.open?.businessDate, today);
  // The other store is still not open.
  const btSale = await counter.sell(fx.storeId, fx.owner, { idempotencyKey: key(), locationId: fx.bt, lines: [{ productId: fx.rice, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(btSale.ok, false, "opening Bogs and Lucy does not open Bahay Tindahan");

  must(await sell("cash"));
  must(await sell("gcash"));
  const x = must(await day.xread(fx.storeId, fx.staff, {}));
  assert.equal(x.sales.count, 2);
  assert.equal(x.sales.netMinor, 260_000);
  assert.equal(x.cash.floatMinor, 100_000);
  assert.equal(x.cash.shouldBeMinor, 230_000, "change fund + cash sales");
  assert.equal(x.gcash.shouldBeMinor, 130_000);

  // The old close path is closed while the switch is on.
  const old = await reports.close(fx.storeId, fx.staff, { cashCountedMinor: 130_000, signatures: SIG });
  assert.equal(old.ok, false);

  // Short by ₱100 with no reason: refused. Bills that do not add up: refused.
  const short = await day.close(fx.storeId, fx.staff, { cashCountedMinor: 220_000, gcashCountedMinor: 130_000, signatures: SIG });
  assert.equal(short.ok, false);
  assert.match(why(short), /choose why/);
  const badSum = await day.close(fx.storeId, fx.staff, { cashCounts: { "100000": 2 }, cashCountedMinor: 230_000, gcashCountedMinor: 130_000, signatures: SIG });
  assert.equal(badSum.ok, false);

  // Exact, bill by bill: 2 × ₱1,000 + 3 × ₱100.
  const z = must(await day.close(fx.storeId, fx.staff, { cashCounts: { "100000": 2, "10000": 3 }, gcashCountedMinor: 130_000, keepFloatMinor: 100_000, signatures: SIG }));
  assert.equal(z.zNumber, 1);
  assert.equal(z.cash.countedMinor, 230_000);
  assert.equal(z.cash.differenceMinor, 0);
  assert.equal(z.gcash.differenceMinor, 0);
  const dc = await prisma.dailyClose.findFirstOrThrow({ where: { storeId: fx.storeId, locationId: fx.main, businessDate: today } });
  assert.equal(dc.cashCountedMinor, 130_000, "older reports keep counting without the change fund");
  assert.equal(dc.cashVarianceMinor, 0);

  // Closed: no live sale, no second open; the next Open day suggests the change fund kept.
  const late = await sell("cash");
  assert.equal(late.ok, false);
  assert.match(why(late), /closed for today/);
  assert.equal((await day.open(fx.storeId, fx.staff, { openingFloatMinor: 0 })).ok, false);
  assert.equal(must(await day.status(fx.storeId, fx.staff, {})).suggestFloatMinor, 100_000);

  // A sale that waited offline (made 10 minutes ago) still goes in; its cash counts after the close.
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const off = must(await sell("cash", { soldAt: tenMinAgo }));
  const offPay = await prisma.payment.findFirstOrThrow({ where: { storeId: fx.storeId, order: { orderNumber: off.orderNumber } } });
  assert.ok(offPay.receivedAt.getTime() > new Date(z.closedAt!).getTime(), "cash of a closed day lands after the close");
  const frozen = must(await day.one(fx.storeId, fx.staff, (await prisma.registerSession.findFirstOrThrow({ where: { storeId: fx.storeId, zNumber: 1 } })).id));
  assert.equal(frozen.cash.shouldBeMinor, 230_000, "the Z-read never moves");

  // Reopen: staff no, owner yes (with a reason); then sell and close again as Z-0002.
  const zId = (await prisma.registerSession.findFirstOrThrow({ where: { storeId: fx.storeId, zNumber: 1 } })).id;
  assert.equal((await day.reopen(fx.storeId, fx.staff, { id: zId, reason: "forgot a sale" })).ok, false);
  assert.equal((await day.reopen(fx.storeId, fx.owner, { id: zId })).ok, false, "a reason is needed");
  must(await day.reopen(fx.storeId, fx.owner, { id: zId, reason: "forgot a sale" }));
  assert.equal(await prisma.dailyClose.count({ where: { storeId: fx.storeId, locationId: fx.main, businessDate: today } }), 0);
  must(await sell("cash"));
  const x2 = must(await day.xread(fx.storeId, fx.staff, {}));
  assert.equal(x2.cash.shouldBeMinor, 100_000 + 130_000 * 3, "change fund + 3 cash sales of the day");
  const z2 = must(await day.close(fx.storeId, fx.staff, { cashCountedMinor: x2.cash.shouldBeMinor - 5_000, gcashCountedMinor: 130_000, varianceReason: "Wrong change given", signatures: SIG }));
  assert.equal(z2.zNumber, 2);
  assert.equal(z2.cash.differenceMinor, -5_000);
  assert.equal(z2.varianceReason, "Wrong change given");

  const list = must(await day.list(fx.storeId, fx.owner, {}));
  assert.deepEqual(list.zreads.map((r) => [r.zNumber, r.reopened]), [[2, false], [1, true]]);
  const reread = must(await day.one(fx.storeId, fx.owner, zId));
  assert.equal(reread.reopened?.reason, "forgot a sale");
});

test("switch off: sell with no day; an offline cash sale keeps its sale time in the cash book", async () => {
  const counter = new BentaService();
  const day = new DayCloseService();
  const fx = await fixture(false);
  must(await counter.sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: fx.rice, quantity: 1 }], payment: { method: "cash" } }));
  assert.equal((await day.open(fx.storeId, fx.staff, { openingFloatMinor: 0 })).ok, false, "Open day is off");
  const soldAt = new Date(Date.now() - 2 * 3_600_000);
  // Only when the sale's Manila day is still today (else the test would cross midnight).
  if (manilaDate(soldAt) === manilaDate(new Date())) {
    const off = must(await counter.sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: fx.rice, quantity: 1 }], payment: { method: "cash" }, soldAt: soldAt.toISOString() } as never));
    const pay = await prisma.payment.findFirstOrThrow({ where: { storeId: fx.storeId, order: { orderNumber: off.orderNumber } } });
    assert.equal(pay.receivedAt.getTime(), soldAt.getTime());
  }
});

test("The owner sells at a store and keeps the cash: the drawer does not expect it; the Z-read lists it", async () => {
  const counter = new BentaService();
  const day = new DayCloseService();
  const fx = await fixture(true);
  must(await day.open(fx.storeId, fx.owner, { locationId: fx.bt, openingFloatMinor: 50_000 }));
  const ownerSell = (cashToOwner: boolean) => counter.sell(fx.storeId, fx.owner, { idempotencyKey: key(), locationId: fx.bt, lines: [{ productId: fx.rice, quantity: 1 }], payment: { method: "cash" }, cashToOwner } as never);
  const kept = must(await ownerSell(true));
  must(await ownerSell(false));
  // Staff asking for it is ignored (only the owner may keep a sale's cash).
  must(await day.open(fx.storeId, fx.staff, { openingFloatMinor: 0 }));
  must(await counter.sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: fx.rice, quantity: 1 }], payment: { method: "cash" }, cashToOwner: true } as never));
  const s1 = must(await day.xread(fx.storeId, fx.staff, {}));
  assert.equal(s1.cash.shouldBeMinor, 130_000, "staff cannot send the cash to the owner");
  assert.equal(s1.cash.ownerKeptMinor, 0);

  const x = must(await day.xread(fx.storeId, fx.owner, { locationId: fx.bt }));
  assert.equal(x.sales.count, 2);
  assert.equal(x.sales.cashMinor, 260_000, "both sales are Bahay Tindahan's sales");
  assert.equal(x.cash.ownerKeptMinor, 130_000);
  assert.equal(x.cash.shouldBeMinor, 50_000 + 130_000, "change fund + only the cash that went in the drawer");
  assert.equal(x.ownerSales?.length, 2);
  assert.equal(x.ownerSales?.find((o) => o.orderNumber === kept.orderNumber)?.ownerKeptMinor, 130_000);
  const z = must(await day.close(fx.storeId, fx.owner, { locationId: fx.bt, cashCountedMinor: 180_000, gcashCountedMinor: 0, signatures: SIG }));
  assert.equal(z.cash.differenceMinor, 0, "balances with the owner's cash out of the drawer");
  assert.equal(z.ownerSales?.length, 2, "frozen on the Z-read");
});

test("each store has its own Open day switch (This store in Settings)", async () => {
  const counter = new BentaService();
  const day = new DayCloseService();
  // The business switch is off; only Bahay Tindahan turns its own on.
  const fx = await fixture(false);
  await prisma.warehouse.update({ where: { id: fx.bt }, data: { dayOpenClose: true } });
  const sellAt = (locationId: string) => counter.sell(fx.storeId, fx.owner, { idempotencyKey: key(), locationId, lines: [{ productId: fx.rice, quantity: 1 }], payment: { method: "cash" } });

  must(await sellAt(fx.main)); // Bogs and Lucy: off, sells as before
  const bt = await sellAt(fx.bt);
  assert.equal(bt.ok, false, "Bahay Tindahan needs Open day");
  assert.match(why(bt), /not open yet/);

  const all = must(await day.status(fx.storeId, fx.owner, {}));
  assert.equal(all.on, true, "on at some store");
  assert.deepEqual(all.onAt.map((p) => p.id), [fx.bt]);
  assert.equal(must(await day.status(fx.storeId, fx.owner, { locationId: fx.main })).on, false);
  assert.equal(must(await day.status(fx.storeId, fx.owner, { locationId: fx.bt })).on, true);
  const openMain = await day.open(fx.storeId, fx.owner, { locationId: fx.main, openingFloatMinor: 0 });
  assert.equal(openMain.ok, false, "no Open day where the switch is off");

  // The other way round: business on, Bogs and Lucy turns its own off.
  await prisma.storeSettings.update({ where: { storeId: fx.storeId }, data: { dayOpenClose: true } });
  await prisma.warehouse.update({ where: { id: fx.main }, data: { dayOpenClose: false } });
  must(await sellAt(fx.main));
  assert.equal((await sellAt(fx.bt)).ok, false);

  // The drawer rule is each store's own too.
  await prisma.warehouse.update({ where: { id: fx.main }, data: { requireOpenShift: true } });
  const noDrawer = await sellAt(fx.main);
  assert.equal(noDrawer.ok, false);
  assert.match(why(noDrawer), /drawer/);
});

test("Sell per kilo: the X-read / Z-read shows the kilos sold today and their pesos", async () => {
  const counter = new BentaService();
  const day = new DayCloseService();
  const fx = await fixture(true);
  await prisma.warehouse.update({ where: { id: fx.main }, data: { sellPerKilo: true } });
  const kilo = await prisma.product.create({ data: { storeId: fx.storeId, sku: `${run}-kg-${seq}`, name: "Sinandomeng · per kilo", priceMinor: 5_600, costMinor: 4_600, stockBaseUnit: "g", stockBaseQuantity: 1, soldByWeight: true, stockConversionFamily: "Bigas", kiloOfId: fx.rice } });
  await prisma.stockLevel.create({ data: { storeId: fx.storeId, productId: kilo.id, warehouseId: fx.main, quantityOnHand: 25_000 } });
  must(await day.open(fx.storeId, fx.staff, { openingFloatMinor: 0 }));
  must(await counter.sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: kilo.id, kilos: "2.5" }, { productId: fx.rice, quantity: 1 }], payment: { method: "cash" } }));
  must(await counter.sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: kilo.id, amountMinor: 10_000 }], payment: { method: "cash" } }));
  const x = must(await day.xread(fx.storeId, fx.staff, {}));
  assert.equal(x.perKilo?.lines, 2);
  assert.equal(x.perKilo?.totalMinor, 14_000 + 10_000, "2.5 kg × ₱56 + ₱100 worth");
  assert.equal(x.perKilo?.grams, 2_500 + Math.floor((10_000 * 1000) / 5_600));
  assert.equal(x.sales.netMinor, 130_000 + 24_000, "already inside the sales");
});

test("Cash in and Expense on POS balance on the Z-read: change fund + cash sales + cash in − expenses", async () => {
  const counter = new BentaService();
  const day = new DayCloseService();
  const fx = await fixture(true);
  must(await day.open(fx.storeId, fx.staff, { openingFloatMinor: 100_000 }));
  must(await counter.sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: fx.rice, quantity: 1 }], payment: { method: "cash" } } as never)); // + 1,300
  must(await new CashService().cashIn(fx.storeId, fx.staff, { amountMinor: 50_000, note: "More change (panukli)" })); //                                       + 500
  must(await new ExpensesService().create(fx.storeId, fx.staff, { category: "supplies", amountMinor: 20_000, note: "plastic bags", paidFromDrawer: true, fromPos: true })); // − 200
  const x = must(await day.xread(fx.storeId, fx.staff, {}));
  assert.equal(x.cash.addedMinor, 50_000);
  assert.equal(x.cash.paidOutMinor, 20_000);
  assert.equal(x.cash.shouldBeMinor, 100_000 + 130_000 + 50_000 - 20_000);
  assert.deepEqual(x.cashAdded?.map((c) => [c.what, c.amountMinor]), [["More change (panukli)", 50_000]]);
  const z = must(await day.close(fx.storeId, fx.staff, { cashCountedMinor: 260_000, gcashCountedMinor: 0, signatures: SIG }));
  assert.equal(z.cash.differenceMinor, 0, "the drawer balances");

  // After the Z-read the drawer is counted: cash typed in or out NOW would be in no Z-read at all.
  const lateIn = await new CashService().cashIn(fx.storeId, fx.staff, { amountMinor: 1_000, note: "More change (panukli)" });
  assert.equal(lateIn.ok, false);
  assert.match(why(lateIn), /closed for today/);
  const lateOut = await new ExpensesService().create(fx.storeId, fx.staff, { category: "supplies", amountMinor: 1_000, note: "plastic bags", paidFromDrawer: true, fromPos: true });
  assert.equal(lateOut.ok, false);
  assert.match(why(lateOut), /closed for today/);
  // An expense NOT from the drawer (the owner paid it) is still fine.
  must(await new ExpensesService().create(fx.storeId, fx.owner, { category: "supplies", amountMinor: 1_000, note: "owner paid", locationId: fx.main, paidFromDrawer: false }));
  // A cash refund of today's sale is refused too, until the owner reopens the day.
  const sale = await prisma.order.findFirstOrThrow({ where: { storeId: fx.storeId, sellingLocationId: fx.main, status: "COMPLETED" } });
  const payments = new PaymentsService();
  const refund = await payments.refundOrder(sale.id, fx.storeId, fx.owner.userId, undefined, "customer came back");
  assert.equal(refund.ok, false);
  assert.match(why(refund), /closed for today/);
  // Cash that waited on the tablet with no signal still goes in (after the close, like an offline sale).
  must(await new CashService().cashIn(fx.storeId, fx.staff, { amountMinor: 1_000, note: "More change (panukli)", at: new Date(Date.now() - 5 * 60_000).toISOString() }));
  const zId = (await prisma.registerSession.findFirstOrThrow({ where: { storeId: fx.storeId, zNumber: 1 } })).id;
  assert.equal(must(await day.one(fx.storeId, fx.owner, zId)).cash.shouldBeMinor, 260_000, "the Z-read never moves");
  // Reopened by the owner: the refund goes through.
  must(await day.reopen(fx.storeId, fx.owner, { id: zId, reason: "customer came back" }));
  must(await payments.refundOrder(sale.id, fx.storeId, fx.owner.userId, undefined, "customer came back"));
});

// 2026-11-23: money back for returned rice approved AFTER the Z-read fell on the closed day, so it was on
// no Z-read at all (only "After closing" on Reports). Now the approval waits: tomorrow, or reopen the day.
test("money back for a return cannot be approved once the store's Z-read is done for today", async () => {
  const fx = await fixture(true);
  const day = new DayCloseService();
  const people = new PeopleService();
  await prisma.user.update({ where: { id: fx.owner.userId }, data: { pinHash: await bcrypt.hash("2468", 4) } });
  must(await day.open(fx.storeId, fx.staff, { openingFloatMinor: 0 }));
  const sale = must(await new BentaService().sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: fx.rice, quantity: 2 }], payment: { method: "cash" } } as never));
  const ret = must(await new TransferFlowService().createReturn(fx.storeId, fx.staff, { locationId: fx.main, productId: fx.rice, quantity: 1, condition: "GOOD", reason: "brought back", orderId: sale.orderId, signatures: SIG }));
  const z = must(await day.close(fx.storeId, fx.staff, { cashCountedMinor: 260_000, gcashCountedMinor: 0, signatures: SIG }));
  assert.equal(z.cash.givenBackMinor, 0);

  const late = await people.decideApproval(fx.storeId, ret.approvalId, fx.owner, { decision: "APPROVE", pin: "2468" });
  assert.equal(late.ok, false);
  assert.match(why(late), /Bogs and Lucy is closed for today \(Z-read done\).*Approve it tomorrow, or reopen the day/);
  assert.equal((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: ret.approvalId } })).status, "PENDING", "it still waits in For your approval");
  assert.equal(await prisma.payment.count({ where: { storeId: fx.storeId, type: "refund" } }), 0, "no money moved");

  // The owner reopens the day: now it can be approved, and the money back is on the next Z-read.
  const zId = (await prisma.registerSession.findFirstOrThrow({ where: { storeId: fx.storeId, zNumber: 1 } })).id;
  must(await day.reopen(fx.storeId, fx.owner, { id: zId, reason: "return to approve" }));
  must(await people.decideApproval(fx.storeId, ret.approvalId, fx.owner, { decision: "APPROVE", pin: "2468" }));
  const x = must(await day.xread(fx.storeId, fx.staff, {}));
  assert.equal(x.cash.givenBackMinor, 130_000);
  assert.equal(x.cash.shouldBeMinor, 130_000);
  assert.deepEqual([x.sales.takenBackCount, x.sales.takenBackMinor, x.sales.netMinor], [1, 130_000, 130_000]);
});

test("declining the money back is allowed after the Z-read; with the switch off nothing is refused", async () => {
  const fx = await fixture(true);
  const day = new DayCloseService();
  const people = new PeopleService();
  await prisma.user.update({ where: { id: fx.owner.userId }, data: { pinHash: await bcrypt.hash("2468", 4) } });
  must(await day.open(fx.storeId, fx.staff, { openingFloatMinor: 0 }));
  const sale = must(await new BentaService().sell(fx.storeId, fx.staff, { idempotencyKey: key(), lines: [{ productId: fx.rice, quantity: 2 }], payment: { method: "cash" } } as never));
  const flow = new TransferFlowService();
  const a = must(await flow.createReturn(fx.storeId, fx.staff, { locationId: fx.main, productId: fx.rice, quantity: 1, condition: "DAMAGED", reason: "brought back", orderId: sale.orderId, signatures: SIG }));
  const b = must(await flow.createReturn(fx.storeId, fx.staff, { locationId: fx.main, productId: fx.rice, quantity: 1, condition: "DAMAGED", reason: "brought back", orderId: sale.orderId, signatures: SIG }));
  must(await day.close(fx.storeId, fx.staff, { cashCountedMinor: 260_000, gcashCountedMinor: 0, signatures: SIG }));
  must(await people.decideApproval(fx.storeId, a.approvalId, fx.owner, { decision: "DECLINE", note: "no money back", pin: "2468" }));
  await prisma.storeSettings.update({ where: { storeId: fx.storeId }, data: { dayOpenClose: false } });
  must(await people.decideApproval(fx.storeId, b.approvalId, fx.owner, { decision: "APPROVE", pin: "2468" }));
});

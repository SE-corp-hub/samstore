// Per-store build, step 1c — one profit calculation for every report, against the real DB.
//   * the daily report, the month report, the stock book, the Store report, Compare stores and
//     the old Reports screen read the same sales book, so their totals agree;
//   * a sale with no store is the main store's sale in all of them;
//   * a sale taken back later stays on the day it was sold and is taken off on the day it was
//     taken back, so a day that has passed never changes;
//   * loose rice costs per kilo, a split sale counts by what each part paid, and an agent order
//     delivered in part counts for what was delivered.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { PaymentsService } from "../payments/payments.service.js";
import { RiceReportsService } from "./rice-reports.service.js";
import { StoreReportService } from "./store-report.service.js";
import { ReportsService } from "./reports.service.js";
import { bookLines, bookTotals, salesBook } from "./sales-book.js";
import { dayRange, manilaDate } from "../domain/reports.js";
import type { Actor } from "../people/people.service.js";

const run = `SBK${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const DAY = 86_400_000;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    if (orderIds.length) {
      await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.paymentStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.expense.deleteMany({ where });
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

/**
 * One business: Bogs and Lucy (main) and Bahay Tindahan (sells the main store's rice).
 * Dinorado 25 kg costs ₱1,150 a sack; loose Sinandomeng costs ₱40 a kilo.
 */
async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Sales book ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const bt = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const sack = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-D25`, name: "Dinorado 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const loose = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-SL`, name: "Sinandomeng (loose)", priceMinor: 5_000, costMinor: 4_000, stockBaseUnit: "g", stockBaseQuantity: 1 } });
  await prisma.stockLevel.createMany({ data: [main.id, bt.id].flatMap((w) => [{ storeId: store.id, productId: sack.id, warehouseId: w, quantityOnHand: 50 }, { storeId: store.id, productId: loose.id, warehouseId: w, quantityOnHand: 100_000 }]) });
  const u = await prisma.user.create({ data: { email: `${run}-${seq}-owner@sbk.test`, passwordHash: "x", name: "owner", role: "STORE_OWNER" } });
  userIds.push(u.id);
  await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role: "OWNER", homeLocationId: null } });
  const owner: Actor = { userId: u.id, role: "OWNER", homeLocationId: null };
  return { storeId: store.id, main: main.id, bt: bt.id, sack, loose, owner };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

type Line = { product: Fx["sack"]; soldBy: "PIECE" | "KILO"; quantity: number; unitPriceMinor: number; unitCostMinor: number | null };
let n = 0;
/** A finished sale, written the way the counter leaves it. */
async function sale(fx: Fx, o: { at: Date; locationId: string | null; lines: Line[]; method?: string; source?: string; feeMinor?: number; pays?: { method: string; amountMinor: number }[] }) {
  n += 1;
  const lines = o.lines.map((l) => ({ ...l, lineTotalMinor: l.soldBy === "KILO" ? Math.round((l.quantity * l.unitPriceMinor) / 1000) : l.quantity * l.unitPriceMinor }));
  const subtotal = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const total = subtotal + (o.feeMinor ?? 0);
  const order = await prisma.order.create({
    data: {
      orderNumber: `${run}-${n}`, storeId: fx.storeId, status: "COMPLETED", source: o.source ?? "pos", currencyCode: "PHP", subtotalMinor: subtotal, deliveryFeeMinor: o.feeMinor ?? 0, discountMinor: 0, totalMinor: total,
      snapshot: {}, paymentMethod: o.method ?? "cash", paymentStatus: "COLLECTED", cartToken: `cart-${run}-${n}`, customerName: "Walk-in", customerPhone: "", deliveryAddressLine1: "",
      sellingLocationId: o.locationId, occurredAt: o.at, createdAt: o.at,
      items: { create: lines.map((l) => ({ productId: l.product.id, productName: l.product.name, sku: l.product.sku, unitPriceMinor: l.unitPriceMinor, quantity: l.quantity, lineTotalMinor: l.lineTotalMinor, soldBy: l.soldBy, grams: l.soldBy === "KILO" ? l.quantity : null, unitCostMinor: l.unitCostMinor })) },
    },
  });
  const pays = o.pays ?? (o.method === "credit" ? [] : [{ method: o.method ?? "cash", amountMinor: total }]);
  for (const p of pays) await prisma.payment.create({ data: { orderId: order.id, storeId: fx.storeId, method: p.method, amountMinor: p.amountMinor, type: "payment", status: "paid", locationId: o.locationId, receivedAt: o.at } });
  return { id: order.id, totalMinor: total };
}
const sacks = (fx: Fx, quantity: number, unitPriceMinor = 130_000): Line => ({ product: fx.sack, soldBy: "PIECE", quantity, unitPriceMinor, unitCostMinor: 115_000 });
const kilos = (fx: Fx, grams: number): Line => ({ product: fx.loose, soldBy: "KILO", quantity: grams, unitPriceMinor: 5_000, unitCostMinor: 4_000 });

const daily = async (fx: Fx, date: string) => {
  const r = await new RiceReportsService().daily(fx.storeId, fx.owner, { date });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) throw new Error("daily failed");
  return (id: string) => r.value.sections.find((s) => s.location.id === id)!.sales;
};
const compare = async (fx: Fx, from: string, to: string) => {
  const r = await new StoreReportService().compare(fx.storeId, fx.owner, { from, to });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) throw new Error("compare failed");
  return r.value;
};
/** The old Reports screen for whole Manila days. */
const oldReports = (fx: Fx, from: string, to: string) => new ReportsService().profitSummary(fx.storeId, dayRange(from).from, new Date(dayRange(to).to.getTime() - 1));

test("every report reads the same sales: old Reports, Compare stores, the daily and the month report agree", async () => {
  const fx = await fixture();
  const now = new Date();
  const today = manilaDate(now);
  // Bahay Tindahan: 2 sacks at its own price, cash. Main store: 1 sack by GCash, and 2.5 kilos of loose rice.
  await sale(fx, { at: now, locationId: fx.bt, lines: [sacks(fx, 2, 135_000)] });
  await sale(fx, { at: now, locationId: fx.main, lines: [sacks(fx, 1)], method: "gcash" });
  await sale(fx, { at: now, locationId: fx.main, lines: [kilos(fx, 2_500)] });
  // An old order that names no store: it is the main store's sale. Its line has no saved cost, so today's cost is used.
  await sale(fx, { at: now, locationId: null, lines: [{ ...sacks(fx, 1), unitCostMinor: null }], source: "online", method: "cod", feeMinor: 5_000 });
  // A split sale at the main store: ₱800 cash and ₱500 GCash.
  await sale(fx, { at: now, locationId: fx.main, lines: [sacks(fx, 1)], method: "split", pays: [{ method: "cash", amountMinor: 80_000 }, { method: "gcash", amountMinor: 50_000 }] });

  const salesMain = 130_000 + 12_500 + 135_000 + 130_000;
  const costMain = 115_000 + 10_000 + 115_000 + 115_000;
  const day = await daily(fx, today);
  assert.deepEqual([day(fx.main).count, day(fx.main).totalMinor, day(fx.main).costMinor], [4, salesMain, costMain], "the order with no store is in the main store's day; loose rice costs per kilo");
  assert.deepEqual([day(fx.main).cashMinor, day(fx.main).gcashMinor, day(fx.main).otherMinor], [12_500 + 135_000 + 80_000, 130_000 + 50_000, 0], "a split sale counts by what each part paid");
  assert.deepEqual([day(fx.bt).count, day(fx.bt).totalMinor, day(fx.bt).costMinor], [1, 270_000, 230_000]);

  const cmp = await compare(fx, today, today);
  const row = (id: string) => cmp.stores.find((s) => s.location.id === id)!.sales;
  assert.deepEqual([row(fx.main).totalMinor, row(fx.main).costMinor, row(fx.bt).totalMinor, row(fx.bt).costMinor], [salesMain, costMain, 270_000, 230_000], "Compare stores shows the same as the daily report");

  const old = await oldReports(fx, today, today);
  assert.deepEqual([old.netRevenueMinor, old.cogsMinor, old.ordersCount], [cmp.total.salesMinor, costMain + 230_000, cmp.total.count], "old Reports is the stores added up");
  assert.equal(old.netRevenueMinor - old.cogsMinor, cmp.total.grossProfitMinor, "and so is its profit before expenses");

  const month = await new RiceReportsService().monthly(fx.storeId, fx.owner, today.slice(0, 7));
  assert.equal(month.ok, true, msg(month));
  if (!month.ok) return;
  const loc = (id: string) => month.value.locations.find((l) => l.location.id === id)!;
  assert.deepEqual([loc(fx.main).salesMinor, loc(fx.main).costMinor, loc(fx.main).orders, loc(fx.bt).salesMinor], [salesMain, costMain, 4, 270_000], "the month report too");
  assert.equal(month.value.profit.grossProfitMinor, cmp.total.grossProfitMinor);

  const sold = await new ReportsService().soldStock(fx.storeId, dayRange(today).from, new Date(dayRange(today).to.getTime() - 1));
  assert.deepEqual(sold.rows.map((r) => [r.name, r.sold, r.unit]), [["Dinorado 25 kg", 5, "pcs"], ["Sinandomeng (loose)", 2.5, "kg"]], "loose rice is shown in kilos, not grams");

  const book = await new RiceReportsService().stockBookPage(fx.storeId, fx.owner, { productId: fx.sack.id, from: today, to: today });
  assert.equal(book.ok, true, msg(book));
  if (!book.ok) return;
  const at = (id: string) => book.value.totals.find((t) => t.locationId === id)!;
  assert.deepEqual([at(fx.main).soldQty, at(fx.main).salesMinor, at(fx.main).costOfSoldMinor, at(fx.bt).soldQty], [3, 390_000, 345_000, 2], "the stock book counts the no-store sale at the main store");
});

test("a sale taken back later stays on the day it was sold and comes off on the day it was taken back", async () => {
  const fx = await fixture();
  const now = new Date();
  const today = manilaDate(now);
  const yesterday = manilaDate(new Date(now.getTime() - DAY));
  const sold = await sale(fx, { at: new Date(now.getTime() - DAY), locationId: fx.bt, lines: [sacks(fx, 2, 135_000)] });
  await sale(fx, { at: now, locationId: fx.bt, lines: [sacks(fx, 1, 135_000)] });

  const before = await daily(fx, yesterday);
  assert.deepEqual([before(fx.bt).count, before(fx.bt).totalMinor, before(fx.bt).costMinor], [1, 270_000, 230_000]);

  // The customer brings it back today and gets the money back.
  const back = await new PaymentsService().refundOrder(sold.id, fx.storeId, fx.owner.userId, undefined, "customer returned it");
  assert.equal(back.ok, true, msg(back));

  const y = await daily(fx, yesterday);
  assert.deepEqual([y(fx.bt).count, y(fx.bt).totalMinor, y(fx.bt).costMinor, y(fx.bt).takenBack.count], [1, 270_000, 230_000, 0], "yesterday does not change");
  const t = await daily(fx, today);
  assert.deepEqual([t(fx.bt).count, t(fx.bt).totalMinor, t(fx.bt).costMinor], [1, 135_000 - 270_000, 115_000 - 230_000], "today: one sale, less the sale taken back");
  assert.deepEqual(t(fx.bt).takenBack, { count: 1, totalMinor: 270_000 });

  // Both days together: the sale and its return add up to nothing, in every report.
  const cmp = await compare(fx, yesterday, today);
  const row = cmp.stores.find((s) => s.location.id === fx.bt)!.sales;
  assert.deepEqual([row.count, row.totalMinor, row.costMinor, row.takenBack.count], [1, 135_000, 115_000, 1]);
  const old = await oldReports(fx, yesterday, today);
  assert.deepEqual([old.revenueMinor, old.refundsMinor, old.netRevenueMinor, old.cogsMinor, old.ordersCount], [405_000, 270_000, 135_000, 115_000, 1]);
  assert.equal(old.netRevenueMinor, cmp.total.salesMinor);

  // The Store report day by day shows the same two days.
  const rep = await new StoreReportService().sales(fx.storeId, fx.owner, { locationId: fx.bt, from: yesterday, to: today });
  assert.equal(rep.ok, true, msg(rep));
  if (!rep.ok) return;
  assert.deepEqual(rep.value.days, [{ date: today, count: 1, totalMinor: -135_000 }, { date: yesterday, count: 1, totalMinor: 270_000 }]);
  assert.deepEqual(rep.value.items.map((i) => [i.name, i.quantity, i.salesMinor]), [["Dinorado 25 kg", 1, 135_000]]);
});

test("a sale voided the same day adds up to nothing that day, and an order cancelled before it was sold never counts", async () => {
  const fx = await fixture();
  const now = new Date();
  const today = manilaDate(now);
  const credit = await sale(fx, { at: now, locationId: fx.main, lines: [sacks(fx, 1)], method: "credit" });
  await prisma.order.update({ where: { id: credit.id }, data: { paymentStatus: "PENDING" } });
  const v = await new PaymentsService().voidOrder(credit.id, fx.storeId, fx.owner.userId, "wrong item");
  assert.equal(v.ok, true, msg(v));
  // Cancelled while still waiting: never a sale, so nothing is taken back.
  const waiting = await sale(fx, { at: now, locationId: fx.main, lines: [sacks(fx, 3)] });
  await prisma.order.update({ where: { id: waiting.id }, data: { status: "CANCELLED" } });
  await prisma.orderStatusHistory.create({ data: { orderId: waiting.id, storeId: fx.storeId, fromStatus: "CONFIRMED", toStatus: "CANCELLED", actorType: "staff" } });

  const day = await daily(fx, today);
  assert.deepEqual([day(fx.main).count, day(fx.main).totalMinor, day(fx.main).costMinor, day(fx.main).utangMinor], [0, 0, 0, 0]);
  assert.deepEqual(day(fx.main).takenBack, { count: 1, totalMinor: 130_000 });
  const old = await oldReports(fx, today, today);
  assert.deepEqual([old.netRevenueMinor, old.cogsMinor, old.ordersCount], [0, 0, 0]);
});

test("an agent order delivered in part counts for what was delivered", async () => {
  const fx = await fixture();
  const now = new Date();
  // 5 sacks ordered, 3 delivered and paid: the order's total is what was delivered.
  const o = await sale(fx, { at: now, locationId: fx.bt, lines: [sacks(fx, 5, 135_000)], source: "AGENT" });
  await prisma.order.update({ where: { id: o.id }, data: { totalMinor: 3 * 135_000 } });
  await prisma.stockTransfer.create({ data: { storeId: fx.storeId, fromWarehouseId: fx.main, toWarehouseId: fx.bt, productId: fx.sack.id, quantity: 5, status: "COMPLETED", requestedById: fx.owner.userId, kind: "ORDER_RELEASE", orderId: o.id, releasedQty: 5, deliveredQty: 3, returnedQty: 2 } });

  const range = dayRange(manilaDate(now));
  const book = await salesBook(prisma, fx.storeId, { gte: range.from, lt: range.to }, { locationId: fx.bt });
  const lines = bookLines(book.entries, () => fx.sack);
  assert.deepEqual(lines.map((l) => [l.quantity, l.salesMinor, l.costMinor]), [[3, 405_000, 345_000]]);
  assert.equal(bookTotals(book.entries).totalMinor, 405_000);
  const day = await daily(fx, manilaDate(now));
  assert.deepEqual([day(fx.bt).totalMinor, day(fx.bt).costMinor], [405_000, 345_000], "profit is on 3 sacks, not 5");
});

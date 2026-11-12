// Per-store build, step 10 — one whole day at every store, against the real DB, through the same
// services the screens call. It is the plan in one test:
//   * the owner makes the six ready logins (decision 5) and hands one over;
//   * each store sells from the shared shelf at its own price, with its own order numbers and receipt name;
//   * a store head changes the own store's price, never under the owner's lowest price;
//   * each store has its own expenses, its own cash drawer and its own net profit;
//   * a store login sees only its own store; the head sees its own profit; the owner sees all,
//     and the stores add up to the whole business;
//   * the consignment stores owe the main store the cost of what they sold.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "./benta.service.js";
import { WarehouseService } from "../admin/warehouse.service.js";
import { PeopleService, loadActor, type Actor } from "../people/people.service.js";
import { ExpensesService } from "../expenses/expenses.service.js";
import { CashService } from "../cash/cash.service.js";
import { cashOfDay } from "../cash/cash-book.js";
import { PaymentsService } from "../payments/payments.service.js";
import { RiceReportsService } from "../reports/rice-reports.service.js";
import { StoreReportService } from "../reports/store-report.service.js";
import { bustMemberships } from "../auth/membership-cache.js";
import { orderWall, runWithWall, wallFor } from "../auth/wall.js";
import { manilaDate } from "../domain/reports.js";

const run = `day${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    userIds.push(...(await prisma.userStore.findMany({ where, select: { userId: true } })).map((m) => m.userId));
    await prisma.auditLog.deleteMany({ where });
    await prisma.passwordResetHistory.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.cashHandover.deleteMany({ where });
    await prisma.expense.deleteMany({ where });
    if (orderIds.length) {
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
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
const key = () => `tap-${randomBytes(8).toString("hex")}`;

test("one whole day at Bogs and Lucy, Bahay Tindahan and Lipa", async () => {
  const people = new PeopleService();
  const places = new WarehouseService();
  const counter = new BentaService();
  const expenses = new ExpensesService();
  const cash = new CashService();
  const today = manilaDate(new Date());

  // ── The business: one shared stock, four places ──
  const store = await prisma.store.create({ data: { slug: run, name: "Sam Rice Trading" } });
  const storeId = store.id;
  storeIds.push(storeId);
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false, orderNumberPrefix: "SAM" } });
  const place = (name: string, code: string, extra: object = {}) => prisma.warehouse.create({ data: { storeId, name, code, type: "STORE", ...extra } });
  const main = await place("Bogs and Lucy", "S1", { isDefault: true });
  const bt = await place("Bahay Tindahan", "S2", { consignment: true });
  const lipa = await place("Lipa", "S3", { consignment: true });
  const bodega = await place("Bodega", "WH", { type: "WAREHOUSE" });
  const rice = await prisma.product.create({ data: { storeId, sku: `${run}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" } });
  await prisma.stockLevel.createMany({ data: [[main.id, 20], [bt.id, 10], [lipa.id, 10], [bodega.id, 30]].map(([warehouseId, q]) => ({ storeId, productId: rice.id, warehouseId: warehouseId as string, quantityOnHand: q as number })) });
  const ownerUser = await prisma.user.create({ data: { email: `${run}-owner@day.test`, passwordHash: "x", name: "Lucy", role: "STORE_OWNER" } });
  await prisma.userStore.create({ data: { userId: ownerUser.id, storeId, role: "OWNER" } });
  const owner: Actor = { userId: ownerUser.id, role: "OWNER", homeLocationId: null };
  // Decision 10: where each place may take rice from.
  must(await places.update(storeId, main.id, { sourceLocationIds: [bt.id, bodega.id] }));
  must(await places.update(storeId, bt.id, { sourceLocationIds: [bodega.id] }));
  must(await places.update(storeId, lipa.id, { sourceLocationIds: [] }));

  // ── Decision 5: the six ready logins ──
  const ready = async (label: string, homeLocationId: string, isLocationHead = false) => must(await people.createReadyLogin(storeId, { label, homeLocationId, isLocationHead }, owner.userId)).userId;
  const ids = {
    btHead: await ready("Bahay Tindahan head", bt.id, true), btCounter: await ready("Bahay Tindahan counter", bt.id),
    lipaHead: await ready("Lipa head", lipa.id, true), lipaCounter: await ready("Lipa counter", lipa.id),
    mainCounter: await ready("Bogs and Lucy counter", main.id), bodega: await ready("Bodega", bodega.id),
  };
  assert.equal((await people.listMembers(storeId)).filter((m) => m.readyLabel).length, 6);
  // The Lipa head is known: Maria takes the login over.
  assert.equal(must(await people.handOverLogin(storeId, ids.lipaHead, { name: "Maria Santos" }, owner.userId)).name, "Maria Santos");
  await bustMemberships();
  const as = (userId: string) => loadActor(storeId, userId, "STAFF");
  const [btHead, btCounter, lipaHead, lipaCounter, mainCounter] = await Promise.all([as(ids.btHead), as(ids.btCounter), as(ids.lipaHead), as(ids.lipaCounter), as(ids.mainCounter)]);
  assert.deepEqual([btHead.isHead, btCounter.isHead, lipaHead.isHead, lipaHead.homeLocationId], [true, false, true, lipa.id]);

  // ── Prices: the owner's lowest price, each store's own price ──
  must(await places.setFloorPrice(storeId, rice.id, 128_000, owner.userId)); //                       lowest ₱1,280
  must(await places.setPrice(storeId, bt.id, rice.id, 135_000, owner.userId)); //                     Bahay Tindahan ₱1,350
  assert.equal((await places.setPrice(storeId, lipa.id, rice.id, 125_000, lipaHead.userId, { asHead: true })).ok, false, "the head cannot go under ₱1,280");
  must(await places.setPrice(storeId, lipa.id, rice.id, 132_000, lipaHead.userId, { asHead: true })); // Lipa ₱1,320, set by its head
  // ── What Lipa calls itself ──
  must(await places.update(storeId, lipa.id, { receiptName: "Lipa Rice Store", receiptFooter: "Salamat po!", orderPrefix: "LIPA" }));

  // ── The counter: every store sells at its own price, from its own shelf ──
  const sell = async (actor: Actor, sacks: number, locationId?: string) => counter.sell(storeId, actor, { idempotencyKey: key(), ...(locationId ? { locationId } : {}), lines: [{ productId: rice.id, quantity: sacks }], payment: { method: "cash" } });
  const atMain = must(await sell(mainCounter, 2)); //   2 × ₱1,300 = ₱2,600
  const atBt = must(await sell(btCounter, 3)); //       3 × ₱1,350 = ₱4,050
  const atLipa = must(await sell(lipaCounter, 1)); //   1 × ₱1,320 = ₱1,320
  assert.deepEqual([atMain.totalMinor, atBt.totalMinor, atLipa.totalMinor], [260_000, 405_000, 132_000]);
  assert.match(atLipa.orderNumber, /^LIPA-\d{4}-\d{6}$/, "Lipa's own order numbers");
  assert.match(atBt.orderNumber, /^SAM-\d{4}-\d{6}$/, "the business's start where a store has none");
  assert.equal((await sell(btCounter, 1, lipa.id)).ok, false, "a Bahay Tindahan login cannot sell as Lipa");
  const left = async (warehouseId: string) => (await prisma.stockLevel.findFirstOrThrow({ where: { storeId, productId: rice.id, warehouseId } })).quantityOnHand;
  assert.deepEqual([await left(main.id), await left(bt.id), await left(lipa.id), await left(bodega.id)], [18, 7, 9, 30], "one shared stock, each sale off its own shelf");
  const receipt = (await new PaymentsService().receipt(atLipa.orderId, storeId)) as { storeName: string; receiptFooter: string | null };
  assert.deepEqual([receipt.storeName, receipt.receiptFooter], ["Lipa Rice Store", "Salamat po!"]);

  // ── Expenses and cash, each store its own ──
  must(await expenses.create(storeId, btCounter, { category: "transport", amountMinor: 20_000, paidFromDrawer: true })); // Bahay Tindahan ₱200, from the drawer
  must(await expenses.create(storeId, lipaHead, { category: "supplies", amountMinor: 15_000 })); //                       Lipa ₱150
  must(await expenses.create(storeId, owner, { category: "rent", amountMinor: 100_000, locationId: null })); //            whole business ₱1,000
  must(await cash.handOver(storeId, btCounter, { amountMinor: 200_000, note: "to Lucy at noon" })); //                     Bahay Tindahan hands over ₱2,000
  const drawer = await cashOfDay(prisma, storeId, bt.id, today);
  assert.deepEqual([drawer.inMinor, drawer.paidOutMinor, drawer.handedOverMinor, drawer.expectedMinor], [405_000, 20_000, 200_000, 185_000], "₱4,050 − ₱200 − ₱2,000 = ₱1,850 in Bahay Tindahan's drawer");
  assert.equal((await cashOfDay(prisma, storeId, lipa.id, today)).expectedMinor, 132_000, "Lipa's drawer is its own");

  // ── The owner sees every store, and they add up ──
  const cmp = must(await new StoreReportService().compare(storeId, owner, { from: today, to: today }));
  const row = (id: string) => { const s = cmp.stores.find((x) => x.location.id === id)!; return [s.sales.grossProfitMinor, s.expensesMinor, s.netProfitMinor]; };
  assert.deepEqual(row(main.id), [30_000, 0, 30_000], "Bogs and Lucy: 2 × (₱1,300 − ₱1,150)");
  assert.deepEqual(row(bt.id), [60_000, 20_000, 40_000], "Bahay Tindahan: 3 × (₱1,350 − ₱1,150) − ₱200");
  assert.deepEqual(row(lipa.id), [17_000, 15_000, 2_000], "Lipa: ₱1,320 − ₱1,150 − ₱150");
  assert.deepEqual([cmp.business.expensesMinor, cmp.total.netProfitMinor], [100_000, 30_000 + 40_000 + 2_000 - 100_000]);

  // ── A store login sees its own store only; the head sees its own profit ──
  const reports = new RiceReportsService();
  const headDay = must(await reports.daily(storeId, lipaHead, { date: today }));
  assert.deepEqual([headDay.sections.length, headDay.sections[0]!.location.id, headDay.sections[0]!.sales.grossProfitMinor, (headDay.total as { netProfitMinor?: number }).netProfitMinor], [1, lipa.id, 17_000, 2_000]);
  const counterDay = must(await reports.daily(storeId, lipaCounter, { date: today }));
  assert.deepEqual([counterDay.sections[0]!.sales.totalMinor, counterDay.sections[0]!.sales.grossProfitMinor], [132_000, undefined], "the counter login sees sales, never profit");
  assert.equal((await reports.daily(storeId, lipaHead, { date: today, locationId: bt.id })).ok, false, "not another store's day");
  assert.equal((await new StoreReportService().compare(storeId, lipaHead, { from: today, to: today })).ok, false, "comparing stores is the owner's");
  const seenBy = async (userId: string) => runWithWall(await wallFor(storeId, userId, "STAFF"), () => prisma.order.findMany({ where: { storeId, AND: [orderWall()] }, select: { orderNumber: true } }));
  assert.deepEqual((await seenBy(ids.lipaCounter)).map((o) => o.orderNumber), [atLipa.orderNumber]);
  assert.deepEqual((await seenBy(ids.btHead)).map((o) => o.orderNumber), [atBt.orderNumber]);
  assert.equal((await runWithWall(await wallFor(storeId, owner.userId, "OWNER"), () => prisma.order.count({ where: { storeId, AND: [orderWall()] } }))), 3);

  // ── Decision 1: the consignment stores owe Bogs and Lucy the cost of what they sold ──
  const owes = async (locationId: string) => (await prisma.storePayableEntry.aggregate({ where: { storeId, locationId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
  assert.deepEqual([await owes(bt.id), await owes(lipa.id), await owes(main.id)], [3 * 115_000, 115_000, 0]);
});

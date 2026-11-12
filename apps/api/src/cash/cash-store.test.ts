// Per-store build, step 4 — cash at each store, against the real DB.
//   * one day with a counter sale, a delivery paid in cash, a credit payment, a refund, a void,
//     a drawer expense and a hand-over: expected cash matches the drawer to the peso;
//   * the daily report and the hand-over screen read the same cash;
//   * another store's cash never moves this store's drawer;
//   * a hand-over is cancelled by the owner only, with a reason, and then no longer counts;
//   * a credit payment taken at one store for another store's sale is noted on both sides.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { RiceReportsService } from "../reports/rice-reports.service.js";
import { ExpensesService } from "../expenses/expenses.service.js";
import { manilaDate } from "../domain/reports.js";
import type { Actor } from "../people/people.service.js";
import { cashOfDay, storeOwedFirst } from "./cash-book.js";
import { CashService } from "./cash.service.js";

const run = `CSH${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];
let seq = 0;
let n = 0;
const cashSvc = new CashService();
const must = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.cashHandover.deleteMany({ where });
    await prisma.creditEntry.deleteMany({ where });
    await prisma.payment.deleteMany({ where });
    await prisma.expense.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Cash ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const bt = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const person = async (name: string, role: "OWNER" | "STAFF", homeLocationId: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@csh.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId } });
    return { userId: u.id, role, homeLocationId };
  };
  return { storeId: store.id, main: main.id, bt: bt.id, owner: await person("owner", "OWNER", null), btStaff: await person("bt", "STAFF", bt.id) };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

/** A finished sale with its payment rows, the way the counter and a delivery leave them. */
async function sale(fx: Fx, o: { locationId: string | null; totalMinor: number; method?: string; payAt?: string | null }) {
  n += 1;
  const order = await prisma.order.create({
    data: {
      orderNumber: `${run}-${n}`, storeId: fx.storeId, status: "COMPLETED", source: "pos", currencyCode: "PHP", subtotalMinor: o.totalMinor, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: o.totalMinor,
      snapshot: {}, paymentMethod: o.method ?? "cash", paymentStatus: "COLLECTED", cartToken: `cart-${run}-${n}`, customerName: "Walk-in", customerPhone: "", deliveryAddressLine1: "",
      sellingLocationId: o.locationId, occurredAt: new Date(),
    },
  });
  if ((o.method ?? "cash") !== "credit") {
    await prisma.payment.create({ data: { orderId: order.id, storeId: fx.storeId, method: o.method ?? "cash", amountMinor: o.totalMinor, type: "payment", status: "paid", locationId: o.payAt === undefined ? o.locationId : o.payAt } });
  }
  return order.id;
}

test("one day at a store: expected cash matches the drawer to the peso, and the reports agree", async () => {
  const fx = await fixture();
  const today = manilaDate(new Date());
  // Bahay Tindahan's drawer today:
  await sale(fx, { locationId: fx.bt, totalMinor: 270_000 }); //            + 2,700.00 counter sale, cash
  await sale(fx, { locationId: fx.bt, totalMinor: 135_000, method: "gcash" }); //   GCash: not in the drawer
  await sale(fx, { locationId: fx.bt, totalMinor: 140_000, payAt: null }); // + 1,400.00 delivery paid in cash (old row with no place: the order's store)
  await prisma.payment.create({ data: { storeId: fx.storeId, method: "cash", amountMinor: 50_000, type: "payment", status: "paid", locationId: fx.bt, note: "Credit payment" } }); // + 500.00 credit paid in cash
  const refunded = await sale(fx, { locationId: fx.bt, totalMinor: 130_000 }); // + 1,300.00, then refunded
  await prisma.payment.create({ data: { orderId: refunded, storeId: fx.storeId, method: "cash", amountMinor: -130_000, type: "refund", locationId: fx.bt } }); // − 1,300.00
  const voided = await sale(fx, { locationId: fx.bt, totalMinor: 65_000 }); //   + 650.00, then voided
  await prisma.payment.create({ data: { orderId: voided, storeId: fx.storeId, method: "cash", amountMinor: 0, type: "void" } }); // − 650.00 (the void row carries no place and no amount)
  const exp = new ExpensesService();
  must(await exp.create(fx.storeId, fx.btStaff, { category: "transport", amountMinor: 35_000, paidFromDrawer: true })); // − 350.00 from the drawer
  must(await exp.create(fx.storeId, fx.btStaff, { category: "supplies", amountMinor: 99_000 })); //                          not from the drawer
  const wrong = must(await exp.create(fx.storeId, fx.btStaff, { category: "other", amountMinor: 77_700, paidFromDrawer: true }));
  must(await exp.cancel(fx.storeId, fx.owner, wrong.id, "Typed wrong")); //                                                   cancelled: counts nowhere
  const handed = must(await cashSvc.handOver(fx.storeId, fx.btStaff, { amountMinor: 200_000, note: "to the owner at noon" })); // − 2,000.00 handed over
  // The main store's cash is its own.
  await sale(fx, { locationId: fx.main, totalMinor: 500_000 });
  await sale(fx, { locationId: null, totalMinor: 10_000 });
  must(await exp.create(fx.storeId, fx.owner, { category: "wages", amountMinor: 20_000, locationId: fx.main, paidFromDrawer: true }));

  // 2,700 + 1,400 + 500 + 1,300 + 650 = 6,550 in; 1,300 + 650 given back; 350 paid out; 2,000 handed over.
  const want = { inMinor: 655_000, creditPaidMinor: 50_000, givenBackMinor: 195_000, paidOutMinor: 35_000, handedOverMinor: 200_000, expectedMinor: 225_000 };
  assert.equal(handed.expectedMinor, 225_000, "the hand-over answers with what is left in the drawer");
  const book = await cashOfDay(prisma, fx.storeId, fx.bt, today);
  assert.deepEqual({ inMinor: book.inMinor, creditPaidMinor: book.creditPaidMinor, givenBackMinor: book.givenBackMinor, paidOutMinor: book.paidOutMinor, handedOverMinor: book.handedOverMinor, expectedMinor: book.expectedMinor }, want);

  const daily = await new RiceReportsService().daily(fx.storeId, fx.owner, { date: today });
  assert.ok(daily.ok, JSON.stringify(daily));
  if (!daily.ok) return;
  const cashAt = (id: string) => daily.value.sections.find((s) => s.location.id === id)!.cash as unknown as typeof want;
  assert.equal(cashAt(fx.bt).expectedMinor, 225_000, "the daily report reads the same cash book");
  assert.equal(cashAt(fx.bt).handedOverMinor, 200_000);
  assert.equal(cashAt(fx.main).expectedMinor, 510_000 - 20_000, "the main store: its sales and the sale with no store, less its own drawer expense");

  const screen = must(await cashSvc.day(fx.storeId, fx.btStaff, { locationId: fx.main }));
  assert.equal(screen.location.id, fx.bt, "a store login reads its own store's cash, whatever it asks for");
  assert.deepEqual(screen.cash, want);
  assert.equal(screen.handovers.length, 1);
  assert.deepEqual([screen.handovers[0]!.amountMinor, screen.handovers[0]!.handedBy, screen.handovers[0]!.received, screen.canCancel], [200_000, "bt", false, false]);
});

test("hand-overs: staff at their own store today; the owner receives and cancels with a reason", async () => {
  const fx = await fixture();
  const today = manilaDate(new Date());
  await sale(fx, { locationId: fx.bt, totalMinor: 300_000 });
  const other = await cashSvc.handOver(fx.storeId, fx.btStaff, { locationId: fx.main, amountMinor: 1_000 });
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.error.type, "forbidden");
  assert.equal((await cashSvc.handOver(fx.storeId, fx.btStaff, { amountMinor: 0 })).ok, false);
  assert.equal((await cashSvc.handOver(fx.storeId, fx.btStaff, { amountMinor: 1_000, date: "2026-01-01" })).ok, false, "staff cannot write another day");
  assert.equal((await cashSvc.handOver(fx.storeId, fx.owner, { amountMinor: 1_000 })).ok, false, "the owner must say which store");
  assert.equal((await cashSvc.handOver(fx.storeId, fx.owner, { locationId: fx.bt, amountMinor: 1_000, date: "2999-01-01" })).ok, false);

  const a = must(await cashSvc.handOver(fx.storeId, fx.btStaff, { amountMinor: 100_000 }));
  const b = must(await cashSvc.handOver(fx.storeId, fx.owner, { locationId: fx.bt, amountMinor: 50_000 }));
  assert.equal(b.expectedMinor, 150_000);
  assert.ok((await prisma.cashHandover.findUniqueOrThrow({ where: { id: b.id } })).receivedById, "written by the owner: received");

  assert.equal((await cashSvc.receive(fx.storeId, fx.btStaff, a.id)).ok, false);
  must(await cashSvc.receive(fx.storeId, fx.owner, a.id));
  assert.equal((await cashSvc.cancel(fx.storeId, fx.btStaff, a.id, "no")).ok, false, "staff cannot cancel");
  assert.equal((await cashSvc.cancel(fx.storeId, fx.owner, a.id, "")).ok, false, "a reason is needed");
  must(await cashSvc.cancel(fx.storeId, fx.owner, a.id, "Counted twice"));
  must(await cashSvc.cancel(fx.storeId, fx.owner, a.id, "Pressed twice"));

  const day = must(await cashSvc.day(fx.storeId, fx.owner, { locationId: fx.bt, date: today }));
  assert.equal(day.cash.handedOverMinor, 50_000, "the cancelled hand-over no longer counts");
  assert.equal(day.cash.expectedMinor, 250_000);
  assert.equal(day.handovers.length, 2, "and it is still on the list");
  const c = day.handovers.find((h) => h.id === a.id)!;
  assert.deepEqual([c.cancelled, c.cancelReason, c.received], [true, "Counted twice", true]);
  assert.equal(day.canCancel, true);
  assert.equal((await cashSvc.day(fx.storeId, fx.owner, {})).ok, false, "the owner must choose a store");
});

test("credit paid at one store for another store's sale is noted on both sides, and the cash stays where it was paid", async () => {
  const fx = await fixture();
  const today = manilaDate(new Date());
  const customer = await prisma.customer.create({ data: { name: "Juan", phone: `09${String(Date.now()).slice(-9)}` } });
  customerIds.push(customer.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: fx.storeId, customerId: customer.id, creditBalanceMinor: 300_000 } });
  const t0 = Date.now() - 3 * 86_400_000;
  const entry = (orderId: string | null, type: string, amountMinor: number, daysLater: number) =>
    prisma.creditEntry.create({ data: { storeId: fx.storeId, storeCustomerId: sc.id, orderId, type, amountMinor, createdAt: new Date(t0 + daysLater * 3_600_000) } });
  const first = await sale(fx, { locationId: fx.main, totalMinor: 100_000, method: "credit" });
  const second = await sale(fx, { locationId: fx.bt, totalMinor: 200_000, method: "credit" });
  await entry(first, "purchase", 100_000, 0);
  await entry(second, "purchase", 200_000, 1);
  assert.equal(await storeOwedFirst(prisma, fx.storeId, sc.id, fx.main), fx.main, "the oldest unpaid credit sale is the main store's");
  await entry(null, "payment", -100_000, 2);
  assert.equal(await storeOwedFirst(prisma, fx.storeId, sc.id, fx.main), fx.bt, "once that is paid off, the next one is Bahay Tindahan's");
  await entry(null, "payment", -200_000, 3);
  assert.equal(await storeOwedFirst(prisma, fx.storeId, sc.id, fx.main), null, "nothing owed");

  // ₱1,000 for the main store's sale, paid in cash at Bahay Tindahan.
  await prisma.payment.create({ data: { storeId: fx.storeId, method: "cash", amountMinor: 100_000, type: "payment", status: "paid", locationId: fx.bt, forLocationId: fx.main } });
  const atBt = await cashOfDay(prisma, fx.storeId, fx.bt, today);
  const atMain = await cashOfDay(prisma, fx.storeId, fx.main, today);
  assert.equal(atBt.expectedMinor, 100_000, "the cash is in Bahay Tindahan's drawer");
  assert.deepEqual(atBt.heldForOthers, [{ locationId: fx.main, amountMinor: 100_000 }]);
  assert.equal(atMain.expectedMinor, 0);
  assert.deepEqual(atMain.heldByOthers, [{ locationId: fx.bt, amountMinor: 100_000 }]);
});

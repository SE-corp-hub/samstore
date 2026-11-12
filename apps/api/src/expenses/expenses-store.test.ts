// Per-store build, step 3 — expenses per store, against the real DB.
//   * a login tied to a store adds expenses for that store only, and sees only that store's;
//   * the owner chooses the store, or the whole business;
//   * an old copy of the app (no store sent) still saves;
//   * a wrong expense is cancelled with a reason by the owner, never deleted, and a cancelled
//     expense counts in no report.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ExpensesService, type ExpenseActor } from "./expenses.service.js";
import { ReportsService } from "../reports/reports.service.js";
import { RiceReportsService } from "../reports/rice-reports.service.js";
import { manilaDate } from "../domain/reports.js";

const run = `EXS${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;
const svc = new ExpensesService();

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.expense.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Expenses ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const bt = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const person = async (name: string, role: "OWNER" | "STAFF", homeLocationId: string | null): Promise<ExpenseActor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@exs.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId } });
    return { userId: u.id, role, homeLocationId };
  };
  return { storeId: store.id, main: main.id, bt: bt.id, owner: await person("owner", "OWNER", null), btStaff: await person("bt", "STAFF", bt.id), looseStaff: await person("loose", "STAFF", null) };
}
const must = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };

test("a store login adds expenses for its own store only, and sees only its own", async () => {
  const fx = await fixture();
  const own = must(await svc.create(fx.storeId, fx.btStaff, { category: "supplies", amountMinor: 15_000, note: " sako ", paidFromDrawer: true }));
  assert.equal(own.locationId, fx.bt, "no store sent: the login's own store");
  const other = await svc.create(fx.storeId, fx.btStaff, { category: "supplies", amountMinor: 100, locationId: fx.main });
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.error.type, "forbidden");
  const business = must(await svc.create(fx.storeId, fx.btStaff, { category: "rent", amountMinor: 200, locationId: null }));
  assert.equal(business.locationId, fx.bt, "a store login cannot write a whole-business expense");

  must(await svc.create(fx.storeId, fx.owner, { category: "rent", amountMinor: 500_000, locationId: fx.main }));
  const seen = await svc.list(fx.storeId, fx.btStaff, { locationId: fx.main });
  assert.deepEqual(seen.expenses.map((e) => e.locationName), ["Bahay Tindahan", "Bahay Tindahan"]);
  assert.equal(seen.totalMinor, 15_200);
  assert.equal(seen.canCancel, false);
  assert.equal(seen.ownLocationId, fx.bt);
  const first = seen.expenses.find((e) => e.amountMinor === 15_000)!;
  assert.equal(first.note, "sako");
  assert.equal(first.paidFromDrawer, true);
  assert.equal(first.addedBy, "bt");
});

test("the owner chooses the store or the whole business; an old app with no store still saves", async () => {
  const fx = await fixture();
  assert.equal(must(await svc.create(fx.storeId, fx.owner, { category: "wages", amountMinor: 1_000, locationId: fx.bt })).locationId, fx.bt);
  const whole = must(await svc.create(fx.storeId, fx.owner, { category: "utilities", amountMinor: 2_000, locationId: null, paidFromDrawer: true }));
  assert.equal(whole.locationId, null);
  assert.equal((await prisma.expense.findUniqueOrThrow({ where: { id: whole.id } })).paidFromDrawer, false, "no store, no drawer");
  assert.equal(must(await svc.create(fx.storeId, fx.owner, { category: "other", amountMinor: 3_000 })).locationId, null, "old owner app: the whole business, as before");
  assert.equal(must(await svc.create(fx.storeId, fx.looseStaff, { category: "other", amountMinor: 4_000 })).locationId, fx.main, "staff with no store set: the main store");
  const bad = await svc.create(fx.storeId, fx.owner, { category: "other", amountMinor: 1, locationId: "nope" });
  assert.equal(bad.ok, false);

  assert.equal((await svc.list(fx.storeId, fx.owner)).totalMinor, 10_000);
  assert.equal((await svc.list(fx.storeId, fx.owner, { locationId: fx.bt })).totalMinor, 1_000);
  assert.equal((await svc.list(fx.storeId, fx.owner, { locationId: "business" })).totalMinor, 5_000);
  assert.equal((await svc.totals(fx.storeId, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), fx.main)).totalMinor, 4_000);
});

test("a wrong expense is cancelled by the owner with a reason, stays on the list, and counts in no report", async () => {
  const fx = await fixture();
  const keep = must(await svc.create(fx.storeId, fx.btStaff, { category: "transport", amountMinor: 30_000 }));
  const wrong = must(await svc.create(fx.storeId, fx.btStaff, { category: "transport", amountMinor: 99_900 }));
  must(await svc.create(fx.storeId, fx.owner, { category: "rent", amountMinor: 50_000, locationId: fx.main }));

  const byStaff = await svc.cancel(fx.storeId, fx.btStaff, wrong.id, "typo");
  assert.equal(byStaff.ok, false);
  if (!byStaff.ok) assert.equal(byStaff.error.type, "forbidden");
  const oldDelete = await svc.remove(fx.storeId, fx.btStaff, wrong.id);
  assert.equal(oldDelete.ok, false, "staff cannot delete, also from an old copy of the app");
  const noReason = await svc.cancel(fx.storeId, fx.owner, wrong.id, " ");
  assert.equal(noReason.ok, false);
  must(await svc.cancel(fx.storeId, fx.owner, wrong.id, "Wrong amount"));
  must(await svc.cancel(fx.storeId, fx.owner, wrong.id, "Pressed twice"));

  const row = await prisma.expense.findUniqueOrThrow({ where: { id: wrong.id } });
  assert.ok(row.voidedAt);
  assert.equal(row.voidReason, "Wrong amount");
  assert.equal(row.voidedById, fx.owner.userId);

  const list = await svc.list(fx.storeId, fx.owner, { locationId: fx.bt });
  assert.equal(list.expenses.length, 2, "the cancelled one is still listed");
  const c = list.expenses.find((e) => e.id === wrong.id)!;
  assert.equal(c.cancelled, true);
  assert.equal(c.cancelReason, "Wrong amount");
  assert.equal(c.cancelledBy, "owner");
  assert.equal(list.totalMinor, 30_000);
  assert.ok(keep.id);

  const from = new Date(Date.now() - 3_600_000), to = new Date(Date.now() + 3_600_000);
  assert.equal((await svc.totals(fx.storeId, from, to)).totalMinor, 80_000);
  const old = new ReportsService();
  assert.equal((await old.profitSummary(fx.storeId, from, to)).expensesMinor, 80_000);
  assert.equal((await old.incomeLoss(fx.storeId, from, to)).expenses.totalMinor, 80_000);

  const rice = new RiceReportsService();
  const today = manilaDate(new Date());
  const all = await rice.daily(fx.storeId, fx.owner, { date: today });
  assert.ok(all.ok, JSON.stringify(all));
  if (all.ok) assert.equal((all.value.total as { expensesMinor?: number }).expensesMinor, 80_000, "all stores: every expense that counts");
  const one = await rice.daily(fx.storeId, fx.owner, { date: today, locationId: fx.bt });
  assert.ok(one.ok, JSON.stringify(one));
  if (one.ok) assert.equal((one.value.total as { expensesMinor?: number }).expensesMinor, 30_000, "one store: that store's expenses");
  const month = await rice.monthly(fx.storeId, fx.owner, today.slice(0, 7));
  assert.ok(month.ok, JSON.stringify(month));
  if (month.ok) assert.equal(month.value.profit.expensesMinor, 80_000);
});

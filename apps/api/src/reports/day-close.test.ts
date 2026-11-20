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
import { manilaDate } from "../domain/reports.js";
import type { Actor } from "../people/people.service.js";

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
    await prisma.idempotencyRecord.deleteMany({ where }).catch(() => undefined);
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

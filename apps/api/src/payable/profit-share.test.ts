// Profit share, against the real DB. Proves the Phase 3 "done when":
//   * the worked week: Store 1 takes 10 Jasmine from Store 2 (₱2,000 share at ₱200 a sack), Store 2 sells 5
//     (₱5,750) and 1 is missing (₱1,150) → Store 2 owes ₱6,900 − ₱2,000 = ₱4,900;
//   * rice lost on the road earns no share; Store 1 selling off Store 2's shelf earns Store 2 its share;
//     rice moved back takes the share back; the balance may go below zero and Store 1 can pay it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { CountService } from "../counts/count.service.js";
import { BentaService } from "../selling/benta.service.js";
import { PayableService } from "../payable/payable.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import { WarehouseService } from "../admin/warehouse.service.js";
import { RiceReportsService } from "../reports/rice-reports.service.js";
import { StoreReportService } from "../reports/store-report.service.js";
import { WeeklySummaryService } from "../reports/weekly-summary.service.js";
import { manilaDate } from "../domain/reports.js";
import { type Actor, type SignatureInput } from "../people/people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `PSH${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.stockWriteOff.deleteMany({ where });
    await prisma.stockCountLine.deleteMany({ where });
    await prisma.stockCount.deleteMany({ where });
    await prisma.stockInLine.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    await prisma.kargador.deleteMany({ where });
    await prisma.stockIn.deleteMany({ where });
    if (orderIds.length) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where });
    await prisma.cashMovement.deleteMany({ where });
    await prisma.registerSession.deleteMany({ where });
    await prisma.register.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const staffSig: SignatureInput[] = [{ signerKind: "STAFF", imagePng: PNG }];
const counts = new CountService();
const benta = new BentaService();
const payable = new PayableService();
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const key = () => `tap-${randomBytes(8).toString("hex")}`;

/** Jasmine 25 kg: unit price ₱1,150, ₱1,350 at both stores. Store 1 has 4 sacks, Store 2 (consignment) 30, plus loose rice at Store 1. */
async function fixture() {
  seq += 1;
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `PS ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE", consignment: true } });
  const jasmine = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-J25`, name: "Jasmine 25 kg", priceMinor: 135_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" } });
  const loose = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-JK`, name: "Jasmine (per kilo)", priceMinor: 5_600, costMinor: 4_600, stockBaseUnit: "g", stockBaseQuantity: 1, stockConversionFamily: "Bigas", soldByWeight: true } });
  await prisma.locationPrice.create({ data: { storeId: store.id, warehouseId: s2.id, productId: jasmine.id, priceMinor: 135_000 } });
  const mk = async (name: string, role: "OWNER" | "MANAGER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@ps.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  const fx = { storeId: store.id, s1: s1.id, s2: s2.id, jasmine, loose, staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id), owner: await mk("Aling Nena", "OWNER", null) };
  for (const [actor, locationId, lines] of [
    [fx.staff1, fx.s1, [{ productId: jasmine.id, quantity: 4 }, { productId: loose.id, quantity: 20_000 }]],
    [fx.staff2, fx.s2, [{ productId: jasmine.id, quantity: 30 }]],
  ] as const) {
    const r = await benta.stockIn(fx.storeId, actor, { locationId, lines: [...lines], signatures: staffSig });
    assert.equal(r.ok, true, msg(r));
  }
  return fx;
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const onHand = async (fx: Fx, productId: string, w: string) => (await prisma.stockLevel.findFirst({ where: { storeId: fx.storeId, productId, warehouseId: w } }))?.quantityOnHand ?? 0;
const owes = async (fx: Fx, w: string) => (await prisma.storePayableEntry.aggregate({ where: { storeId: fx.storeId, locationId: w }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
const salesAt = async (fx: Fx, w: string) => (await prisma.order.aggregate({ where: { storeId: fx.storeId, sellingLocationId: w, status: "COMPLETED" }, _sum: { totalMinor: true } }))._sum.totalMinor ?? 0;

/** A closing count where every line is counted as given (product id → counted). */
async function closing(fx: Fx, staff: Actor, locationId: string, counted: Record<string, number | string>) {
  const c = await counts.start(fx.storeId, staff, { locationId, productIds: Object.keys(counted) });
  assert.equal(c.ok, true, msg(c));
  if (!c.ok) throw new Error("no count");
  assert.equal((await counts.record(fx.storeId, staff, c.value.id, Object.entries(counted).map(([productId, n]) => ({ productId, counted: n })))).ok, true);
  const lines = await prisma.stockCountLine.findMany({ where: { countId: c.value.id }, select: { productId: true } });
  assert.equal((await counts.setReasons(fx.storeId, staff, c.value.id, lines.map((l) => ({ productId: l.productId, reason: "UNRINGED" })))).ok, true);
  const sub = await counts.submit(fx.storeId, staff, c.value.id, staffSig);
  assert.equal(sub.ok && sub.value.status, "APPROVED", msg(sub));
  return c.value.id;
}

const flow = new TransferFlowService();
const kinds = async (fx: Fx) => (await prisma.storePayableEntry.findMany({ where: { storeId: fx.storeId }, orderBy: { createdAt: "asc" }, select: { kind: true, amountMinor: true } })).map((e) => `${e.kind} ${e.amountMinor}`);

test("Phase 3: the worked week — ₱2,000 share on arrival, ₱6,900 charged, Store 2 owes ₱4,900", async () => {
  const fx = await fixture();
  const moved = await flow.moveNow(fx.storeId, fx.owner, { fromLocationId: fx.s2, toLocationId: fx.s1, productId: fx.jasmine.id, quantity: 10 });
  assert.equal(moved.ok, true, msg(moved));
  assert.equal(await owes(fx, fx.s2), -200_000, "Store 1 owes Store 2 the profit: 10 × (₱1,350 − ₱1,150)");
  const share = await prisma.storePayableEntry.findFirstOrThrow({ where: { storeId: fx.storeId, kind: "PROFIT_SHARE" } });
  assert.equal(share.transferId, moved.ok ? moved.value.id : "");
  assert.equal(share.unitCostMinor, 20_000);
  assert.equal(await owes(fx, fx.s1), 0, "nothing on Store 1's own line");

  assert.equal((await benta.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.jasmine.id, quantity: 5 }], payment: { method: "cash" } })).ok, true);
  await closing(fx, fx.staff2, fx.s2, { [fx.jasmine.id]: 14 });
  assert.equal(await owes(fx, fx.s2), 490_000, "₱5,750 + ₱1,150 − ₱2,000");

  const sum = await payable.summary(fx.storeId, fx.owner);
  assert.equal(sum.ok, true, msg(sum));
  if (!sum.ok) return;
  const s2 = sum.value.stores.find((s) => s.id === fx.s2)!;
  assert.equal(s2.chargesMinor, 690_000);
  assert.equal(s2.sharesMinor, 200_000);
  assert.equal(s2.owesMinor, 490_000);
});

test("Phase 3: Store 1 selling off Store 2's shelf, moving rice back, a below-zero balance and Store 1 paying it", async () => {
  const fx = await fixture();
  // Store 1 sells 2 sacks straight from Store 2's shelf: Store 2 earns its ₱200 a sack.
  const sale = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), locationId: fx.s1, lines: [{ productId: fx.jasmine.id, quantity: 2, sourceLocationId: fx.s2 }], payment: { method: "cash" } });
  assert.equal(sale.ok, true, msg(sale));
  assert.equal(await owes(fx, fx.s2), -40_000);
  assert.equal(await onHand(fx, fx.jasmine.id, fx.s2), 28);

  // 6 more move to Store 1, then 3 go back: the share for 3 comes back. A move back never shared earns nothing.
  assert.equal((await flow.moveNow(fx.storeId, fx.owner, { fromLocationId: fx.s2, toLocationId: fx.s1, productId: fx.jasmine.id, quantity: 6 })).ok, true);
  assert.equal(await owes(fx, fx.s2), -160_000);
  assert.equal((await flow.moveNow(fx.storeId, fx.owner, { fromLocationId: fx.s1, toLocationId: fx.s2, productId: fx.jasmine.id, quantity: 3 })).ok, true);
  assert.equal(await owes(fx, fx.s2), -100_000);
  assert.equal((await flow.moveNow(fx.storeId, fx.owner, { fromLocationId: fx.s1, toLocationId: fx.s2, productId: fx.loose.id, quantity: 2_000 })).ok, true);
  assert.equal(await owes(fx, fx.s2), -100_000, "loose rice that was never shared takes nothing back");
  assert.deepEqual(await kinds(fx), ["PROFIT_SHARE -40000", "PROFIT_SHARE -120000", "SHARE_BACK 60000"]);

  // Store 2 cannot "pay" a balance below zero; Store 1 pays it instead.
  assert.match(msg(await payable.payment(fx.storeId, fx.owner, { locationId: fx.s2, amountMinor: 100 })), /owes nothing now/);
  assert.match(msg(await payable.payment(fx.storeId, fx.owner, { locationId: fx.s2, amountMinor: 100_001, toStore: true })), /only ₱1,000\.00/);
  const paid = await payable.payment(fx.storeId, fx.owner, { locationId: fx.s2, amountMinor: 100_000, toStore: true });
  assert.equal(paid.ok && paid.value.balanceMinor, 0, msg(paid));

  // A share booked by mistake can be undone by hand.
  const first = await prisma.storePayableEntry.findFirstOrThrow({ where: { storeId: fx.storeId, kind: "PROFIT_SHARE" }, orderBy: { createdAt: "asc" } });
  const undo = await payable.reverse(fx.storeId, fx.owner, first.id, "wrong store");
  assert.equal(undo.ok, true, msg(undo));
  assert.equal(await owes(fx, fx.s2), 40_000);
});

test("Phase 3: a trip from Store 2 — the share is on what arrived, never on rice lost on the road", async () => {
  const fx = await fixture();
  const kargador = await prisma.kargador.create({ data: { storeId: fx.storeId, name: "Mang Boy" } });
  const sigs: SignatureInput[] = [...staffSig, { signerKind: "KARGADOR", kargadorId: kargador.id, imagePng: PNG }];
  const wh = new WarehouseService();
  const req = await wh.requestTransfer(fx.storeId, fx.s2, fx.s1, fx.jasmine.id, 5, fx.staff1.userId);
  assert.equal(req.ok, true, msg(req));
  if (!req.ok) return;
  assert.equal((await wh.approveTransfer(fx.storeId, req.value.id, fx.owner.userId)).ok, true);
  assert.equal((await flow.release(fx.storeId, fx.staff2, req.value.id, { quantity: 5, kargadorId: kargador.id, signatures: sigs })).ok, true);
  assert.equal(await owes(fx, fx.s2), 0, "nothing until it arrives");
  const got = await flow.receive(fx.storeId, fx.staff1, req.value.id, { quantity: 4, signatures: sigs });
  assert.equal(got.ok, true, msg(got));
  assert.equal(await owes(fx, fx.s2), -80_000, "4 arrived × ₱200; the sack lost on the road earns no share");
});

test("Phase 4: the reports — Store 2's profit is ₱3,200 and Store 1's is ₱0 on the moved rice; the weekly summary says who owes", async () => {
  const fx = await fixture();
  // Store 1 starts with its own 4 sacks out of the way: sell them first, so only moved rice is left at Store 1.
  assert.equal((await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), locationId: fx.s1, lines: [{ productId: fx.jasmine.id, quantity: 4 }], payment: { method: "cash" } })).ok, true);
  const before = await new StoreReportService().sales(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(before.ok, true, msg(before));
  const s1Before = before.ok ? before.value.sales.grossProfitMinor ?? 0 : 0;
  assert.equal(s1Before, 4 * 20_000);

  assert.equal((await flow.moveNow(fx.storeId, fx.owner, { fromLocationId: fx.s2, toLocationId: fx.s1, productId: fx.jasmine.id, quantity: 10 })).ok, true);
  assert.equal((await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), locationId: fx.s1, lines: [{ productId: fx.jasmine.id, quantity: 10 }], payment: { method: "cash" } })).ok, true);
  assert.equal((await benta.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.jasmine.id, quantity: 5 }], payment: { method: "cash" } })).ok, true);
  const countId = await closing(fx, fx.staff2, fx.s2, { [fx.jasmine.id]: 14 });
  assert.equal((await benta.sellCountShorts(fx.storeId, fx.owner, countId)).ok, true); // the missing sack was a walk-in

  const s1 = await new StoreReportService().sales(fx.storeId, fx.owner, { locationId: fx.s1 });
  const s2 = await new StoreReportService().sales(fx.storeId, fx.owner, { locationId: fx.s2 });
  assert.equal(s1.ok && (s1.value.sales.grossProfitMinor ?? 0) - s1Before, 0, "Store 1 earns ₱0 on the moved rice: ₱2,000 margin − ₱2,000 share");
  assert.equal(s1.ok && s1.value.sales.profitShareMinor, -200_000);
  assert.equal(s2.ok && s2.value.sales.grossProfitMinor, 320_000, "Store 2: 6 sold × ₱200 + ₱2,000 share");
  assert.equal(s2.ok && s2.value.sales.profitShareMinor, 200_000);
  assert.equal(await owes(fx, fx.s2), 490_000);

  const month = await new RiceReportsService().monthly(fx.storeId, fx.owner, manilaDate(new Date()).slice(0, 7));
  assert.equal(month.ok, true, msg(month));
  if (!month.ok) return;
  const at = (id: string) => month.value.locations.find((l) => l.location.id === id)!;
  assert.equal(at(fx.s2).grossProfitMinor, 320_000);
  assert.equal(at(fx.s1).grossProfitMinor, 4 * 20_000);
  assert.equal(month.value.profit.grossProfitMinor, 400_000, "the shares move profit between stores; the total stays 20 sold × ₱200");

  // When the shares are bigger, the weekly summary says the main store owes Store 2.
  await payable.payment(fx.storeId, fx.owner, { locationId: fx.s2, amountMinor: 490_000 });
  assert.equal((await flow.moveNow(fx.storeId, fx.owner, { fromLocationId: fx.s2, toLocationId: fx.s1, productId: fx.jasmine.id, quantity: 3 })).ok, true);
  const week = await new WeeklySummaryService().summary(fx.storeId, fx.owner, {});
  assert.equal(week.ok, true, msg(week));
  if (!week.ok) return;
  const c = week.value.consignment.find((x) => x.id === fx.s2)!;
  assert.equal(c.owesMinor, -60_000);
  assert.equal(c.mainName, "Store 1");
  assert.equal(c.sharesThisWeekMinor, 260_000);
  assert.equal(c.paidThisWeekMinor, 490_000);
});

test("D3: damage at Store 2 is Store 1's loss unless the owner charges it to Store 2 (once; undo makes it Store 1's loss again)", async () => {
  const fx = await fixture();
  const wo = await counts.writeOff(fx.storeId, fx.staff2, { locationId: fx.s2, productId: fx.jasmine.id, quantity: 1, reason: "BASA", signatures: staffSig });
  assert.equal(wo.ok, true, msg(wo));
  if (!wo.ok) return;
  assert.equal(await owes(fx, fx.s2), 0, "by default the damage is Store 1's loss");
  const sum = await payable.summary(fx.storeId, fx.owner);
  assert.equal(sum.ok && sum.value.damage.length, 1, msg(sum));
  assert.equal(sum.ok && sum.value.damage[0]?.amountMinor, 115_000);
  assert.equal(sum.ok && sum.value.damage[0]?.chargedAs, null);

  const charged = await payable.chargeDamage(fx.storeId, fx.owner, wo.value.id);
  assert.equal(charged.ok, true, msg(charged));
  assert.equal(await owes(fx, fx.s2), 115_000);
  assert.match(msg(await payable.chargeDamage(fx.storeId, fx.owner, wo.value.id)), /Already recorded/);
  assert.match(msg(await payable.chargeDamage(fx.storeId, fx.staff2, wo.value.id)), /owner and manager/);

  const entry = await prisma.storePayableEntry.findFirstOrThrow({ where: { storeId: fx.storeId, writeOffId: wo.value.id } });
  assert.equal((await payable.reverse(fx.storeId, fx.owner, entry.id, "Store 2 was not at fault")).ok, true);
  assert.equal(await owes(fx, fx.s2), 0);
  const after = await payable.summary(fx.storeId, fx.owner);
  assert.equal(after.ok && after.value.damage[0]?.chargedAs, null, "back to Store 1's loss, and it can be charged again");

  // Damage at Store 1 (not consignment) cannot be charged to anyone.
  const s1wo = await counts.writeOff(fx.storeId, fx.staff1, { locationId: fx.s1, productId: fx.jasmine.id, quantity: 1, reason: "TAPON", signatures: staffSig });
  assert.equal(s1wo.ok, true, msg(s1wo));
  assert.match(msg(await payable.chargeDamage(fx.storeId, fx.owner, s1wo.ok ? s1wo.value.id : "")), /consignment store/);
});

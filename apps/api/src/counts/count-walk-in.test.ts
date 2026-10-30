// "Missing = sold to walk-ins", against the real DB. Proves the Phase 2 "done when":
//   * the worked week: Store 2 (consignment) sells 5 Jasmine and 1 more is missing in the closing
//     count → it owes ₱6,900 at the unit price, never ₱8,050, and its sales are 6 × ₱1,350;
//   * the shelf is not touched twice, a shortage is sold once (a double tap gives the same sale),
//     and a recorded shortage leaves Store payable's "To assign".
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { CountService } from "./count.service.js";
import { BentaService } from "../selling/benta.service.js";
import { PayableService } from "../payable/payable.service.js";
import { type Actor, type SignatureInput } from "../people/people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `WIC${Date.now()}${Math.floor(Math.random() * 1000)}`;
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
    await prisma.stockCountLine.deleteMany({ where });
    await prisma.stockCount.deleteMany({ where });
    await prisma.stockInLine.deleteMany({ where });
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
  const store = await prisma.store.create({ data: { slug, name: `WI ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: true } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE", consignment: true } });
  const jasmine = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-J25`, name: "Jasmine 25 kg", priceMinor: 135_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" } });
  const loose = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-JK`, name: "Jasmine (per kilo)", priceMinor: 5_600, costMinor: 4_600, stockBaseUnit: "g", stockBaseQuantity: 1, stockConversionFamily: "Bigas", soldByWeight: true } });
  await prisma.locationPrice.create({ data: { storeId: store.id, warehouseId: s2.id, productId: jasmine.id, priceMinor: 135_000 } });
  const mk = async (name: string, role: "OWNER" | "MANAGER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@wi.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
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

test("Phase 2: the worked week at Store 2 — 5 sold + 1 missing = ₱6,900 owed (never ₱8,050), 6 sacks of sales", async () => {
  const fx = await fixture();
  // Store 2 has no drawer open: a POS sale is refused, so open the setting for its own sales.
  await prisma.storeSettings.update({ where: { storeId: fx.storeId }, data: { requireOpenShift: false } });
  const sold = await benta.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.jasmine.id, quantity: 5 }], payment: { method: "cash" } });
  assert.equal(sold.ok, true, msg(sold));
  await prisma.storeSettings.update({ where: { storeId: fx.storeId }, data: { requireOpenShift: true } });
  assert.equal(await owes(fx, fx.s2), 575_000);

  const countId = await closing(fx, fx.staff2, fx.s2, { [fx.jasmine.id]: 24 });
  assert.equal(await onHand(fx, fx.jasmine.id, fx.s2), 24);
  assert.equal(await owes(fx, fx.s2), 690_000, "the shortage is charged at the unit price");

  // The owner sees what can be recorded, at Store 2's price.
  const rep = await counts.report(fx.storeId, fx.owner, countId);
  assert.equal(rep.ok, true, msg(rep));
  if (!rep.ok) return;
  assert.equal(rep.value.walkIn?.open.length, 1);
  assert.equal(rep.value.walkIn?.openMinor, 135_000);
  assert.equal(rep.value.walkIn?.drawerOpen, false);
  // Staff never see it (a manager or owner decides).
  const staffRep = await counts.report(fx.storeId, fx.staff2, countId);
  assert.equal(staffRep.ok && staffRep.value.walkIn, null);

  // No drawer open: the sale is still kept (it is the past day's cash), without a drawer.
  const r = await benta.sellCountShorts(fx.storeId, fx.owner, countId);
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  assert.equal(r.value.totalMinor, 135_000);
  assert.equal(await onHand(fx, fx.jasmine.id, fx.s2), 24, "the shelf is not touched twice");
  assert.equal(await owes(fx, fx.s2), 690_000, "₱6,900, never ₱8,050");
  assert.equal(await salesAt(fx, fx.s2), 810_000, "6 sacks × ₱1,350");
  const entries = await prisma.storePayableEntry.findMany({ where: { storeId: fx.storeId }, orderBy: { createdAt: "asc" }, select: { kind: true, amountMinor: true } });
  assert.deepEqual(entries.map((e) => `${e.kind} ${e.amountMinor}`), ["CHARGE 575000", "CHARGE 115000", "REVERSAL -115000", "CHARGE 115000"]);

  // A double tap gives back the same sale; nothing more is posted.
  const again = await benta.sellCountShorts(fx.storeId, fx.owner, countId);
  assert.equal(again.ok && again.value.orderNumber, r.value.orderNumber, msg(again));
  assert.equal(await salesAt(fx, fx.s2), 810_000);

  const after = await counts.report(fx.storeId, fx.owner, countId);
  assert.equal(after.ok && after.value.walkIn?.open.length, 0);
  assert.equal(after.ok && after.value.walkIn?.sales[0]?.orderNumber, r.value.orderNumber);
  assert.equal(after.ok && after.value.lines[0]?.soldToWalkIns, true);
  const sum = await payable.summary(fx.storeId, fx.owner);
  assert.equal(sum.ok && sum.value.toAssign.length, 0);
});

test("Phase 2: Store 1 (not consignment) — missing sacks and loose kilos become one cash sale in the open drawer; nothing is owed", async () => {
  const fx = await fixture();
  const reg = await prisma.register.create({ data: { storeId: fx.storeId, name: "Counter", locationId: fx.s1 } });
  await prisma.registerSession.create({ data: { storeId: fx.storeId, registerId: reg.id, openedBy: fx.staff1.userId, openingFloatMinor: 0, status: "OPEN" } });
  const countId = await closing(fx, fx.staff1, fx.s1, { [fx.jasmine.id]: 2, [fx.loose.id]: "18.5" });
  const rep = await counts.report(fx.storeId, fx.owner, countId);
  assert.equal(rep.ok && rep.value.walkIn?.openMinor, 2 * 135_000 + 8_400, msg(rep)); // 1.5 kg × ₱56
  assert.equal(rep.ok && rep.value.walkIn?.drawerOpen, true);
  const r = await benta.sellCountShorts(fx.storeId, fx.owner, countId);
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  assert.equal(r.value.totalMinor, 278_400);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: r.value.orderId }, select: { registerSessionId: true, customerName: true } });
  assert.notEqual(order.registerSessionId, null, "the cash is checked in the drawer");
  assert.equal(order.customerName, "Walk-in");
  assert.equal(await onHand(fx, fx.jasmine.id, fx.s1), 2);
  assert.equal(await onHand(fx, fx.loose.id, fx.s1), 18_500);
  assert.equal(await owes(fx, fx.s1), 0);
  assert.equal(await prisma.storePayableEntry.count({ where: { storeId: fx.storeId } }), 0);
});

// Rice Ops M9 — reports, against the real DB. Proves the M9 "done when" list:
//   * a signed Ilabas shows on Stock Live within 5 s;
//   * the daily totals equal the sum of the day's documents.
// Plus: a paper slip counts on its own day; Pagsasara locks the day (and once only);
// monthly gross profit from frozen costs; the kargador pay sheet; Trace; alerts; owner-only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { RiceReportsService, watchStock } from "./rice-reports.service.js";
import { BentaService } from "../selling/benta.service.js";
import { UtangService } from "../utang/utang.service.js";
import { CountService } from "../counts/count.service.js";
import { ResackService } from "../resack/resack.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import { MockSmsProvider, setSmsProviderForTests } from "../sms/sms.provider.js";
import { manilaDate } from "../domain/reports.js";
import type { Actor, SignatureInput } from "../people/people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const jpeg = Buffer.alloc(800, 5); jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff;
const JPEG = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
const run = `M9R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];
let seq = 0;

setSmsProviderForTests(new MockSmsProvider());
after(async () => {
  setSmsProviderForTests(null);
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.dailyClose.deleteMany({ where });
    await prisma.smsMessage.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.stockCountLine.deleteMany({ where });
    await prisma.stockCount.deleteMany({ where });
    await prisma.stockWriteOff.deleteMany({ where });
    await prisma.resackOutput.deleteMany({ where });
    await prisma.resackJob.deleteMany({ where });
    await prisma.stockInLine.deleteMany({ where });
    await prisma.stockIn.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    await prisma.creditEntry.deleteMany({ where });
    if (orderIds.length) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where });
    await prisma.kargador.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const staffSig: SignatureInput[] = [{ signerKind: "STAFF", imagePng: PNG }];
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const key = () => `tap-${randomBytes(8).toString("hex")}`;
const reports = new RiceReportsService();
const benta = new BentaService();

async function fixture() {
  seq += 1;
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `M9 ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const mkP = (sku: string, name: string, grams: number, price: number, cost: number) =>
    prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-${sku}`, name, priceMinor: price, costMinor: cost, stockBaseUnit: "g", stockBaseQuantity: grams, stockConversionFamily: "Bigas", soldByWeight: grams === 1 } });
  const sin25 = await mkP("S25", "Sinandomeng 25 kg", 25_000, 130_000, 110_000);
  const loose = await mkP("SK", "Sinandomeng (per kilo)", 1, 5_200, 4_600);
  const kargador = await prisma.kargador.create({ data: { storeId: store.id, name: "Mang Boy" } });
  const cust = await prisma.customer.create({ data: { name: `Juan ${run}`, phone: null, email: null, passwordHash: null } });
  customerIds.push(cust.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: cust.id, creditApproved: true, creditLimitMinor: 1_000_000 } });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@m9.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  const fx = {
    storeId: store.id, s1: s1.id, s2: s2.id, sin25, loose, kargadorId: kargador.id, customerId: sc.id,
    staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id), owner: await mk("Aling Nena", "OWNER", null),
  };
  const r = await benta.stockIn(fx.storeId, fx.staff1, { locationId: s1.id, lines: [{ productId: sin25.id, quantity: 20 }, { productId: loose.id, quantity: 50_000 }], signatures: staffSig });
  assert.equal(r.ok, true, msg(r));
  return fx;
}

test("M9: a signed Ilabas shows on Stock Live within 5 s", async () => {
  const fx = await fixture();
  const sale = await benta.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 2, sourceLocationId: fx.s1 }], payment: { method: "cash" } });
  assert.equal(sale.ok, true, msg(sale));
  const tripId = sale.ok ? sale.value.releases[0]!.id : "";
  let seen: number | null = null;
  const changed = new Promise<void>((resolve) => {
    const stop = watchStock(fx.storeId, () => { seen = Date.now(); stop(); resolve(); }, 500);
  });
  await new Promise((r) => setTimeout(r, 800)); // the watcher has its baseline
  const rel = await new TransferFlowService().release(fx.storeId, fx.staff1, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: [...staffSig, { signerKind: "KARGADOR", kargadorId: fx.kargadorId, imagePng: PNG }] });
  const signedAt = Date.now(); // the step is signed when it is saved (on a slow link the save itself takes seconds)
  assert.equal(rel.ok, true, msg(rel));
  await Promise.race([changed, new Promise((_, no) => setTimeout(() => no(new Error("no change within 5 s")), 5_000))]);
  assert.ok(seen !== null && (seen as number) - signedAt < 5_000, `seen after ${(seen ?? 0) - signedAt} ms`);
  const live = await reports.stockLive(fx.storeId);
  const row = live.rows.find((r) => r.productId === fx.sin25.id)!;
  assert.equal(row.cells[fx.s1]!.onHand, 18, "left Store 1 at the signed Ilabas");
  assert.equal(row.inTransit, 2, "on the road");
  assert.equal(row.total, 20, "nothing disappears from view");
  const mv = await reports.movements(fx.storeId, fx.sin25.id, fx.s1);
  assert.ok(mv.some((m) => m.type === "RELEASE_OUT" && m.delta === -2 && m.by === "Ate Lorna"), "the cell opens the documents and the people behind it");
});

test("M9: the daily totals equal the sum of the day's documents; Pagsasara locks the day", async () => {
  const fx = await fixture();
  const today = manilaDate(new Date());
  const sales = [
    await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 2 }], payment: { method: "cash", tenderedMinor: 300_000 } }),
    await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.loose.id, amountMinor: 10_000 }], payment: { method: "gcash", reference: "55667788" } }),
    await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }, { productId: fx.loose.id, kilos: "2" }], payment: { method: "utang" }, customerId: fx.customerId, signatures: [{ signerKind: "CUSTOMER", signerName: "Juan", imagePng: PNG }] }),
    // A paper slip from yesterday belongs to yesterday.
    await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" }, paperSlip: { slipNo: `P${seq}`, occurredAt: new Date(Date.now() - 86_400_000).toISOString() }, signatures: [...staffSig, { signerKind: "SLIP_PHOTO", imagePng: JPEG }] }),
  ];
  for (const s of sales) assert.equal(s.ok, true, msg(s));
  const pay = await new UtangService().collect(fx.storeId, fx.staff1, { customerId: fx.customerId, amountMinor: 50_000, method: "cash", signatures: staffSig });
  assert.equal(pay.ok, true, msg(pay));
  assert.equal((await new CountService().writeOff(fx.storeId, fx.staff1, { productId: fx.loose.id, kilos: "0.3", reason: "TAPON", signatures: staffSig })).ok, true);
  const rs = await new ResackService().resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.loose.id, quantity: 24_800 }], kargadorId: fx.kargadorId, signatures: [{ signerKind: "KARGADOR", kargadorId: fx.kargadorId, imagePng: PNG }] });
  assert.equal(rs.ok, true, msg(rs));

  const d = await reports.daily(fx.storeId, fx.owner, { date: today, locationId: fx.s1 });
  assert.equal(d.ok, true, msg(d));
  if (!d.ok) return;
  const s = d.value.sections[0]!;
  // The same numbers, straight from the documents.
  const { from, to } = { from: new Date(`${today}T00:00:00+08:00`), to: new Date(new Date(`${today}T00:00:00+08:00`).getTime() + 86_400_000) };
  const orders = await prisma.order.findMany({ where: { storeId: fx.storeId, sellingLocationId: fx.s1, status: "COMPLETED", occurredAt: { gte: from, lt: to } }, select: { totalMinor: true, paymentMethod: true } });
  assert.equal(orders.length, 3, "the paper slip is yesterday's");
  assert.equal(s.sales.count, 3);
  assert.equal(s.sales.totalMinor, orders.reduce((a, o) => a + o.totalMinor, 0));
  assert.equal(s.sales.totalMinor, 260_000 + 10_000 + 130_000 + 10_400);
  assert.deepEqual([s.sales.cashMinor, s.sales.gcashMinor, s.sales.utangMinor], [260_000, 10_000, 140_400]);
  assert.equal(s.utang.givenMinor, 140_400);
  assert.equal(s.utang.collectedMinor, 50_000);
  const cashPayments = await prisma.payment.findMany({ where: { storeId: fx.storeId, method: "cash", type: "payment", receivedAt: { gte: from, lt: to } }, select: { amountMinor: true, orderId: true } });
  const yesterdaySlip = sales[3]!.ok ? sales[3]!.value.orderId : "";
  assert.equal(s.cash.expectedMinor, cashPayments.reduce((a, p) => a + p.amountMinor, 0), "every cash peso received today (incl. the slip encoded today)");
  assert.ok(cashPayments.some((p) => p.orderId === yesterdaySlip), "the slip's cash came in today");
  const g = s.kilosByVariety.find((v) => v.variety === "sinandomeng")!;
  assert.equal(g.grams, 3 * 25_000 + 1_923 + 2_000, "kilos sold today: 3 sacks + ₱100 worth + 2 kg");
  assert.equal(s.sales.costMinor, 3 * 110_000 + Math.round((1_923 * 4_600) / 1000) + Math.round((2_000 * 4_600) / 1000));
  assert.equal(s.stockIn.units, 20 + 50_000);
  assert.equal(s.writeOffs.valueMinor, 1_380);
  assert.deepEqual([s.resack.jobs, s.resack.lossGrams], [1, 200]);

  // Yesterday's report has the slip.
  const y = await reports.daily(fx.storeId, fx.owner, { date: manilaDate(new Date(Date.now() - 86_400_000)), locationId: fx.s1 });
  assert.equal(y.ok && y.value.sections[0]!.sales.totalMinor, 130_000);
  assert.equal(y.ok && y.value.sections[0]!.sales.encodedLater, 1);

  // Pagsasara: count the cash, sign; the day locks.
  assert.match(msg(await reports.close(fx.storeId, fx.staff1, { cashCountedMinor: 1 })), /Missing signature/);
  const closed = await reports.close(fx.storeId, fx.staff1, { cashCountedMinor: s.cash.expectedMinor - 2_000, signatures: staffSig });
  assert.equal(closed.ok, true, msg(closed));
  assert.equal(closed.ok && closed.value.cashVarianceMinor, -2_000, "₱20 short in the drawer");
  assert.equal((await reports.close(fx.storeId, fx.staff1, { cashCountedMinor: 0, signatures: staffSig })).ok, false, "once per day");
  assert.equal((await reports.close(fx.storeId, fx.staff2, { locationId: fx.s1, cashCountedMinor: 0, signatures: staffSig })).ok, false, "Store 2 staff cannot close Store 1");
  assert.equal((await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" } })).ok, true);
  const locked = await reports.daily(fx.storeId, fx.owner, { date: today, locationId: fx.s1 });
  assert.equal(locked.ok && locked.value.sections[0]!.locked, true);
  assert.equal(locked.ok && locked.value.sections[0]!.sales.totalMinor, s.sales.totalMinor, "the closed day does not move");
  assert.deepEqual(locked.ok && locked.value.sections[0]!.afterClose, { count: 1, totalMinor: 130_000, cashMinor: 130_000 }, "a sale after Pagsasara is shown apart, not lost");
});

test("M9: monthly gross profit from frozen costs; the kargador pay sheet; Trace; alerts — owner only", async () => {
  const fx = await fixture();
  const sale = await benta.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 2, sourceLocationId: fx.s1 }], payment: { method: "cash" } });
  assert.equal(sale.ok, true, msg(sale));
  const tripId = sale.ok ? sale.value.releases[0]!.id : "";
  const flow = new TransferFlowService();
  const k = (extra: SignatureInput[] = []) => [...staffSig, { signerKind: "KARGADOR", kargadorId: fx.kargadorId, imagePng: PNG }, ...extra];
  assert.equal((await flow.release(fx.storeId, fx.staff1, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: k() })).ok, true);
  assert.equal((await flow.deliver(fx.storeId, fx.staff2, tripId, { quantity: 2, signatures: k() })).ok, true);
  // The cost changes later: the sale keeps the cost it was sold at.
  await prisma.product.update({ where: { id: fx.sin25.id }, data: { costMinor: 125_000 } });

  assert.equal((await reports.monthly(fx.storeId, fx.staff1, undefined)).ok, false, "staff do not see the monthly report");
  const m = await reports.monthly(fx.storeId, fx.owner, undefined);
  assert.equal(m.ok, true, msg(m));
  if (!m.ok) return;
  const s2 = m.value.locations.find((l) => l.location.id === fx.s2)!;
  assert.deepEqual([s2.salesMinor, s2.costMinor, s2.grossProfitMinor, s2.grams], [260_000, 220_000, 40_000, 50_000], "the sale belongs to Store 2, at the cost it was sold at");
  const pay = m.value.kargadorPay.find((x) => x.kargadorId === fx.kargadorId)!;
  assert.equal(pay.count, 2, "release + delivery = 2 transactions");
  assert.deepEqual(pay.transactions.map((t) => t.kind).sort(), ["RELEASE:DELIVERED", "RELEASE:RELEASE"]);
  assert.match(pay.transactions[0]!.docNumber, /^REL-\d{6}$/);

  const docNumber = sale.ok ? sale.value.releases[0]!.docNumber : "";
  const t = await reports.trace(fx.storeId, fx.owner, docNumber.toLowerCase());
  assert.equal(t.ok, true, msg(t));
  const trail = t.ok ? t.value.results[0]! : null;
  assert.equal(trail?.docNumber, docNumber);
  assert.deepEqual(trail?.signatures.map((x) => x.signer).sort(), ["Ate Lorna", "Kuya Ben", "Mang Boy", "Mang Boy"]);
  assert.ok(trail?.movements.some((x) => x.type === "RELEASE_OUT" && x.by === "Ate Lorna"));
  const byKargador = await reports.trace(fx.storeId, fx.owner, "mang boy");
  assert.equal(byKargador.ok && byKargador.value.results.some((r) => r.docNumber === docNumber), true);

  const big = await new CountService().writeOff(fx.storeId, fx.staff1, { productId: fx.sin25.id, quantity: 3, reason: "BASA", signatures: staffSig });
  assert.equal(big.ok, true, msg(big));
  const a = await reports.alerts(fx.storeId, fx.owner);
  assert.equal(a.ok, true, msg(a));
  assert.equal(a.ok && a.value.approvals.some((x) => x.kind === "WRITE_OFF"), true);
  assert.equal(a.ok && a.value.ledgerMismatch, 0, "every shelf number equals its ledger");
  assert.equal((await reports.alerts(fx.storeId, fx.staff1)).ok, false);
});

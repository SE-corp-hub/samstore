// Rice Ops M6 — Utang and texts, against the real DB. Proves the M6 "done when" list:
//   * the utang sale text and the payment text carry the correct balances;
//   * a failed text never blocks a sale (it rests as FAILED and can be resent).
// Plus: over the limit → the owner decides (stock held meanwhile); Bayad sa utang at any
// store into that store's drawer; partial payments; no overpaying; racing payments;
// reminders once per period; returned rice reduces the utang; tenant isolation.
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "../selling/benta.service.js";
import { UtangService } from "./utang.service.js";
import { PeopleService, type Actor, type SignatureInput } from "../people/people.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import { deliverSms, resendSms } from "../sms/sms.service.js";
import { MockSmsProvider, setSmsProviderForTests, type SmsProvider } from "../sms/sms.provider.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `M6R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];
let seq = 0;
const PIN = "2580";

afterEach(() => setSmsProviderForTests(null));
after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.smsMessage.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.stockReturn.deleteMany({ where });
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
    await prisma.registerSession.deleteMany({ where });
    await prisma.register.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const phoneFor = () => `0917${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;

async function fixture(opts: { limit?: number; phone?: string | null } = {}) {
  seq += 1;
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `Bigasan M6 ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const sin25 = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 110_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sin25.id, warehouseId: s1.id, quantityOnHand: 10 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sin25.id, warehouseId: s2.id, quantityOnHand: 10 } });
  const phone = opts.phone === undefined ? phoneFor() : opts.phone;
  const cust = await prisma.customer.create({ data: { name: "Juan Dela Cruz", phone, email: null, passwordHash: null } });
  customerIds.push(cust.id);
  const limit = opts.limit ?? 500_000;
  const sc = await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: cust.id, creditApproved: limit > 0, creditLimitMinor: limit } });
  const pinHash = bcrypt.hashSync(PIN, 4);
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@m6.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF", pinHash } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  return {
    storeId: store.id, s1: s1.id, s2: s2.id, sin25, customerId: sc.id, phone,
    staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id), owner: await mk("Aling Nena", "OWNER", null),
  };
}

const custSig = (name = "Juan"): SignatureInput[] => [{ signerKind: "CUSTOMER", signerName: name, imagePng: PNG }];
const staffSig: SignatureInput[] = [{ signerKind: "STAFF", imagePng: PNG }];
const key = () => `tap-${randomBytes(8).toString("hex")}`;
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const benta = new BentaService();
const utang = new UtangService();
const balance = async (id: string) => (await prisma.storeCustomer.findUniqueOrThrow({ where: { id } })).creditBalanceMinor;
const level = async (fx: { storeId: string; sin25: { id: string } }, w: string) =>
  prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId, productId: fx.sin25.id, warehouseId: w }, select: { quantityOnHand: true, quantityReserved: true } });
const sellUtang = (fx: Awaited<ReturnType<typeof fixture>>, qty: number, who = fx.staff1) =>
  benta.sell(fx.storeId, who, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: qty }], payment: { method: "utang" }, customerId: fx.customerId, signatures: custSig() });

class FailingProvider implements SmsProvider {
  readonly name = "failing";
  calls = 0;
  async send(): Promise<never> {
    this.calls++;
    throw new Error("Walang load (test)");
  }
}

test("M6: the utang sale text and the payment text carry the correct balances", async () => {
  const fx = await fixture();
  const mock = new MockSmsProvider();
  setSmsProviderForTests(mock);
  const sale = await sellUtang(fx, 1);
  assert.equal(sale.ok, true, msg(sale));
  if (!sale.ok) return;
  assert.deepEqual([sale.value.status, sale.value.smsStatus], ["COMPLETED", "QUEUED"]);
  assert.equal(await balance(fx.customerId), 130_000);
  const saleSms = await prisma.smsMessage.findFirstOrThrow({ where: { storeId: fx.storeId, documentId: sale.value.orderId } });
  assert.match(saleSms.text, /^Salamat po, Juan\. Utang ngayon: P1,300 \(Sinandomeng 25 kg, Store 1, \d{1,2} \w{3}\)\. Kabuuang utang: P1,300\.$/);
  assert.equal(saleSms.phone, `+63${fx.phone!.slice(1)}`);
  assert.equal((await deliverSms(saleSms.id)).status, "SENT");
  assert.equal(mock.sent.length, 1);

  // A second sale: the text shows the running balance.
  const sale2 = await sellUtang(fx, 2);
  assert.equal(sale2.ok, true, msg(sale2));
  const sms2 = await prisma.smsMessage.findFirstOrThrow({ where: { storeId: fx.storeId, documentId: sale2.ok ? sale2.value.orderId : "" } });
  assert.match(sms2.text, /Utang ngayon: P2,600 .*Kabuuang utang: P3,900\.$/);

  // Bayad sa utang at Store 2 (a different store from the sales), partial.
  const pay = await utang.collect(fx.storeId, fx.staff2, { customerId: fx.customerId, amountMinor: 100_000, method: "cash", tenderedMinor: 100_000, signatures: staffSig });
  assert.equal(pay.ok, true, msg(pay));
  if (!pay.ok) return;
  assert.equal(pay.value.balanceMinor, 290_000);
  assert.equal(await balance(fx.customerId), 290_000);
  const paySms = await prisma.smsMessage.findUniqueOrThrow({ where: { id: pay.value.smsId } });
  assert.equal(paySms.text, "Natanggap: P1,000. Natitirang utang: P2,900. Salamat po!");
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: pay.value.paymentId } });
  assert.deepEqual([p.method, p.amountMinor, p.locationId], ["cash", 100_000, fx.s2], "the money is Store 2's");
  const entry = await prisma.creditEntry.findFirstOrThrow({ where: { paymentId: p.id } });
  assert.equal(entry.amountMinor, -100_000);

  // Paying the rest says it is all paid.
  const rest = await utang.collect(fx.storeId, fx.staff2, { customerId: fx.customerId, amountMinor: 290_000, method: "gcash", reference: "9876543210", signatures: staffSig });
  assert.equal(rest.ok, true, msg(rest));
  assert.equal((await prisma.smsMessage.findUniqueOrThrow({ where: { id: rest.ok ? rest.value.smsId : "" } })).text, "Natanggap: P2,900. Bayad na po lahat ng utang. Salamat po!");
  assert.equal(await balance(fx.customerId), 0);
});

test("M6: a failed text never blocks a sale — it rests as FAILED and Ipadala ulit sends it", async () => {
  const fx = await fixture();
  const failing = new FailingProvider();
  setSmsProviderForTests(failing);
  const sale = await sellUtang(fx, 1);
  assert.equal(sale.ok && sale.value.status, "COMPLETED", msg(sale));
  if (!sale.ok) return;
  assert.equal((await level(fx, fx.s1)).quantityOnHand, 9, "the sale went through");
  const sms = await prisma.smsMessage.findFirstOrThrow({ where: { storeId: fx.storeId, documentId: sale.value.orderId } });
  for (let i = 0; i < 3; i++) assert.equal((await deliverSms(sms.id, failing)).status, "FAILED");
  const failed = await prisma.smsMessage.findUniqueOrThrow({ where: { id: sms.id } });
  assert.deepEqual([failed.status, failed.attempts, failed.lastError], ["FAILED", 3, "Walang load (test)"]);
  const ok = await resendSms(fx.storeId, sms.id, new MockSmsProvider());
  assert.equal(ok.ok && ok.value.status, "SENT", msg(ok));
  const twice = await resendSms(fx.storeId, sms.id, new MockSmsProvider());
  assert.equal(twice.ok, false, "a sent text is not sent again");

  // No mobile number: the text is SKIPPED (recorded), the sale still completes.
  const noPhone = await fixture({ phone: null });
  const s2 = await sellUtang(noPhone, 1);
  assert.equal(s2.ok && s2.value.status === "COMPLETED" && s2.value.smsStatus, "SKIPPED", msg(s2));
});

test("M6: utang over the limit waits for the owner — the rice is held; approve posts it, decline frees it", async () => {
  const fx = await fixture({ limit: 200_000 });
  setSmsProviderForTests(new MockSmsProvider());
  const ok = await sellUtang(fx, 1); // 1,300 of 2,000
  assert.equal(ok.ok && ok.value.status, "COMPLETED", msg(ok));
  const over = await sellUtang(fx, 1); // → 2,600 > 2,000
  assert.equal(over.ok, true, msg(over));
  if (!over.ok) return;
  assert.equal(over.value.status, "WAITING_OWNER");
  assert.ok(over.value.approvalId);
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 9, quantityReserved: 1 }, "held, not sold");
  assert.equal(await balance(fx.customerId), 130_000, "no utang posted yet");
  const appr = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: over.value.approvalId! } });
  assert.match(appr.summary, /lampas ₱600/);
  // The held sack cannot be sold to someone else meanwhile.
  const cash = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 9 }], payment: { method: "cash" } });
  assert.equal(cash.ok, false, "only 8 are free");

  const people = new PeopleService();
  const staffTry = await people.decideApproval(fx.storeId, appr.id, fx.staff1, { decision: "APPROVE", pin: PIN });
  assert.equal(staffTry.ok, false, "only the owner decides");
  const yes = await people.decideApproval(fx.storeId, appr.id, fx.owner, { decision: "APPROVE", pin: PIN });
  assert.equal(yes.ok, true, msg(yes));
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 8, quantityReserved: 0 });
  assert.equal(await balance(fx.customerId), 260_000, "posted past the limit, with the owner's approval");
  const o = await prisma.order.findUniqueOrThrow({ where: { id: over.value.orderId } });
  assert.deepEqual([o.status, o.source], ["COMPLETED", "pos"]);
  const text = await prisma.smsMessage.findFirstOrThrow({ where: { storeId: fx.storeId, documentId: o.id } });
  assert.match(text.text, /Kabuuang utang: P2,600\.$/);

  const again = await sellUtang(fx, 1);
  assert.equal(again.ok && again.value.status, "WAITING_OWNER", msg(again));
  const no = await people.decideApproval(fx.storeId, again.ok ? again.value.approvalId! : "", fx.owner, { decision: "DECLINE", pin: PIN, note: "Bayaran muna" });
  assert.equal(no.ok, true, msg(no));
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 8, quantityReserved: 0 }, "the hold is gone, nothing sold");
  assert.equal(await balance(fx.customerId), 260_000);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: again.ok ? again.value.orderId : "" } })).status, "CANCELLED");

  const noLimit = await fixture({ limit: 0 });
  const refused = await sellUtang(noLimit, 1);
  assert.equal(refused.ok, false);
  assert.match(msg(refused), /Wala pang utang limit/);
});

test("M6: Bayad sa utang — no overpaying, racing payments never go below zero, staff only at their store", async () => {
  const fx = await fixture();
  setSmsProviderForTests(new MockSmsProvider());
  assert.equal((await sellUtang(fx, 1)).ok, true);
  const over = await utang.collect(fx.storeId, fx.staff1, { customerId: fx.customerId, amountMinor: 130_001, method: "cash", signatures: staffSig });
  assert.match(msg(over), /Sobra — ₱1,300 lang/);
  const noSig = await utang.collect(fx.storeId, fx.staff1, { customerId: fx.customerId, amountMinor: 10_000, method: "cash" });
  assert.match(msg(noSig), /Kulang ang pirma/);
  const away = await utang.collect(fx.storeId, fx.staff2, { customerId: fx.customerId, amountMinor: 10_000, method: "cash", locationId: fx.s1, signatures: staffSig });
  assert.equal(away.ok, false, "Store 2 staff cannot take money at Store 1");

  const [a, b] = await Promise.all([
    utang.collect(fx.storeId, fx.staff1, { customerId: fx.customerId, amountMinor: 100_000, method: "cash", signatures: staffSig }),
    utang.collect(fx.storeId, fx.staff1, { customerId: fx.customerId, amountMinor: 100_000, method: "cash", signatures: staffSig }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "only one of two ₱1,000 payments fits a ₱1,300 balance");
  assert.equal(await balance(fx.customerId), 30_000);
  assert.equal(await prisma.payment.count({ where: { storeId: fx.storeId, type: "payment", orderId: null } }), 1);
});

test("M6: reminders go out once per period, only to customers who owe, and can be switched off", async () => {
  const fx = await fixture();
  setSmsProviderForTests(new MockSmsProvider());
  assert.equal((await sellUtang(fx, 1)).ok, true);
  // Make the utang 40 days old.
  await prisma.creditEntry.updateMany({ where: { storeCustomerId: fx.customerId }, data: { createdAt: new Date(Date.now() - 40 * 86_400_000) } });
  const firstOfMonth = new Date("2026-11-02T02:00:00Z"); // 10 am, 2 Nov, Manila
  const r1 = await utang.runReminders(fx.storeId, firstOfMonth);
  assert.deepEqual(r1, { monthly: 1, overdue: 1 });
  const r2 = await utang.runReminders(fx.storeId, new Date(firstOfMonth.getTime() + 3_600_000));
  assert.deepEqual(r2, { monthly: 0, overdue: 0 }, "an hour later: nothing new");
  const monthly = await prisma.smsMessage.findFirstOrThrow({ where: { storeId: fx.storeId, template: "utang_monthly" } });
  assert.match(monthly.text, /hanggang 2 Nob: P1,300/);
  const midMonth = await utang.runReminders(fx.storeId, new Date("2026-11-20T02:00:00Z"));
  assert.equal(midMonth.monthly, 0, "the monthly text is for the first days only");
  assert.equal(midMonth.overdue, 1, "a new week, a new overdue reminder");

  const off = await utang.updateSettings(fx.storeId, fx.owner, { utangSmsEnabled: false });
  assert.equal(off.ok, true, msg(off));
  assert.deepEqual(await utang.runReminders(fx.storeId, new Date("2026-12-01T02:00:00Z")), { monthly: 0, overdue: 0 });
  const staffOff = await utang.updateSettings(fx.storeId, fx.staff1, { utangSmsEnabled: true });
  assert.equal(staffOff.ok, false, "staff cannot switch texts on or off");
});

test("M6: returned rice on an utang sale reduces the utang once the owner approves", async () => {
  const fx = await fixture();
  setSmsProviderForTests(new MockSmsProvider());
  const sale = await sellUtang(fx, 2);
  assert.equal(sale.ok, true, msg(sale));
  if (!sale.ok) return;
  assert.equal(await balance(fx.customerId), 260_000);
  const flow = new TransferFlowService();
  const ret = await flow.createReturn(fx.storeId, fx.staff1, { locationId: fx.s1, productId: fx.sin25.id, quantity: 1, condition: "GOOD", orderId: sale.value.orderId, reason: "basa ang sako", signatures: staffSig });
  assert.equal(ret.ok, true, msg(ret));
  if (!ret.ok) return;
  const people = new PeopleService();
  const yes = await people.decideApproval(fx.storeId, ret.value.approvalId, fx.owner, { decision: "APPROVE", pin: PIN });
  assert.equal(yes.ok, true, msg(yes));
  assert.equal(await balance(fx.customerId), 130_000, "one sack's worth taken off the utang");
  const adj = await prisma.creditEntry.findFirstOrThrow({ where: { storeCustomerId: fx.customerId, type: "adjustment" } });
  assert.equal(adj.amountMinor, -130_000);
  assert.match((await prisma.smsMessage.findFirstOrThrow({ where: { storeId: fx.storeId, template: "utang_adjust" } })).text, /Natitirang utang: P1,300/);
});

test("M6: the customer list — staff add, only the owner sets limits, another store sees nothing", async () => {
  const fx = await fixture();
  const other = await fixture();
  // A fresh random mobile that no real customer has (the Customer table is shared).
  let digits = "";
  do digits = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
  while (await prisma.customer.findFirst({ where: { phone: `+63918${digits}` } }));
  const added = await utang.addCustomer(fx.storeId, fx.staff1, { name: "Maria Santos", phone: `0918 ${digits.slice(0, 3)} ${digits.slice(3)}` });
  assert.equal(added.ok, true, msg(added));
  if (!added.ok) return;
  customerIds.push((await prisma.storeCustomer.findUniqueOrThrow({ where: { id: added.value.id } })).customerId);
  assert.deepEqual([added.value.phone, added.value.creditApproved], [`+63918${digits}`, false]);
  const staffLimit = await utang.addCustomer(fx.storeId, fx.staff1, { name: "Pedro", phone: phoneFor(), limitMinor: 100_000 });
  assert.equal(staffLimit.ok, false, "staff cannot set a limit");
  const dupe = await utang.addCustomer(fx.storeId, fx.staff1, { name: "Maria S.", phone: `+63 918 ${digits.slice(0, 3)} ${digits.slice(3)}` });
  assert.match(msg(dupe), /Nasa listahan na/);
  const bad = await utang.addCustomer(fx.storeId, fx.staff1, { name: "Ana", phone: "12345" });
  assert.equal(bad.ok, false);
  assert.equal((await utang.setLimit(fx.storeId, fx.staff1, added.value.id, 100_000)).ok, false);
  const lim = await utang.setLimit(fx.storeId, fx.owner, added.value.id, 100_000);
  assert.equal(lim.ok && lim.value.creditApproved, true, msg(lim));
  assert.equal((await utang.setLimit(other.storeId, other.owner, added.value.id, 1)).ok, false, "another store cannot touch this customer");
  const list = await utang.customers(other.storeId);
  assert.equal(list.some((c) => c.id === added.value.id), false);
  const mine = await utang.customers(fx.storeId, { search: "maria" });
  assert.deepEqual(mine.map((c) => [c.name, c.limitMinor]), [["Maria Santos", 100_000]]);
});

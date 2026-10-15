// Rice Ops M7 — Order ng agent, against the real DB. Proves the M7 "done when" list:
//   * the agent sees each status change (Naghihintay → Aprubado → Nasa daan → Naihatid → Bayad na);
//   * an agent can't approve.
// Plus: decline with a reason the agent sees; approval holds the rice where it comes from
// (another location too); staff approve only at their store; pay for what was delivered
// (a partial delivery raises no refund); utang needs a limit; one order per key; isolation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { AgentOrderService } from "./agent-order.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import type { Actor, SignatureInput } from "../people/people.service.js";
import { setSmsProviderForTests, MockSmsProvider } from "../sms/sms.provider.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `M7R${Date.now()}${Math.floor(Math.random() * 1000)}`;
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
    await prisma.smsMessage.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
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

async function freshPhone(): Promise<string> {
  for (;;) {
    const d = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
    if (!(await prisma.customer.findFirst({ where: { phone: `+63919${d}` } }))) return `0919${d}`;
  }
}

async function fixture() {
  seq += 1;
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `M7 ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const wh = await prisma.warehouse.create({ data: { storeId: store.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" } });
  const sin25 = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-S25`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 110_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "Bigas" } });
  for (const [w, q] of [[s1.id, 2], [s2.id, 5], [wh.id, 20]] as const) await prisma.stockLevel.create({ data: { storeId: store.id, productId: sin25.id, warehouseId: w, quantityOnHand: q } });
  const kargador = await prisma.kargador.create({ data: { storeId: store.id, name: "Mang Boy" } });
  const mk = async (name: string, role: "OWNER" | "STAFF" | "SALES_AGENT", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@m7.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : role } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  return {
    storeId: store.id, s1: s1.id, s2: s2.id, wh: wh.id, sin25, kargadorId: kargador.id,
    agent: await mk("Agent Carlo", "SALES_AGENT", null), staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id),
    whStaff: await mk("Kuya Jun", "STAFF", wh.id), owner: await mk("Aling Nena", "OWNER", null),
  };
}

const svc = new AgentOrderService();
const flow = new TransferFlowService();
const key = () => `agent-${randomBytes(8).toString("hex")}`;
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const sigs = (kargadorId: string): SignatureInput[] => [{ signerKind: "STAFF", imagePng: PNG }, { signerKind: "KARGADOR", kargadorId, imagePng: PNG }];
const level = async (fx: { storeId: string; sin25: { id: string } }, w: string) =>
  prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId, productId: fx.sin25.id, warehouseId: w }, select: { quantityOnHand: true, quantityReserved: true } });
async function order(fx: Awaited<ReturnType<typeof fixture>>, qty = 2) {
  const phone = await freshPhone();
  const r = await svc.create(fx.storeId, fx.agent, { idempotencyKey: key(), locationId: fx.s1, customerName: "Rosa Lim", customerPhone: phone, address: "Purok 3, Brgy. San Isidro", lines: [{ productId: fx.sin25.id, quantity: qty }] });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) throw new Error("order failed");
  const sc = await prisma.storeCustomer.findFirstOrThrow({ where: { storeId: fx.storeId, customer: { phone: `+63${phone.slice(1)}` } }, select: { customerId: true, id: true } });
  customerIds.push(sc.customerId);
  return { ...r.value, storeCustomerId: sc.id };
}
const statusOf = async (fx: { storeId: string; agent: Actor }, id: string) => (await svc.mine(fx.storeId, fx.agent)).find((o) => o.id === id)?.status;

test("M7: the agent sees each status change — Naghihintay → Aprubado → Nasa daan → Naihatid → Bayad na", async () => {
  const fx = await fixture();
  const o = await order(fx, 2);
  assert.equal(o.status, "NAGHIHINTAY");
  assert.equal(o.totalMinor, 260_000);
  assert.equal(await statusOf(fx, o.id), "NAGHIHINTAY");
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 2, quantityReserved: 0 }, "nothing held until the store approves");

  const ok = await svc.approve(fx.storeId, fx.staff1, o.id, {});
  assert.equal(ok.ok, true, msg(ok));
  assert.equal(await statusOf(fx, o.id), "APRUBADO");
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 2, quantityReserved: 2 }, "held at Store 1");
  const tripId = ok.ok ? ok.value.releases[0]!.id : "";

  const rel = await flow.release(fx.storeId, fx.staff1, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) });
  assert.equal(rel.ok, true, msg(rel));
  assert.equal(await statusOf(fx, o.id), "NAILABAS");
  const early = await svc.pay(fx.storeId, fx.staff1, o.id, { method: "cash" });
  assert.match(msg(early), /Hindi pa naihahatid/);

  const del = await flow.deliver(fx.storeId, fx.staff1, tripId, { quantity: 2, signatures: [...sigs(fx.kargadorId), { signerKind: "CUSTOMER", signerName: "Rosa", imagePng: PNG }] });
  assert.equal(del.ok, true, msg(del));
  assert.equal(await statusOf(fx, o.id), "NAIHATID");
  const paid = await svc.pay(fx.storeId, fx.staff1, o.id, { method: "cash", tenderedMinor: 300_000 });
  assert.equal(paid.ok, true, msg(paid));
  assert.equal(paid.ok && paid.value.changeMinor, 40_000);
  assert.equal(await statusOf(fx, o.id), "BAYAD_NA");
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 0, quantityReserved: 0 });
  const twice = await svc.pay(fx.storeId, fx.staff1, o.id, { method: "cash" });
  assert.equal(twice.ok, false, "paid once");
});

test("M7: an agent can't approve, decline or take payment; another agent can't see the order", async () => {
  const fx = await fixture();
  const o = await order(fx);
  const a = await svc.approve(fx.storeId, fx.agent, o.id, {});
  assert.equal(a.ok, false);
  assert.equal(!a.ok && a.error.type, "forbidden");
  assert.equal((await svc.decline(fx.storeId, fx.agent, o.id, "ayaw ko")).ok, false);
  assert.equal((await svc.pay(fx.storeId, fx.agent, o.id, { method: "cash" })).ok, false);
  assert.equal((await svc.forStore(fx.storeId, fx.agent, "waiting")).length, 0, "the store list is not for agents");
  const other = { ...fx.agent, userId: fx.staff2.userId };
  assert.equal((await svc.mine(fx.storeId, other)).some((x) => x.id === o.id), false, "Mga order ko shows only my orders");
  assert.equal(await statusOf(fx, o.id), "NAGHIHINTAY", "still waiting — nothing moved");
});

test("M7: Tanggihan — the agent sees why; only staff at the preferred store decide", async () => {
  const fx = await fixture();
  const o = await order(fx);
  const away = await svc.approve(fx.storeId, fx.staff2, o.id, {});
  assert.equal(away.ok, false, "Store 2 staff cannot decide Store 1's orders");
  assert.match(msg(await svc.decline(fx.storeId, fx.staff1, o.id, "")), /dahilan/);
  const no = await svc.decline(fx.storeId, fx.staff1, o.id, "Wala nang stock ngayong araw");
  assert.equal(no.ok, true, msg(no));
  const mine = (await svc.mine(fx.storeId, fx.agent)).find((x) => x.id === o.id)!;
  assert.deepEqual([mine.status, mine.declineReason], ["TINANGGIHAN", "Wala nang stock ngayong araw"]);
  assert.equal((await svc.approve(fx.storeId, fx.staff1, o.id, {})).ok, false, "decided once");
});

test("M7: approval can take the rice from the warehouse; short stock says where it is", async () => {
  const fx = await fixture();
  const big = await order(fx, 6); // Store 1 has 2
  const short = await svc.approve(fx.storeId, fx.staff1, big.id, {});
  assert.equal(short.ok, false);
  assert.match(msg(short), /2 na lang .* sa Store 1\. Bawasan, o kunin sa Warehouse \(may 20\)/);
  assert.equal((await svc.mine(fx.storeId, fx.agent)).find((x) => x.id === big.id)?.status, "NAGHIHINTAY", "a failed approval changes nothing");
  const item = big.lines[0]!;
  const fromWh = await svc.approve(fx.storeId, fx.staff1, big.id, { sources: [{ itemId: item.id, sourceLocationId: fx.wh }] });
  assert.equal(fromWh.ok, true, msg(fromWh));
  assert.deepEqual(await level(fx, fx.wh), { quantityOnHand: 20, quantityReserved: 6 }, "held at the warehouse");
  // It is on the warehouse's Ilabas list, not Store 1's.
  assert.equal((await flow.list(fx.storeId, fx.whStaff, "ilabas")).some((t) => t.id === (fromWh.ok ? fromWh.value.releases[0]!.id : "")), true);
});

test("M7: the customer pays for what was delivered — a partial delivery raises no refund", async () => {
  const fx = await fixture();
  setSmsProviderForTests(new MockSmsProvider());
  const o = await order(fx, 2);
  const ok = await svc.approve(fx.storeId, fx.staff1, o.id, {});
  const tripId = ok.ok ? ok.value.releases[0]!.id : "";
  assert.equal((await flow.release(fx.storeId, fx.staff1, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) })).ok, true);
  const del = await flow.deliver(fx.storeId, fx.staff1, tripId, { quantity: 1, note: "isang sako lang ang kinuha", signatures: sigs(fx.kargadorId) });
  assert.equal(del.ok, true, msg(del));
  assert.equal(await prisma.approvalRequest.count({ where: { storeId: fx.storeId, kind: "REFUND" } }), 0, "nothing was paid, so nothing to refund");
  // Utang needs a limit first.
  const noLimit = await svc.pay(fx.storeId, fx.staff1, o.id, { method: "utang", signatures: [{ signerKind: "CUSTOMER", signerName: "Rosa", imagePng: PNG }] });
  assert.match(msg(noLimit), /Wala pang utang limit/);
  await prisma.storeCustomer.update({ where: { id: o.storeCustomerId }, data: { creditApproved: true, creditLimitMinor: 500_000 } });
  const paid = await svc.pay(fx.storeId, fx.staff1, o.id, { method: "utang", signatures: [{ signerKind: "CUSTOMER", signerName: "Rosa", imagePng: PNG }] });
  assert.equal(paid.ok, true, msg(paid));
  assert.equal(paid.ok && paid.value.dueMinor, 130_000, "one sack delivered, one sack charged");
  assert.equal((await prisma.storeCustomer.findUniqueOrThrow({ where: { id: o.storeCustomerId } })).creditBalanceMinor, 130_000);
  assert.match((await prisma.smsMessage.findFirstOrThrow({ where: { storeId: fx.storeId, documentId: o.id } })).text, /Utang ngayon: P1,300 .*Kabuuang utang: P1,300/);
});

test("M7: one order per key — a double-tap by the agent makes one order", async () => {
  const fx = await fixture();
  const phone = await freshPhone();
  const cust = await prisma.customer.create({ data: { name: "Ben Cruz", phone: `+63${phone.slice(1)}`, email: null, passwordHash: null } });
  customerIds.push(cust.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: fx.storeId, customerId: cust.id } });
  const body = { idempotencyKey: key(), locationId: fx.s1, customerId: sc.id, address: "Sitio Uno, Brgy. Dos", lines: [{ productId: fx.sin25.id, quantity: 1 }] };
  const [a, b] = await Promise.all([svc.create(fx.storeId, fx.agent, body), svc.create(fx.storeId, fx.agent, body)]);
  assert.equal(a.ok && b.ok && a.value.id === b.value.id, true, `${msg(a)} ${msg(b)}`);
  assert.equal(await prisma.order.count({ where: { storeId: fx.storeId, source: "AGENT" } }), 1);
  const bad = await svc.create(fx.storeId, fx.agent, { ...body, idempotencyKey: key(), locationId: fx.wh });
  assert.match(msg(bad), /tindahan/, "the preferred place must be a store, not the warehouse");
});

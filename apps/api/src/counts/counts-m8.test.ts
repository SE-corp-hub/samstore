// Rice Ops M8 — counts, balance and write-offs, against the real DB. Proves the M8 "done when":
//   * the balance formula matches the ledger for every item in a test count.
// Plus: blind counting (staff never see the system's numbers), a sale during the count is
// not a false kulang, the owner approves before anything posts (decline posts nothing),
// the zero check (quick count) posts at once and lets the sale go through, the closing
// top-5, write-offs (over 1% → owner; the stock moves; signatures; never below holds).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { CountService } from "./count.service.js";
import { BentaService } from "../selling/benta.service.js";
import { PeopleService, type Actor, type SignatureInput } from "../people/people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `M8R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;
const PIN = "2580";

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.stockCountLine.deleteMany({ where });
    await prisma.stockCount.deleteMany({ where });
    await prisma.stockWriteOff.deleteMany({ where });
    await prisma.stockInLine.deleteMany({ where });
    await prisma.stockIn.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    if (orderIds.length) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.payment.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
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

const staffSig: SignatureInput[] = [{ signerKind: "STAFF", imagePng: PNG }];
const svc = new CountService();
const benta = new BentaService();
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const key = () => `tap-${randomBytes(8).toString("hex")}`;

/** Stock arrives through the ledger (Manual na pasok), so the balance can be checked against it. */
async function fixture() {
  seq += 1;
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `M8 ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const mkP = (sku: string, name: string, grams: number, price: number, cost: number) =>
    prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-${sku}`, name, priceMinor: price, costMinor: cost, stockBaseUnit: "g", stockBaseQuantity: grams, stockConversionFamily: "Bigas", soldByWeight: grams === 1 } });
  const sin25 = await mkP("S25", "Sinandomeng 25 kg", 25_000, 130_000, 110_000);
  const din25 = await mkP("D25", "Dinorado 25 kg", 25_000, 160_000, 140_000);
  const loose = await mkP("SK", "Sinandomeng (per kilo)", 1, 5_200, 4_600);
  const pinHash = bcrypt.hashSync(PIN, 4);
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@m8.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF", pinHash } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  const fx = {
    storeId: store.id, s1: s1.id, s2: s2.id, sin25, din25, loose,
    staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id), owner: await mk("Aling Nena", "OWNER", null),
  };
  const r = await benta.stockIn(fx.storeId, fx.staff1, { locationId: fx.s1, lines: [{ productId: sin25.id, quantity: 10 }, { productId: din25.id, quantity: 4 }, { productId: loose.id, quantity: 50_000 }], signatures: staffSig });
  assert.equal(r.ok, true, msg(r));
  return fx;
}
const onHand = async (fx: { storeId: string; s1: string }, productId: string, w = fx.s1) =>
  (await prisma.stockLevel.findFirst({ where: { storeId: fx.storeId, productId, warehouseId: w } }))?.quantityOnHand ?? 0;

test("M8: the balance formula matches the ledger for every item in a test count (blind, owner-approved, sales during the count)", async () => {
  const fx = await fixture();
  // Before any count the balance is the ledger since the beginning — and it matches.
  const before = await svc.balance(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(before.ok && before.value.items.every((i) => i.matches), true, msg(before));

  assert.equal((await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1 })).ok, false, "staff cannot start a count");
  const started = await svc.start(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(started.ok, true, msg(started));
  if (!started.ok) return;
  assert.match(started.value.docNumber, /^CNT-\d{6}$/);
  assert.equal(started.value.lines, 3);

  // Blind: staff see the items, not the system's numbers.
  const blind = await svc.get(fx.storeId, fx.staff1, started.value.id);
  assert.equal(blind.ok, true);
  if (!blind.ok) return;
  assert.equal(blind.value.blindHidden, true);
  assert.equal(blind.value.lines.some((l) => "expectedQty" in l), false);

  // Count: sin25 9 (kulang 1), din25 4 (tama), loose 50.4 kg (sobra 400 g).
  assert.equal((await svc.record(fx.storeId, fx.staff1, started.value.id, [{ productId: fx.sin25.id, counted: 9 }])).ok, true);
  // A sale AFTER sin25 was counted: it must not show up as kulang.
  const sale = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 2 }], payment: { method: "cash" } });
  assert.equal(sale.ok, true, msg(sale));
  assert.equal((await svc.record(fx.storeId, fx.staff1, started.value.id, [{ productId: fx.din25.id, counted: 4 }, { productId: fx.loose.id, counted: "50.4" }])).ok, true);

  assert.match(msg(await svc.submit(fx.storeId, fx.staff1, started.value.id, [])), /Missing signature/);
  const sub = await svc.submit(fx.storeId, fx.staff1, started.value.id, staffSig);
  assert.equal(sub.ok, true, msg(sub));
  if (!sub.ok) return;
  assert.equal(sub.value.status, "SUBMITTED");
  assert.deepEqual([sub.value.kulangValueMinor, sub.value.sobraValueMinor], [110_000, 1_840], "1 sack short at cost; 400 g over at ₱46/kg");
  assert.equal(await onHand(fx, fx.sin25.id), 8, "nothing posts before the owner approves (10 − 2 sold)");

  const people = new PeopleService();
  const yes = await people.decideApproval(fx.storeId, sub.value.approvalId!, fx.owner, { decision: "APPROVE", pin: PIN });
  assert.equal(yes.ok, true, msg(yes));
  assert.equal(await onHand(fx, fx.sin25.id), 7, "9 counted − 2 sold after = 7: only the real kulang posted");
  assert.equal(await onHand(fx, fx.din25.id), 4);
  assert.equal(await onHand(fx, fx.loose.id), 50_400);
  const posted = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, documentType: "COUNT", documentId: started.value.id }, select: { productId: true, delta: true, type: true } });
  assert.deepEqual(posted.map((m) => `${m.type}${m.delta}`).sort(), ["COUNT_ADJUST-1", "COUNT_ADJUST400"]);

  // The balance: expected = the count + every movement since = the shelf, for EVERY item.
  const sell2 = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.loose.id, kilos: "1.5" }], payment: { method: "cash" } });
  assert.equal(sell2.ok, true, msg(sell2));
  const bal = await svc.balance(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(bal.ok, true, msg(bal));
  if (!bal.ok) return;
  for (const i of bal.value.items) {
    assert.equal(i.matches, true, `${i.name}: expected ${i.expected}, shelf ${i.onHand}`);
    assert.equal(i.lastCount?.docNumber, started.value.docNumber);
  }
  const sin = bal.value.items.find((i) => i.productId === fx.sin25.id)!;
  assert.deepEqual([sin.lastCount?.countedQty, sin.buckets.nabenta, sin.expected], [9, -2, 7], "counted 9, then the 2 sold during the count");
  const lo = bal.value.items.find((i) => i.productId === fx.loose.id)!;
  assert.deepEqual([lo.lastCount?.countedQty, lo.buckets.nabenta, lo.expected], [50_400, -1_500, 48_900]);
  // After the count, the owner sees the numbers.
  const open = await svc.get(fx.storeId, fx.staff1, started.value.id);
  assert.equal(open.ok && open.value.lines.find((l) => l.productId === fx.sin25.id)?.verdict, "KULANG");
});

test("M8: a declined count posts nothing; staff count only at their location; every line must be counted", async () => {
  const fx = await fixture();
  const c = await svc.start(fx.storeId, fx.owner, { locationId: fx.s1, productIds: [fx.sin25.id, fx.din25.id] });
  assert.equal(c.ok, true, msg(c));
  if (!c.ok) return;
  assert.equal((await svc.start(fx.storeId, fx.owner, { locationId: fx.s1 })).ok, false, "one open count per location");
  assert.equal((await svc.record(fx.storeId, fx.staff2, c.value.id, [{ productId: fx.sin25.id, counted: 1 }])).ok, false, "Store 2 staff cannot count Store 1");
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, counted: 5 }])).ok, true);
  assert.match(msg(await svc.submit(fx.storeId, fx.staff1, c.value.id, staffSig)), /Not counted yet: Dinorado/);
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.din25.id, counted: 4 }])).ok, true);
  const sub = await svc.submit(fx.storeId, fx.staff1, c.value.id, staffSig);
  assert.equal(sub.ok, true, msg(sub));
  const no = await new PeopleService().decideApproval(fx.storeId, sub.ok ? sub.value.approvalId! : "", fx.owner, { decision: "DECLINE", pin: PIN, note: "Bilangin ulit bukas" });
  assert.equal(no.ok, true, msg(no));
  assert.equal(await onHand(fx, fx.sin25.id), 10, "declined: the 5 'kulang' never posted");
  assert.equal((await prisma.stockCount.findUniqueOrThrow({ where: { id: c.value.id } })).status, "CANCELLED");
});

test("M8: the zero check — a sale that empties the shelf asks; a quick count posts at once and the sale goes through", async () => {
  const fx = await fixture();
  const sold = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.din25.id, quantity: 4 }], payment: { method: "cash" } });
  assert.equal(sold.ok, true, msg(sold));
  assert.deepEqual(sold.ok ? sold.value.zeroCheck.map((z) => z.name) : [], ["Dinorado 25 kg"], "May natira pa ba?");
  const blocked = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.din25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(blocked.ok, false);
  // There are actually 2 sacks behind the counter.
  assert.match(msg(await svc.quick(fx.storeId, fx.staff1, { productId: fx.din25.id, counted: 2 })), /Missing signature/);
  const q = await svc.quick(fx.storeId, fx.staff1, { productId: fx.din25.id, counted: 2, signatures: staffSig });
  assert.equal(q.ok, true, msg(q));
  assert.deepEqual(q.ok ? [q.value.expectedQty, q.value.countedQty, q.value.verdict] : [], [0, 2, "SOBRA"]);
  assert.equal(await onHand(fx, fx.din25.id), 2, "posted at once");
  const now = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.din25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(now.ok, true, msg(now));
  const bal = await svc.balance(fx.storeId, fx.owner, { locationId: fx.s1, productId: fx.din25.id });
  assert.equal(bal.ok && bal.value.items[0]!.matches && bal.value.items[0]!.expected, 1);
});

test("M8: the closing top-5 count posts on submit (no waiting)", async () => {
  const fx = await fixture();
  assert.equal((await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" } })).ok, true);
  const c = await svc.startClosing(fx.storeId, fx.staff1, {});
  assert.equal(c.ok, true, msg(c));
  if (!c.ok) return;
  assert.equal(c.value.lines, 3, "the sold item first, then the fullest shelves (only 3 items here)");
  const lines = await prisma.stockCountLine.findMany({ where: { countId: c.value.id }, select: { productId: true } });
  const counted = lines.map((l) => ({ productId: l.productId, counted: l.productId === fx.loose.id ? "49.9" : l.productId === fx.sin25.id ? 9 : 4 }));
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, counted)).ok, true);
  const sub = await svc.submit(fx.storeId, fx.staff1, c.value.id, staffSig);
  assert.equal(sub.ok && sub.value.status, "APPROVED", msg(sub));
  assert.equal(await onHand(fx, fx.loose.id), 49_900, "100 g kulang posted at closing");
});

test("M8: Manual na bawas — reason and signature; the stock moves; over 1% goes to the owner; never more than is free", async () => {
  const fx = await fixture();
  assert.match(msg(await svc.writeOff(fx.storeId, fx.staff1, { productId: fx.loose.id, kilos: "0.4", reason: "TAPON" })), /Missing signature/);
  const small = await svc.writeOff(fx.storeId, fx.staff1, { productId: fx.loose.id, kilos: "0.4", reason: "TAPON", signatures: staffSig });
  assert.equal(small.ok, true, msg(small));
  assert.deepEqual(small.ok ? [small.value.quantity, small.value.lossBp, small.value.needsApproval, small.value.valueMinor] : [], [400, 80, false, 1_840], "0.8% of 50 kg — no owner needed");
  assert.equal(await onHand(fx, fx.loose.id), 49_600);
  const photo = Buffer.alloc(600, 3); photo[0] = 0xff; photo[1] = 0xd8; photo[2] = 0xff;
  const big = await svc.writeOff(fx.storeId, fx.staff1, { productId: fx.sin25.id, quantity: 2, reason: "BUKBOK", signatures: [...staffSig, { signerKind: "SLIP_PHOTO", imagePng: `data:image/jpeg;base64,${photo.toString("base64")}` }] });
  assert.equal(big.ok, true, msg(big));
  if (!big.ok) return;
  assert.match(big.value.docNumber, /^WO-\d{6}$/);
  assert.equal(big.value.needsApproval, true, "2 of 10 sacks = 20%");
  assert.equal(await onHand(fx, fx.sin25.id), 8, "the stock moves; the owner's approval clears the flag");
  const appr = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: big.value.approvalId! } });
  assert.deepEqual([appr.kind, appr.approverRoles], ["WRITE_OFF", ["OWNER"]]);
  assert.match(appr.summary, /Weevils/);
  assert.match(msg(await svc.writeOff(fx.storeId, fx.staff1, { productId: fx.sin25.id, quantity: 9, reason: "BASA", signatures: staffSig })), /The system shows only 8 here/);
  assert.match(msg(await svc.writeOff(fx.storeId, fx.staff1, { productId: fx.sin25.id, quantity: 1, reason: "IBA", signatures: staffSig })), /Enter the reason/);
  assert.equal((await svc.writeOff(fx.storeId, fx.staff2, { locationId: fx.s1, productId: fx.sin25.id, quantity: 1, reason: "BASA", signatures: staffSig })).ok, false, "Store 2 staff cannot write off Store 1 stock");
  // Held stock (sold from Store 2 out of Store 1, waiting for Ilabas) cannot be written off.
  const held = await benta.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 7, sourceLocationId: fx.s1 }], payment: { method: "cash" } });
  assert.equal(held.ok, true, msg(held));
  assert.match(msg(await svc.writeOff(fx.storeId, fx.staff1, { productId: fx.sin25.id, quantity: 2, reason: "BASA", signatures: staffSig })), /held for a release/);
  const bal = await svc.balance(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(bal.ok && bal.value.items.every((i) => i.matches), true, "write-offs are in the balance (bawas)");
});

// Rice Ops M8 — counts, balance and write-offs, against the real DB. Proves the M8 "done when":
//   * the balance formula matches the ledger for every item in a test count.
// Plus: any role can count (staff at their own store), blind counting (staff never see the
// system's numbers), a sale during the count is not a false kulang, a count posts at once when
// submitted (no owner approval), a list count may leave items uncounted, items with no stock row
// can be counted, the zero check (quick count) posts at once and lets the sale go through, the
// closing top-5, write-offs (over 1% → owner; the stock moves; signatures; never below holds).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { CountService } from "./count.service.js";
import { BentaService } from "../selling/benta.service.js";
import { type Actor, type SignatureInput } from "../people/people.service.js";

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

test("M8: the balance formula matches the ledger for every item in a test count (blind, posts at once, sales during the count)", async () => {
  const fx = await fixture();
  // Before any count the balance is the ledger since the beginning — and it matches.
  const before = await svc.balance(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(before.ok && before.value.items.every((i) => i.matches), true, msg(before));

  const started = await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1 }); // any role can start a count
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

  // Every difference needs a reason ("Don't know" is one of them) before the count can be submitted.
  assert.match(msg(await svc.submit(fx.storeId, fx.staff1, started.value.id, staffSig)), /Choose a reason for/);
  const why = await svc.setReasons(fx.storeId, fx.staff1, started.value.id, [{ productId: fx.sin25.id, reason: "UNRINGED" }, { productId: fx.loose.id, reason: "STOCKIN_MISSING", note: "bought on Monday" }]);
  assert.equal(why.ok, true, msg(why));
  assert.match(msg(await svc.submit(fx.storeId, fx.staff1, started.value.id, [])), /Missing signature/);
  const sub = await svc.submit(fx.storeId, fx.staff1, started.value.id, staffSig);
  assert.equal(sub.ok, true, msg(sub));
  if (!sub.ok) return;
  assert.equal(sub.value.status, "APPROVED", "a count posts at once: no owner approval");
  assert.equal(sub.value.approvalId, null);
  assert.deepEqual([sub.value.kulangValueMinor, sub.value.sobraValueMinor], [110_000, 1_840], "1 sack short at cost; 400 g over at ₱46/kg");
  assert.equal(await onHand(fx, fx.sin25.id), 7, "9 counted − 2 sold after = 7: only the real kulang posted");
  assert.equal((await prisma.approvalRequest.count({ where: { storeId: fx.storeId, kind: "COUNT" } })), 0, "nothing waits in Para sa iyo");
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

test("M8: a list count may leave items uncounted; one open list per person; staff count only at their store; who may cancel", async () => {
  const fx = await fixture();
  const c = await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1, productIds: [fx.sin25.id, fx.din25.id] });
  assert.equal(c.ok, true, msg(c));
  if (!c.ok) return;
  assert.equal((await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1 })).ok, false, "one open list count per person per store");
  assert.equal((await svc.start(fx.storeId, fx.staff2, { locationId: fx.s1 })).ok, false, "Store 2 staff cannot count Store 1");
  const ownerCount = await svc.start(fx.storeId, fx.owner, { locationId: fx.s1, variety: "dinorado" });
  assert.equal(ownerCount.ok, true, `another person can have their own count: ${msg(ownerCount)}`);
  assert.equal((await svc.record(fx.storeId, fx.staff2, c.value.id, [{ productId: fx.sin25.id, counted: 1 }])).ok, false, "Store 2 staff cannot record on Store 1's count");
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, counted: 5 }])).ok, true);
  assert.equal((await svc.setReasons(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, reason: "SPILLED" }])).ok, true);
  const sub = await svc.submit(fx.storeId, fx.staff1, c.value.id, staffSig);
  assert.equal(sub.ok, true, msg(sub));
  assert.deepEqual(sub.ok ? [sub.value.status, sub.value.counted, sub.value.skipped] : [], ["APPROVED", 1, 1], "1 counted, 1 left as it is");
  assert.equal(await onHand(fx, fx.sin25.id), 5, "the counted item posted");
  assert.equal(await onHand(fx, fx.din25.id), 4, "the item that was not counted did not change");
  assert.equal(await prisma.stockCountLine.count({ where: { countId: c.value.id } }), 1, "only what was counted stays on the count");
  assert.match(msg(await svc.submit(fx.storeId, fx.staff1, ownerCount.ok ? ownerCount.value.id : "", staffSig)), /Count at least one item first/);
  // Cancelling: the person who started it, or the owner; nobody else.
  const mineToo = await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1 });
  assert.equal(mineToo.ok, true, msg(mineToo));
  assert.equal((await svc.cancel(fx.storeId, fx.staff1, ownerCount.ok ? ownerCount.value.id : "")).ok, false, "staff cannot cancel the owner's count");
  assert.equal((await svc.cancel(fx.storeId, fx.staff1, mineToo.ok ? mineToo.value.id : "")).ok, true, "the starter can cancel their own");
  assert.equal((await svc.cancel(fx.storeId, fx.owner, ownerCount.ok ? ownerCount.value.id : "")).ok, true, "the owner can cancel any");
  // The quick count and the closing top-5 still have to be counted in full.
  const closing = await svc.startClosing(fx.storeId, fx.staff1, {});
  assert.equal(closing.ok, true, msg(closing));
  if (!closing.ok) return;
  const firstLine = await prisma.stockCountLine.findFirstOrThrow({ where: { countId: closing.value.id }, select: { productId: true } });
  assert.equal((await svc.record(fx.storeId, fx.staff1, closing.value.id, [{ productId: firstLine.productId, counted: firstLine.productId === fx.loose.id ? "50" : 1 }])).ok, true);
  assert.match(msg(await svc.submit(fx.storeId, fx.staff1, closing.value.id, staffSig)), /Not counted yet/);
});

test("M8: every item can be counted (even with no stock row); search list, scopes, system numbers for the owner only", async () => {
  const fx = await fixture();
  const ghost = await prisma.product.create({ data: { storeId: fx.storeId, sku: `${run}-${seq}-G50`, name: "Ghost Rice 50 kg", priceMinor: 250_000, costMinor: 200_000, stockBaseUnit: "g", stockBaseQuantity: 50_000, stockConversionFamily: "Bigas" } });
  const untracked = await prisma.product.create({ data: { storeId: fx.storeId, sku: `${run}-${seq}-UT`, name: "Plastic bag", priceMinor: 100, costMinor: 50, trackStock: false } });
  const archived = await prisma.product.create({ data: { storeId: fx.storeId, sku: `${run}-${seq}-AR`, name: "Old Rice 25 kg", priceMinor: 100, costMinor: 50, isActive: false, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });

  const list = await svc.items(fx.storeId, fx.staff1, { locationId: fx.s1 });
  assert.equal(list.ok, true, msg(list));
  if (!list.ok) return;
  const names = list.value.items.map((i) => i.name);
  assert.equal(names.includes("Ghost Rice 50 kg"), true, "an item with no stock row here is listed");
  assert.equal(names.includes("Plastic bag") || names.includes("Old Rice 25 kg"), false, "untracked and archived items are not listed");
  assert.deepEqual(Object.keys(list.value.items[0]!).sort(), ["barcode", "lastCountedAt", "loose", "name", "productId", "sku", "unitGrams", "variety"], "no quantity and no cost in the search list");
  assert.equal(list.value.items.find((i) => i.productId === fx.loose.id)?.loose, true);
  assert.equal(list.value.items.find((i) => i.productId === fx.sin25.id)?.unitGrams, 25_000);
  assert.equal((await svc.items(fx.storeId, fx.staff2, { locationId: fx.s1 })).ok, false, "Store 2 staff cannot list Store 1");

  // Scopes: one kind of rice, picked items, everything.
  const sin = await svc.start(fx.storeId, fx.owner, { locationId: fx.s1, variety: "Sinandomeng" });
  assert.deepEqual(sin.ok ? sin.value.lines : -1, 2, "the sack and the loose kilos of one kind");
  if (sin.ok) assert.equal((await svc.cancel(fx.storeId, fx.owner, sin.value.id)).ok, true);
  const all = await svc.start(fx.storeId, fx.owner, { locationId: fx.s1, showSystem: true });
  assert.equal(all.ok, true, msg(all));
  if (!all.ok) return;
  assert.equal(all.value.lines, 4, "all 4 active tracked items, the ghost included");
  assert.equal((await prisma.stockCount.findUniqueOrThrow({ where: { id: all.value.id } })).kind, "FULL");
  // The owner asked to see the system numbers; staff still never do.
  const ownerView = await svc.get(fx.storeId, fx.owner, all.value.id);
  assert.equal(ownerView.ok && ownerView.value.lines.find((l) => l.productId === fx.sin25.id)?.systemQty, 10);
  const staffView = await svc.get(fx.storeId, fx.staff1, all.value.id);
  assert.equal(staffView.ok && staffView.value.blindHidden, true);
  assert.equal(staffView.ok && staffView.value.lines.some((l) => "systemQty" in l), false);

  // Two ghost sacks are found on the shelf: the row is created and the count posts at once.
  assert.equal((await svc.record(fx.storeId, fx.owner, all.value.id, [{ productId: ghost.id, counted: 2 }])).ok, true);
  assert.equal((await svc.setReasons(fx.storeId, fx.owner, all.value.id, [{ productId: ghost.id, reason: "STOCKIN_MISSING" }])).ok, true);
  const done = await svc.submit(fx.storeId, fx.owner, all.value.id, staffSig);
  assert.equal(done.ok, true, msg(done));
  assert.equal(await onHand(fx, ghost.id), 2);
  assert.equal(untracked.trackStock, false);
  assert.equal(archived.isActive, false);

  // "Not counted in 14 days": the ghost was counted just now, the other three never were.
  const stale = await svc.start(fx.storeId, fx.owner, { locationId: fx.s1, staleDays: 14 });
  assert.deepEqual(stale.ok ? stale.value.lines : -1, 3);
  if (stale.ok) assert.equal((await svc.cancel(fx.storeId, fx.owner, stale.value.id)).ok, true);
  const after = await svc.items(fx.storeId, fx.staff1, { locationId: fx.s1 });
  assert.equal(after.ok && after.value.items.find((i) => i.productId === ghost.id)?.lastCountedAt !== null, true, "the search list shows it was counted");
  assert.equal((await svc.start(fx.storeId, fx.owner, { locationId: fx.s1, staleDays: 0.5 })).ok, false, "days must be a whole number");
  const bal = await svc.balance(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(bal.ok && bal.value.items.every((i) => i.matches), true, "the ledger still matches the shelf");
});

test("M8: the check step — differences with reasons, count again keeps the first number, a quick count is asked why after it posts", async () => {
  const fx = await fixture();
  const c = await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1 });
  assert.equal(c.ok, true, msg(c));
  if (!c.ok) return;
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, counted: 9 }, { productId: fx.din25.id, counted: 4 }, { productId: fx.loose.id, counted: "50.4" }])).ok, true);
  const chk = await svc.check(fx.storeId, fx.staff1, c.value.id);
  assert.equal(chk.ok, true, msg(chk));
  if (!chk.ok) return;
  assert.deepEqual([chk.value.counted, chk.value.correct, chk.value.notCounted, chk.value.lines.length], [3, 1, 0, 2]);
  assert.deepEqual(chk.value.lines.map((l) => l.name), ["Sinandomeng 25 kg", "Sinandomeng (per kilo)"], "the biggest difference first");
  const sin = chk.value.lines[0]!;
  assert.deepEqual([sin.countedQty, sin.expectedQty, sin.varianceQty, sin.varianceValueMinor, sin.verdict], [9, 10, -1, -110_000, "KULANG"]);
  assert.equal(sin.asksRecount, true, "₱1,100 is over the ₱500 limit: count it again");
  assert.equal(chk.value.lines[1]!.asksRecount, false, "₱18.40 over is small");
  assert.equal(sin.reasons.some((r) => r.code === "UNRINGED"), true);
  assert.equal(sin.reasons.some((r) => r.code === "STOCKIN_MISSING"), false, "a short item is never offered an over reason");
  assert.equal(chk.value.lines[1]!.reasons.some((r) => r.code === "UNKNOWN"), true, "Don't know is always allowed");

  // A reason must fit the direction; a correct item takes none.
  assert.match(msg(await svc.setReasons(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, reason: "STOCKIN_MISSING" }])), /why it is short/);
  assert.match(msg(await svc.setReasons(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.din25.id, reason: "UNKNOWN" }])), /correct/);
  assert.equal((await svc.setReasons(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, reason: "UNRINGED", note: "  sold at   5pm " }])).ok, true);

  // Count again: the first number is kept, the old reason is asked for again.
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, counted: 8 }])).ok, true);
  const again = await svc.check(fx.storeId, fx.staff1, c.value.id);
  const sin2 = again.ok ? again.value.lines.find((l) => l.productId === fx.sin25.id) : undefined;
  assert.deepEqual([sin2?.countedQty, sin2?.firstCountedQty, sin2?.varianceQty, sin2?.reason, sin2?.asksRecount], [8, 9, -2, null, false], "counted again once: no second prompt, and the reason is asked again");
  // …and a count that matches the system drops off the list.
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, counted: 10 }])).ok, true);
  const third = await svc.check(fx.storeId, fx.staff1, c.value.id);
  assert.deepEqual(third.ok ? third.value.lines.map((l) => l.name) : [], ["Sinandomeng (per kilo)"]);
  assert.equal((await prisma.stockCountLine.findFirstOrThrow({ where: { countId: c.value.id, productId: fx.sin25.id } })).firstCountedQty, 9, "still the very first number");
  assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, counted: 8 }])).ok, true);
  assert.equal((await svc.setReasons(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, reason: "SPILLED" }, { productId: fx.loose.id, reason: "SCALE" }])).ok, true);
  assert.equal((await svc.check(fx.storeId, fx.staff2, c.value.id)).ok, false, "Store 2 staff cannot see Store 1's check");
  const sub = await svc.submit(fx.storeId, fx.staff1, c.value.id, staffSig);
  assert.equal(sub.ok, true, msg(sub));
  assert.equal(await onHand(fx, fx.sin25.id), 8);
  assert.equal((await svc.check(fx.storeId, fx.staff1, c.value.id)).ok, false, "the check step is only for an open count");
  const posted = await svc.get(fx.storeId, fx.staff1, c.value.id);
  const gl = posted.ok ? posted.value.lines : [];
  assert.deepEqual([gl.find((l) => l.productId === fx.sin25.id)?.reasonLabel, gl.find((l) => l.productId === fx.loose.id)?.reasonLabel], ["Spilled", "Scale difference"]);
  assert.equal(gl.find((l) => l.productId === fx.sin25.id)?.firstCountedQty, 9);

  // A reason can still be changed after posting (48 hours) by the person who counted, or the owner; nobody else.
  assert.equal((await svc.setReasons(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, reason: "WEEVILS" }])).ok, true);
  assert.equal((await svc.setReasons(fx.storeId, fx.owner, c.value.id, [{ productId: fx.sin25.id, reason: "WET" }])).ok, true);
  assert.equal((await svc.setReasons(fx.storeId, fx.staff2, c.value.id, [{ productId: fx.sin25.id, reason: "WET" }])).ok, false, "Store 2 staff cannot");
  await prisma.stockCount.update({ where: { id: c.value.id }, data: { decidedAt: new Date(Date.now() - 49 * 3_600_000) } });
  assert.match(msg(await svc.setReasons(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, reason: "WEEVILS" }])), /closed/);

  // The one-item count posts at once, then asks why.
  const q = await svc.quick(fx.storeId, fx.staff1, { productId: fx.din25.id, counted: 3, signatures: staffSig });
  assert.equal(q.ok, true, msg(q));
  if (!q.ok) return;
  assert.equal(q.value.reasons.some((r) => r.code === "UNRINGED"), true);
  assert.equal(await onHand(fx, fx.din25.id), 3);
  assert.equal((await svc.setReasons(fx.storeId, fx.staff1, q.value.id, [{ productId: fx.din25.id, reason: "UNRINGED" }])).ok, true);
  const ql = await prisma.stockCountLine.findFirstOrThrow({ where: { countId: q.value.id } });
  assert.equal(ql.reason, "UNRINGED");
});

test("M8: the zero check — a sale that empties the shelf asks; a quick count posts at once and the sale goes through", async () => {
  const fx = await fixture();
  const sold = await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.din25.id, quantity: 4 }], payment: { method: "cash" } });
  assert.equal(sold.ok, true, msg(sold));
  assert.deepEqual(sold.ok ? sold.value.zeroCheck.map((z) => z.name) : [], ["Dinorado 25 kg"], "May natira pa ba?");
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
  // Rice sold from Store 2 out of Store 1 leaves Store 1 at once (no release step), so it cannot be written off either.
  const held = await benta.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 7, sourceLocationId: fx.s1 }], payment: { method: "cash" } });
  assert.equal(held.ok, true, msg(held));
  assert.match(msg(await svc.writeOff(fx.storeId, fx.staff1, { productId: fx.sin25.id, quantity: 2, reason: "BASA", signatures: staffSig })), /The system shows only 1 here/);
  const bal = await svc.balance(fx.storeId, fx.owner, { locationId: fx.s1 });
  assert.equal(bal.ok && bal.value.items.every((i) => i.matches), true, "write-offs are in the balance (bawas)");
});

test("M8: the count report — what moved since the last count, a recorded resack, rice by weight, the period report and the all-stores table", async () => {
  const fx = await fixture();
  const countAll = async (actor: Actor, counted: { sin: number; din: number; loose: string }) => {
    const c = await svc.start(fx.storeId, actor, { locationId: fx.s1 });
    assert.equal(c.ok, true, msg(c));
    if (!c.ok) throw new Error("no count");
    const rec = await svc.record(fx.storeId, actor, c.value.id, [{ productId: fx.sin25.id, counted: counted.sin }, { productId: fx.din25.id, counted: counted.din }, { productId: fx.loose.id, counted: counted.loose }]);
    assert.equal(rec.ok, true, msg(rec));
    return c.value;
  };

  // 1) A count that matches everything: the starting point.
  const c1 = await countAll(fx.staff1, { sin: 10, din: 4, loose: "50" });
  const s1 = await svc.submit(fx.storeId, fx.staff1, c1.id, staffSig);
  assert.equal(s1.ok && [s1.value.kulangValueMinor, s1.value.sobraValueMinor].join(), "0,0", msg(s1));

  // 2) 6 sacks come in and 2 are sold: the records now say 14.
  assert.equal((await benta.stockIn(fx.storeId, fx.staff1, { locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 6 }], signatures: staffSig })).ok, true);
  assert.equal((await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 2 }], payment: { method: "cash" } })).ok, true);

  // 3) One sack was opened and nobody recorded it: 13 sacks and 75 kg loose instead of 14 and 50.
  const c2 = await countAll(fx.staff1, { sin: 13, din: 4, loose: "75" });
  const chk = await svc.check(fx.storeId, fx.staff1, c2.id);
  assert.equal(chk.ok, true, msg(chk));
  if (!chk.ok) return;
  assert.deepEqual(chk.value.lines.map((l) => l.name), ["Sinandomeng (per kilo)", "Sinandomeng 25 kg"]);
  assert.deepEqual(chk.value.openedSacks.map((o) => [o.variety, o.sacks, o.kg, o.unexplainedKg]), [["sinandomeng", 1, 25, 0]], "the check step sees the opened sack");
  assert.equal(chk.value.openedAutomatic, false, "an ordinary store is asked; it is not recorded by itself");
  assert.equal((await svc.setReasons(fx.storeId, fx.staff1, c2.id, [{ productId: fx.sin25.id, reason: "OPENED_SACK" }, { productId: fx.loose.id, reason: "OPENED_SACK" }])).ok, true);
  assert.match(msg(await svc.report(fx.storeId, fx.staff1, c2.id)), /Finish the count first/, "an open count has no report yet");
  const s2 = await svc.submit(fx.storeId, fx.staff1, c2.id, staffSig, ["sinandomeng", "jasmine"]); // a kind that did not change is ignored
  assert.equal(s2.ok, true, msg(s2));
  if (!s2.ok) return;
  assert.deepEqual([s2.value.kulangValueMinor, s2.value.sobraValueMinor], [0, 0], "the opened sack explains both differences: nothing is lost");
  assert.deepEqual([await onHand(fx, fx.sin25.id), await onHand(fx, fx.loose.id)], [13, 75_000]);
  assert.equal((await prisma.stockMovement.count({ where: { storeId: fx.storeId, documentType: "COUNT", documentId: c2.id } })), 0, "nothing was left to adjust");
  assert.equal((await prisma.stockMovement.count({ where: { storeId: fx.storeId, documentType: "COUNT_RESACK", documentId: c2.id } })), 2, "the resack moved the sack and the loose rice");

  const rep = await svc.report(fx.storeId, fx.staff1, c2.id);
  assert.equal(rep.ok, true, msg(rep));
  if (!rep.ok) return;
  const sum = rep.value.summary;
  assert.deepEqual([sum.counted, sum.correct, sum.short, sum.over, sum.explained], [3, 1, 0, 0, 2]);
  assert.deepEqual(rep.value.lines.map((l) => [l.name, l.varianceValueMinor, l.explainedQty !== 0, l.reasonLabel]), [["Sinandomeng (per kilo)", 0, true, "Opened a sack, not recorded"], ["Sinandomeng 25 kg", 0, true, "Opened a sack, not recorded"]]);
  assert.deepEqual(rep.value.openedByCount.map((o) => [o.variety, o.sacks, o.kg, o.automatic]), [["sinandomeng", 1, 25, false]]);
  const since = rep.value.lines.find((l) => l.name === "Sinandomeng 25 kg")?.since;
  assert.deepEqual([since?.from?.docNumber, since?.from?.countedQty, since?.buckets.pumasok, since?.buckets.nabenta, since?.ledgerShouldBe], [c1.docNumber, 10, 6, -2, 14], "last count 10, stock in 6, sold 2: the records said 14");
  const wt = rep.value.weight.find((w) => w.variety === "sinandomeng");
  assert.deepEqual([wt?.countedKg, wt?.systemKg, wt?.diffKg, wt?.complete], [400, 400, 0, true], "sacks and loose rice together: the weight matches");
  assert.equal(rep.value.charge, null);
  assert.equal((await svc.report(fx.storeId, fx.staff2, c2.id)).ok, false, "Store 2 staff cannot open Store 1's report");

  // 4) A real shortage: 12 sacks (spilled) and 3 Dinorado (don't know).
  const c3 = await countAll(fx.staff1, { sin: 12, din: 3, loose: "75" });
  assert.equal((await svc.setReasons(fx.storeId, fx.staff1, c3.id, [{ productId: fx.sin25.id, reason: "SPILLED", note: "torn sack" }, { productId: fx.din25.id, reason: "UNKNOWN" }])).ok, true);
  const s3 = await svc.submit(fx.storeId, fx.staff1, c3.id, staffSig);
  assert.equal(s3.ok && [s3.value.kulangValueMinor, s3.value.sobraValueMinor].join(), "250000,0", msg(s3));
  const rep3 = await svc.report(fx.storeId, fx.owner, c3.id);
  assert.equal(rep3.ok, true, msg(rep3));
  if (!rep3.ok) return;
  assert.deepEqual(rep3.value.lines.map((l) => [l.name, l.varianceValueMinor, l.reasonLabel, l.note]), [["Dinorado 25 kg", -140_000, "Don't know", null], ["Sinandomeng 25 kg", -110_000, "Spilled", "torn sack"]], "the biggest first");
  assert.deepEqual([rep3.value.summary.short, rep3.value.summary.over, rep3.value.summary.explained], [2, 0, 0]);
  assert.equal(rep3.value.lines[1]!.countedBy, "Ate Lorna");
  assert.equal(rep3.value.charge, null, "not a consignment store: nothing is charged");

  // 5) The period report: totals, why, every difference; staff see only their own store.
  const list = await svc.reportList(fx.storeId, fx.owner, {});
  assert.equal(list.ok, true, msg(list));
  if (!list.ok) return;
  assert.deepEqual([list.value.totals.counts, list.value.totals.items, list.value.totals.correct, list.value.totals.short, list.value.totals.over, list.value.totals.kulangValueMinor, list.value.totals.sobraValueMinor], [3, 9, 5, 2, 0, 250_000, 0]);
  const byReason = Object.fromEntries(list.value.byReason.map((r) => [r.code, [r.items, r.shortValueMinor, r.overValueMinor]]));
  assert.deepEqual(byReason, { UNKNOWN: [1, 140_000, 0], SPILLED: [1, 110_000, 0], OPENED_SACK: [2, 0, 0] });
  assert.equal(list.value.differences.length, 4);
  assert.equal(list.value.counts[0]?.docNumber, c3.docNumber, "newest first");
  const mine = await svc.reportList(fx.storeId, fx.staff2, { locationId: fx.s1 });
  assert.equal(mine.ok && mine.value.totals.counts, 0, "Store 2 staff are held to their own store");
  assert.match(msg(await svc.reportList(fx.storeId, fx.owner, { from: "2026-12-31", to: "2026-01-01" })), /after/);
  const none = await svc.reportList(fx.storeId, fx.owner, { from: "2020-01-01", to: "2020-01-31" });
  assert.equal(none.ok && none.value.totals.counts, 0);

  // 6) All stores: owner/manager only; what each store holds and when it was last counted.
  assert.equal((await svc.overview(fx.storeId, fx.staff1)).ok, false);
  const ov = await svc.overview(fx.storeId, fx.owner);
  assert.equal(ov.ok, true, msg(ov));
  if (!ov.ok) return;
  assert.deepEqual(ov.value.locations.map((l) => l.name), ["Store 1", "Store 2"]);
  const cell = ov.value.items.find((i) => i.productId === fx.sin25.id)?.cells[fx.s1];
  assert.equal(cell?.onHand, 12);
  assert.equal(cell?.lastCountedAt instanceof Date, true);
  assert.equal(ov.value.items.find((i) => i.productId === fx.sin25.id)?.cells[fx.s2], undefined, "not held and never counted at Store 2");
});

test("M8: the owner's side — Needs a look, the two limits, today's suggested list and count accuracy", async () => {
  const fx = await fixture();
  const countWith = async (counted: { sin: number; din: number; loose: string }, reasons: { productId: string; reason: string }[] = []) => {
    const c = await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1 });
    assert.equal(c.ok, true, msg(c));
    if (!c.ok) throw new Error("no count");
    assert.equal((await svc.record(fx.storeId, fx.staff1, c.value.id, [{ productId: fx.sin25.id, counted: counted.sin }, { productId: fx.din25.id, counted: counted.din }, { productId: fx.loose.id, counted: counted.loose }])).ok, true);
    if (reasons.length) assert.equal((await svc.setReasons(fx.storeId, fx.staff1, c.value.id, reasons)).ok, true);
    const sub = await svc.submit(fx.storeId, fx.staff1, c.value.id, staffSig);
    assert.equal(sub.ok, true, msg(sub));
    return c.value;
  };

  // Today's suggested list: nothing counted yet, so everything is "never counted", what sells first.
  assert.equal((await benta.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.loose.id, kilos: "1" }], payment: { method: "cash" } })).ok, true);
  const sug = await svc.suggest(fx.storeId, fx.staff1, {});
  assert.equal(sug.ok, true, msg(sug));
  if (!sug.ok) return;
  assert.deepEqual(sug.value.items.map((i) => [i.name, i.why, i.text]), [["Sinandomeng (per kilo)", "NEVER", "Never counted"], ["Dinorado 25 kg", "NEVER", "Never counted"], ["Sinandomeng 25 kg", "NEVER", "Never counted"]]);
  assert.equal((await svc.suggest(fx.storeId, fx.staff2, { locationId: fx.s1 })).ok, false, "Store 2 staff cannot ask for Store 1's list");

  // A baseline that matches, then a count with a big shortage: 2 Dinorado sacks (₱2,800) with "Don't know".
  await countWith({ sin: 10, din: 4, loose: "49" });
  const c2 = await countWith({ sin: 10, din: 2, loose: "49" }, [{ productId: fx.din25.id, reason: "UNKNOWN" }]);
  const sugAfter = await svc.suggest(fx.storeId, fx.staff1, {});
  assert.deepEqual(sugAfter.ok ? sugAfter.value.items : null, [], "everything was counted a moment ago");

  const looks = await svc.looks(fx.storeId, fx.owner);
  assert.equal(looks.ok, true, msg(looks));
  if (!looks.ok) return;
  assert.deepEqual(looks.value.limits, { recountMinor: 50_000, lookMinor: 100_000 });
  assert.deepEqual(looks.value.items.map((i) => [i.count.docNumber, i.count.countedBy, i.flags.map((f) => f.kind), i.flags[0]?.text, i.chargeMinor]), [[c2.docNumber, "Ate Lorna", ["BIG"], "Short ₱2,800.00 on Dinorado 25 kg", 0]]);
  assert.equal((await svc.looks(fx.storeId, fx.staff1)).ok, false, "staff do not see the owner's list");
  assert.equal((await svc.review(fx.storeId, fx.staff1, c2.id, "fine")).ok, false);

  // The owner looks at it: it leaves the list, with a note.
  const rev = await svc.review(fx.storeId, fx.owner, c2.id, "  checked with   Lorna ");
  assert.equal(rev.ok, true, msg(rev));
  const row = await prisma.stockCount.findUniqueOrThrow({ where: { id: c2.id } });
  assert.deepEqual([row.lookStatus, row.lookNote, row.reviewedById], ["OK", "checked with Lorna", fx.owner.userId]);
  const after = await svc.looks(fx.storeId, fx.owner);
  assert.equal(after.ok && after.value.items.length, 0);
  assert.equal((await svc.review(fx.storeId, fx.owner, "no-such-count", null)).ok, false);

  // The limits: staff cannot read or change them; amounts must be whole centavos; 0 switches a rule off.
  assert.equal((await svc.getLimits(fx.storeId, fx.staff1)).ok, false);
  assert.equal((await svc.setLimits(fx.storeId, fx.staff1, { recountMinor: 1, lookMinor: 1 })).ok, false);
  assert.match(msg(await svc.setLimits(fx.storeId, fx.owner, { recountMinor: -5, lookMinor: 100 })), /pesos/);
  assert.match(msg(await svc.setLimits(fx.storeId, fx.owner, { recountMinor: 1.5, lookMinor: 100 })), /pesos/);
  assert.equal((await svc.setLimits(fx.storeId, fx.owner, { recountMinor: 1_000, lookMinor: 0 })).ok, true);
  const lim = await svc.getLimits(fx.storeId, fx.owner);
  assert.deepEqual(lim.ok && lim.value, { recountMinor: 1_000, lookMinor: 0 });

  // An over count adds stock from nothing: with the "big" rule off, it is still on the list because it is over the count-again limit.
  await countWith({ sin: 12, din: 2, loose: "49" }, [{ productId: fx.sin25.id, reason: "STOCKIN_MISSING" }]);
  assert.equal(await onHand(fx, fx.sin25.id), 12);
  const over = await svc.looks(fx.storeId, fx.owner);
  assert.deepEqual(over.ok ? over.value.items.map((i) => [i.flags.map((f) => f.kind), i.flags[0]?.text]) : null, [[["OVER"], "Over count adds stock: Sinandomeng 25 kg (₱2,200.00)"]]);

  // Accuracy: 3 counts of 3 items = 9 lines; Dinorado (count 2) and Sinandomeng (count 3) were not right the first time.
  const acc = await svc.accuracy(fx.storeId, fx.owner);
  assert.equal(acc.ok, true, msg(acc));
  if (!acc.ok) return;
  assert.deepEqual([acc.value.total.counted, acc.value.total.right, acc.value.total.pct], [9, 7, 78]);
  assert.deepEqual(acc.value.total.weeks.map((w) => w.counted), [0, 0, 0, 9], "all in the last 7 days");
  assert.deepEqual(acc.value.locations.map((l) => [l.name, l.counted, l.right]), [["Store 1", 9, 7]]);
  assert.deepEqual(acc.value.people.map((p) => [p.name, p.counted, p.right]), [["Ate Lorna", 9, 7]]);
  assert.equal((await svc.accuracy(fx.storeId, fx.staff1)).ok, false);
});

// Rice Ops M3 — trips between locations, against the real DB.
// Proves the M3 "done when" list:
//   * E2E "S1 sells 2 sacks from S2": the sale holds S2's stock, S2 releases it
//     (staff + kargador sign), S1 marks it delivered (staff + kargador sign);
//   * a refused delivery returns the stock to S2 and asks the owner to settle the money;
//   * 19 of 20 received flags 1 short with both signatures and goes to the owner.
// Plus: warehouse requests are auto-approved and held; holds stop the stock being sold
// twice; nothing moves without the signatures; S1 staff cannot release S2's stock;
// concurrent releases move stock once; a customer return goes back on the shelf.
import { test, after } from "node:test";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { WarehouseService } from "../admin/warehouse.service.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { TransferFlowService } from "./transfer-flow.service.js";
import type { Actor, SignatureInput } from "../people/people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `M3R${Date.now()}${Math.floor(Math.random() * 1000)}`;
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
    await prisma.stockReturn.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    if (orderIds.length) {
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.kargador.deleteMany({ where });
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

/** S1 (default) and S2 stores, a WH, a kargador, an owner, staff at S1 and staff at S2. */
async function fixture(stock: { s1?: number; s2?: number; wh?: number } = {}) {
  seq += 1;
  // Order numbers are globally unique and start with the slug's first 6 characters
  // (domain/order-number.ts), so every test store gets its own random 6-letter start.
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `M3 ${run}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const wh = await prisma.warehouse.create({ data: { storeId: store.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" } });
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 110_000 } });
  for (const [w, q] of [[s1.id, stock.s1], [s2.id, stock.s2], [wh.id, stock.wh]] as const) {
    if (q !== undefined) await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, warehouseId: w, quantityOnHand: q } });
  }
  const kargador = await prisma.kargador.create({ data: { storeId: store.id, name: "Mang Boy" } });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null) => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@m3.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home } as Actor;
  };
  return {
    storeId: store.id, productId: product.id, s1: s1.id, s2: s2.id, wh: wh.id, kargadorId: kargador.id,
    owner: await mk("Aling Nena", "OWNER", null), staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id),
  };
}

const sigs = (kargadorId: string, extra: SignatureInput[] = []): SignatureInput[] => [
  { signerKind: "STAFF", imagePng: PNG }, { signerKind: "KARGADOR", kargadorId, imagePng: PNG }, ...extra,
];
const level = async (fx: { storeId: string; productId: string }, w: string) =>
  prisma.stockLevel.findFirst({ where: { storeId: fx.storeId, productId: fx.productId, warehouseId: w }, select: { quantityOnHand: true, quantityReserved: true } });
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const pos = () => new PosService(new LoyaltyService());

// ─────────────────────────── the done-when list ───────────────────────────

test("M3 E2E: S1 sells 2 sacks from S2 — held, released with signatures, delivered", async () => {
  const fx = await fixture({ s1: 0, s2: 10 });
  const flow = new TransferFlowService();

  const sale = await pos().sell(fx.storeId, fx.staff1.userId, {
    items: [{ productId: fx.productId, quantity: 2, sourceLocationId: fx.s2 }], paymentMethod: "cash", tenderedMinor: 260_000,
  });
  assert.equal(sale.ok, true, msg(sale));
  if (!sale.ok) return;
  assert.equal(sale.value.releases?.length, 1);
  const tripId = sale.value.releases![0]!.id;
  assert.match(sale.value.releases![0]!.docNumber, /^REL-\d{6}$/);
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 10, quantityReserved: 2 }, "S2's sacks are held, still on its shelf");
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 0, quantityReserved: 0 }, "S1's own stock is untouched");

  // It sits on S2's Ilabas list (and not on S1's).
  assert.deepEqual((await flow.list(fx.storeId, fx.staff2, "ilabas")).map((t) => t.id), [tripId]);
  assert.equal((await flow.list(fx.storeId, fx.staff1, "ilabas")).length, 0);

  // Ilabas at S2 needs the staff AND the kargador.
  const noKargadorSig = await flow.release(fx.storeId, fx.staff2, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: [{ signerKind: "STAFF", imagePng: PNG }] });
  assert.equal(noKargadorSig.ok, false);
  assert.match(msg(noKargadorSig), /Kulang ang pirma: kargador/);
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 10, quantityReserved: 2 }, "nothing moved");
  const rel = await flow.release(fx.storeId, fx.staff2, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) });
  assert.equal(rel.ok, true, msg(rel));
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 8, quantityReserved: 0 }, "the sacks left S2 at the signed release");

  // Naihatid at S1: staff + kargador (+ customer) sign.
  assert.deepEqual((await flow.list(fx.storeId, fx.staff1, "naihatid")).map((t) => t.id), [tripId]);
  const done = await flow.deliver(fx.storeId, fx.staff1, tripId, { quantity: 2, signatures: sigs(fx.kargadorId, [{ signerKind: "CUSTOMER", signerName: "Juan Cruz", imagePng: PNG }]) });
  assert.equal(done.ok, true, msg(done));
  const trip = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: tripId } });
  assert.equal(trip.status, "COMPLETED");
  assert.equal(trip.orderId, sale.value.orderId, "the release serves S1's sale");
  assert.equal(trip.deliveredQty, 2);
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 0, quantityReserved: 0 }, "the rice went to the customer, not onto S1's shelf");

  const trail = await prisma.signature.findMany({ where: { storeId: fx.storeId, documentId: tripId }, select: { step: true, signerKind: true, signerName: true } });
  assert.deepEqual(trail.map((s) => `${s.step}:${s.signerKind}`).sort(), ["DELIVERED:CUSTOMER", "DELIVERED:KARGADOR", "DELIVERED:STAFF", "RELEASE:KARGADOR", "RELEASE:STAFF"]);
  const moves = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, documentId: tripId }, select: { type: true, delta: true } });
  assert.deepEqual(moves.map((m) => `${m.type}${m.delta}`).sort(), ["RELEASE_OUT-2", "RELEASE_RESERVATION2", "RESERVE2"]);
});

test("M3: a refused delivery brings the stock back to S2 and asks the owner to settle the money", async () => {
  const fx = await fixture({ s2: 5 });
  const flow = new TransferFlowService();
  const sale = await pos().sell(fx.storeId, fx.staff1.userId, { items: [{ productId: fx.productId, quantity: 2, sourceLocationId: fx.s2 }], paymentMethod: "cash", tenderedMinor: 260_000 });
  assert.equal(sale.ok, true, msg(sale));
  const tripId = sale.ok ? sale.value.releases![0]!.id : "";
  assert.equal((await flow.release(fx.storeId, fx.staff2, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) })).ok, true);

  const noReason = await flow.deliver(fx.storeId, fx.staff1, tripId, { quantity: 0, signatures: sigs(fx.kargadorId) });
  assert.equal(noReason.ok, false, "a refused delivery needs a reason");
  const refused = await flow.deliver(fx.storeId, fx.staff1, tripId, { quantity: 0, note: "ayaw ng customer, basa ang sako", signatures: sigs(fx.kargadorId) });
  assert.equal(refused.ok, true, msg(refused));
  assert.equal(refused.ok && refused.value.status, "RETURNING");
  assert.ok(refused.ok && refused.value.approvalId, "the owner is asked to refund / reverse the utang");
  assert.equal((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: refused.ok ? refused.value.approvalId! : "" } })).kind, "REFUND");

  // On S2's "pabalik" list; S1 staff cannot receive it back for S2.
  assert.deepEqual((await flow.list(fx.storeId, fx.staff2, "pabalik")).map((t) => t.id), [tripId]);
  const wrongStore = await flow.receiveBack(fx.storeId, fx.staff1, tripId, { quantity: 2, signatures: sigs(fx.kargadorId) });
  assert.equal(!wrongStore.ok && wrongStore.error.type, "forbidden");
  const back = await flow.receiveBack(fx.storeId, fx.staff2, tripId, { quantity: 2, signatures: sigs(fx.kargadorId) });
  assert.equal(back.ok, true, msg(back));
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 5, quantityReserved: 0 }, "all 5 back on S2's shelf");
  assert.equal((await prisma.stockTransfer.findUniqueOrThrow({ where: { id: tripId } })).status, "COMPLETED");
});

test("M3: 19 of 20 received flags 1 short with both signatures and goes to the owner", async () => {
  const fx = await fixture({ wh: 50 });
  const svc = new WarehouseService();
  const flow = new TransferFlowService();
  const req = await svc.requestTransfer(fx.storeId, fx.wh, fx.s1, fx.productId, 20, fx.staff1.userId, "pang-restock");
  assert.equal(req.ok, true, msg(req));
  if (!req.ok) return;
  assert.equal(req.value.status, "APPROVED", "from the warehouse: approved on request");
  assert.match(req.value.docNumber, /^TR-\d{6}$/);
  assert.deepEqual(await level(fx, fx.wh), { quantityOnHand: 50, quantityReserved: 20 }, "held at the warehouse");

  assert.equal((await flow.release(fx.storeId, fx.owner, req.value.id, { quantity: 20, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) })).ok, true);
  assert.deepEqual(await level(fx, fx.wh), { quantityOnHand: 30, quantityReserved: 0 });

  const unsigned = await flow.receive(fx.storeId, fx.staff1, req.value.id, { quantity: 19, signatures: [{ signerKind: "STAFF", imagePng: PNG }] });
  assert.equal(unsigned.ok, false, "the kargador must sign the hand-over too");
  const over = await flow.receive(fx.storeId, fx.staff1, req.value.id, { quantity: 21, signatures: sigs(fx.kargadorId) });
  assert.equal(over.ok, false, "more cannot arrive than left");

  const got = await flow.receive(fx.storeId, fx.staff1, req.value.id, { quantity: 19, signatures: sigs(fx.kargadorId) });
  assert.equal(got.ok, true, msg(got));
  if (!got.ok) return;
  assert.equal(got.value.shortQty, 1);
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 19, quantityReserved: 0 });
  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: got.value.approvalId! } });
  assert.equal(approval.kind, "TRANSIT_SHORT");
  assert.deepEqual(approval.approverRoles, ["OWNER"]);
  assert.match(approval.summary, /Kulang sa lipat TR-\d{6}: 1 × Sinandomeng 25 kg .*dala ni Mang Boy/);
  const receiveSigs = await prisma.signature.findMany({ where: { storeId: fx.storeId, documentId: req.value.id, step: "RECEIVE" }, select: { signerKind: true } });
  assert.deepEqual(receiveSigs.map((s) => s.signerKind).sort(), ["KARGADOR", "STAFF"], "both signatures on the trip");
  const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: req.value.id } });
  assert.deepEqual([t.releasedQty, t.receivedQty, t.shortQty, t.status], [20, 19, 1, "COMPLETED"]);
});

// ─────────────────────────── the rules around it ───────────────────────────

test("M3: a store-to-store request waits for approval; the hold stops the stock being sold twice", async () => {
  const fx = await fixture({ s2: 3 });
  const svc = new WarehouseService();
  const req = await svc.requestTransfer(fx.storeId, fx.s2, fx.s1, fx.productId, 3, fx.staff1.userId);
  assert.equal(req.ok && req.value.status, "REQUESTED");
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 3, quantityReserved: 0 }, "nothing held before approval");
  assert.equal((await svc.approveTransfer(fx.storeId, req.ok ? req.value.id : "", fx.owner.userId)).ok, true);
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 3, quantityReserved: 3 });
  // S2 now has 0 available to sell, and a second sale from S2 is refused.
  const sale = await pos().sell(fx.storeId, fx.staff1.userId, { items: [{ productId: fx.productId, quantity: 1, sourceLocationId: fx.s2 }], paymentMethod: "cash", tenderedMinor: 130_000 });
  assert.equal(sale.ok, false);
  assert.match(msg(sale), /Only 0 of Sinandomeng 25 kg at Store 2/);
  // Cancel drops the hold.
  assert.equal((await svc.cancelTransfer(fx.storeId, req.ok ? req.value.id : "", fx.owner.userId, "hindi na kailangan")).ok, true);
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 3, quantityReserved: 0 });
});

test("M3: S1 staff cannot release S2's stock; two concurrent releases move it once", async () => {
  const fx = await fixture({ s2: 10 });
  const flow = new TransferFlowService();
  const sale = await pos().sell(fx.storeId, fx.staff1.userId, { items: [{ productId: fx.productId, quantity: 4, sourceLocationId: fx.s2 }], paymentMethod: "cash", tenderedMinor: 520_000 });
  const tripId = sale.ok ? sale.value.releases![0]!.id : "";
  const wrong = await flow.release(fx.storeId, fx.staff1, tripId, { quantity: 4, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) });
  assert.equal(!wrong.ok && wrong.error.type, "forbidden");
  const [a, b] = await Promise.all([
    flow.release(fx.storeId, fx.staff2, tripId, { quantity: 4, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) }),
    flow.release(fx.storeId, fx.owner, tripId, { quantity: 4, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "exactly one release wins");
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 6, quantityReserved: 0 });
});

test("M3: releasing fewer than held frees the rest; a partial delivery returns the remainder", async () => {
  const fx = await fixture({ s2: 10 });
  const flow = new TransferFlowService();
  const sale = await pos().sell(fx.storeId, fx.staff1.userId, { items: [{ productId: fx.productId, quantity: 3, sourceLocationId: fx.s2 }], paymentMethod: "cash", tenderedMinor: 390_000 });
  const tripId = sale.ok ? sale.value.releases![0]!.id : "";
  assert.equal((await flow.release(fx.storeId, fx.staff2, tripId, { quantity: 2, kargadorId: fx.kargadorId, signatures: sigs(fx.kargadorId) })).ok, true);
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 8, quantityReserved: 0 }, "2 left, the 3rd hold is freed");
  const part = await flow.deliver(fx.storeId, fx.staff1, tripId, { quantity: 1, note: "isa lang ang kinuha", signatures: sigs(fx.kargadorId) });
  assert.equal(part.ok && part.value.pendingReturn, 1);
  const back = await flow.receiveBack(fx.storeId, fx.staff2, tripId, { quantity: 0, signatures: sigs(fx.kargadorId) });
  assert.equal(back.ok && back.value.shortQty, 1, "nothing came back: 1 short on the way back");
  assert.deepEqual(await level(fx, fx.s2), { quantityOnHand: 8, quantityReserved: 0 });
});

test("M3: the one-step owner move still works for an approved restock, and only once", async () => {
  const fx = await fixture({ wh: 5 });
  const svc = new WarehouseService();
  const req = await svc.requestTransfer(fx.storeId, fx.wh, fx.s1, fx.productId, 5, fx.owner.userId);
  const id = req.ok ? req.value.id : "";
  const done = await svc.completeTransfer(fx.storeId, id, fx.owner, [{ signerKind: "STAFF", imagePng: PNG }]);
  assert.equal(done.ok, true, msg(done));
  assert.deepEqual(await level(fx, fx.wh), { quantityOnHand: 0, quantityReserved: 0 }, "hold dropped and stock moved");
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 5, quantityReserved: 0 });
  assert.equal((await svc.completeTransfer(fx.storeId, id, fx.owner, [{ signerKind: "STAFF", imagePng: PNG }])).ok, false);
});

test("M3 Ibinalik: a good sack goes back on the shelf; a damaged one is only recorded; both go to the owner", async () => {
  const fx = await fixture({ s1: 5 });
  const flow = new TransferFlowService();
  const sale = await pos().sell(fx.storeId, fx.staff1.userId, { items: [{ productId: fx.productId, quantity: 2 }], paymentMethod: "cash", tenderedMinor: 260_000 });
  assert.equal(sale.ok, true, msg(sale));
  const orderId = sale.ok ? sale.value.orderId : "";
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 3, quantityReserved: 0 });

  const good = await flow.createReturn(fx.storeId, fx.staff1, { locationId: fx.s1, productId: fx.productId, quantity: 1, condition: "GOOD", reason: "sobra ang nabili", orderId, signatures: [{ signerKind: "STAFF", imagePng: PNG }] });
  assert.equal(good.ok, true, msg(good));
  assert.match(good.ok ? good.value.docNumber : "", /^RET-\d{6}$/);
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 4, quantityReserved: 0 });
  const bad = await flow.createReturn(fx.storeId, fx.staff1, { locationId: fx.s1, productId: fx.productId, quantity: 1, condition: "DAMAGED", reason: "basa", orderId, signatures: [{ signerKind: "STAFF", imagePng: PNG }] });
  assert.equal(bad.ok, true, msg(bad));
  assert.deepEqual(await level(fx, fx.s1), { quantityOnHand: 4, quantityReserved: 0 }, "a damaged sack is not sellable stock");
  const tooMany = await flow.createReturn(fx.storeId, fx.staff1, { locationId: fx.s1, productId: fx.productId, quantity: 1, condition: "GOOD", reason: "ulit", orderId, signatures: [{ signerKind: "STAFF", imagePng: PNG }] });
  assert.equal(tooMany.ok, false, "cannot return more than was bought");
  const unsigned = await flow.createReturn(fx.storeId, fx.staff1, { locationId: fx.s1, productId: fx.productId, quantity: 1, condition: "GOOD", reason: "test", signatures: [] });
  assert.equal(unsigned.ok, false);
  assert.equal(await prisma.approvalRequest.count({ where: { storeId: fx.storeId, kind: "REFUND" } }), 2);
  const notHere = await flow.createReturn(fx.storeId, fx.staff2, { locationId: fx.s1, productId: fx.productId, quantity: 1, condition: "GOOD", reason: "x y z", signatures: [{ signerKind: "STAFF", imagePng: PNG }] });
  assert.equal(!notHere.ok && notHere.error.type, "forbidden", "S2 staff cannot take a return into S1");
});

test("M3: one store cannot see or touch another store's trips", async () => {
  const a = await fixture({ s2: 5 });
  const b = await fixture({ s2: 5 });
  const sale = await pos().sell(a.storeId, a.staff1.userId, { items: [{ productId: a.productId, quantity: 1, sourceLocationId: a.s2 }], paymentMethod: "cash", tenderedMinor: 130_000 });
  const tripId = sale.ok ? sale.value.releases![0]!.id : "";
  const flow = new TransferFlowService();
  assert.equal((await flow.list(b.storeId, b.owner, "all")).some((t) => t.id === tripId), false);
  const r = await flow.release(b.storeId, b.owner, tripId, { quantity: 1, kargadorId: b.kargadorId, signatures: sigs(b.kargadorId) });
  assert.equal(!r.ok && r.error.type, "not_found");
  const crossSource = await pos().sell(b.storeId, b.staff1.userId, { items: [{ productId: b.productId, quantity: 1, sourceLocationId: a.s2 }], paymentMethod: "cash", tenderedMinor: 130_000 });
  assert.equal(crossSource.ok, false, "store B cannot sell from store A's location");
});

// Rice Ops M5 — Benta (selling), against the real DB. Proves the M5 "done when" list:
//   * a double-tap makes ONE sale (Benta and the old POS path);
//   * a manual item (Bagong item) sells at once and appears for the owner's review;
//   * an encoded paper slip keeps its real time.
// Plus: by peso / by kilo arithmetic on the real ledger, location prices, utang needs a
// customer and their signature, GCash needs a reference, "kulang" says where stock is,
// Kunin sa ibang tindahan holds the other location's stock, Manual na pasok, merging a
// manual item by weight, location rules and tenant isolation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "./benta.service.js";
import { PeopleService, type Actor, type SignatureInput } from "../people/people.service.js";
import { PosService } from "../pos/pos.service.js";
import { PurchaseOrderService } from "../purchase-orders/purchase-order.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const jpegBytes = Buffer.alloc(800, 9);
jpegBytes[0] = 0xff; jpegBytes[1] = 0xd8; jpegBytes[2] = 0xff;
const JPEG = `data:image/jpeg;base64,${jpegBytes.toString("base64")}`;
const run = `M5R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const orderIds = (await prisma.order.findMany({ where, select: { id: true } })).map((o) => o.id);
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.smsMessage.deleteMany({ where });
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    await prisma.stockInLine.deleteMany({ where });
    await prisma.stockIn.deleteMany({ where });
    await prisma.purchaseOrder.deleteMany({ where });
    await prisma.supplierPayment.deleteMany({ where });
    await prisma.supplier.deleteMany({ where });
    if (orderIds.length) {
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.creditEntry.deleteMany({ where });
    await prisma.storePayableEntry.deleteMany({ where });
    await prisma.customerPrice.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.paymentMethod.deleteMany({ where });
    await prisma.kargador.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
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

const PIN = "2580";

async function fixture() {
  seq += 1;
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `M5 ${run}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const wh = await prisma.warehouse.create({ data: { storeId: store.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" } });
  const rice = (sku: string, name: string, grams: number, price: number, cost: number) =>
    prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-${sku}`, name, priceMinor: price, costMinor: cost, stockBaseUnit: "g", stockBaseQuantity: grams, stockConversionFamily: "Bigas", soldByWeight: grams === 1 } });
  const sin25 = await rice("SIN25", "Sinandomeng 25 kg", 25_000, 130_000, 110_000);
  const loose = await rice("SINK", "Sinandomeng (per kilo)", 1, 5_200, 4_600);
  await prisma.locationPrice.create({ data: { storeId: store.id, productId: loose.id, warehouseId: s2.id, priceMinor: 5_400 } });
  const lvl = (productId: string, warehouseId: string, q: number) => prisma.stockLevel.create({ data: { storeId: store.id, productId, warehouseId, quantityOnHand: q } });
  await lvl(sin25.id, s1.id, 10);
  await lvl(sin25.id, s2.id, 5);
  await lvl(sin25.id, wh.id, 0);
  await lvl(loose.id, s1.id, 50_000);
  await lvl(loose.id, s2.id, 10_000);
  const cust = await prisma.customer.create({ data: { name: `Juan ${run}`, phone: null, email: null, passwordHash: null } });
  customerIds.push(cust.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: cust.id, creditApproved: true, creditLimitMinor: 500_000 } });
  const pinHash = bcrypt.hashSync(PIN, 4);
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@m5.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF", pinHash } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  return {
    storeId: store.id, s1: s1.id, s2: s2.id, wh: wh.id, sin25, loose, customerId: sc.id,
    staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id), owner: await mk("Aling Nena", "OWNER", null),
  };
}

const staffSig: SignatureInput[] = [{ signerKind: "STAFF", imagePng: PNG }];
const onHand = async (fx: { storeId: string }, productId: string, w: string) =>
  (await prisma.stockLevel.findFirst({ where: { storeId: fx.storeId, productId, warehouseId: w } }))?.quantityOnHand ?? null;
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const key = () => `tap-${randomBytes(8).toString("hex")}`;
const svc = new BentaService();

test("M5: a double-tap makes ONE sale — both taps get the same sale back", async () => {
  const fx = await fixture();
  const k = key();
  const body = { idempotencyKey: k, locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 2 }], payment: { method: "cash", tenderedMinor: 300_000 } };
  const [a, b] = await Promise.all([svc.sell(fx.storeId, fx.staff1, body), svc.sell(fx.storeId, fx.staff1, body)]);
  assert.equal(a.ok && b.ok, true, `${msg(a)} ${msg(b)}`);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value.orderId, b.value.orderId, "the same sale");
  assert.equal([a.value.replayed, b.value.replayed].filter(Boolean).length, 1, "one made it, one replayed it");
  assert.equal(a.value.changeMinor, 40_000);
  assert.equal(await prisma.order.count({ where: { storeId: fx.storeId } }), 1);
  assert.equal(await prisma.payment.count({ where: { storeId: fx.storeId } }), 1);
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 8, "2 sacks left Store 1 once");
  // A third tap, later, still returns the same sale.
  const c = await svc.sell(fx.storeId, fx.staff1, body);
  assert.equal(c.ok && c.value.orderId === a.value.orderId && c.value.replayed, true);
  const o = await prisma.order.findUniqueOrThrow({ where: { id: a.value.orderId } });
  assert.equal(o.sellingLocationId, fx.s1);
  assert.notEqual(o.idempotencyKey, k, "only a hash of the key is stored");
});

test("M5: the old POS path also makes one sale per key", async () => {
  const fx = await fixture();
  const pos = new PosService(new LoyaltyService());
  const body = { idempotencyKey: key(), items: [{ productId: fx.sin25.id, quantity: 1 }], paymentMethod: "cash" as const, tenderedMinor: 130_000 };
  const [a, b] = await Promise.all([pos.sell(fx.storeId, fx.staff1.userId, body), pos.sell(fx.storeId, fx.staff1.userId, body)]);
  assert.equal(a.ok && b.ok, true, `${msg(a)} ${msg(b)}`);
  assert.equal(a.ok && b.ok && a.value.orderId === b.value.orderId, true);
  assert.equal(await prisma.order.count({ where: { storeId: fx.storeId } }), 1);
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 9);
});

test("M5: ₱100 at ₱52/kg = 1.923 kg for exactly ₱100; 1.25 kg = ₱65; Store 2 sells at its own price", async () => {
  const fx = await fixture();
  const r = await svc.sell(fx.storeId, fx.staff1, {
    idempotencyKey: key(), locationId: fx.s1, payment: { method: "cash" },
    lines: [{ productId: fx.loose.id, amountMinor: 10_000 }, { productId: fx.loose.id, kilos: "1.25" }],
  });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  assert.equal(r.value.totalMinor, 16_500);
  assert.deepEqual(r.value.lines.map((l) => [l.soldBy, l.grams, l.lineTotalMinor, l.enteredAmountMinor]), [["PESO", 1_923, 10_000, 10_000], ["KILO", 1_250, 6_500, null]]);
  assert.equal(await onHand(fx, fx.loose.id, fx.s1), 50_000 - 1_923 - 1_250, "grams leave the ledger exactly");
  const moves = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, documentType: "SALE", documentId: r.value.orderId }, select: { delta: true, warehouseId: true } });
  assert.deepEqual(moves.map((m) => m.delta).sort((x, y) => x - y), [-1_923, -1_250]);
  assert.equal(moves.every((m) => m.warehouseId === fx.s1), true);

  const cat = await svc.catalog(fx.storeId, fx.staff2, undefined);
  assert.equal(cat.ok && cat.value.location.id, fx.s2, "Kuya Ben's screen opens at his home location");
  assert.equal(cat.ok && cat.value.products.find((p) => p.id === fx.loose.id)?.priceMinor, 5_400, "Store 2's own price");
  assert.equal(cat.ok && cat.value.products.find((p) => p.id === fx.sin25.id)?.stock[fx.s1], 10);
  const s2 = await svc.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.loose.id, kilos: "1" }], payment: { method: "cash" } });
  assert.equal(s2.ok && s2.value.totalMinor, 5_400, msg(s2));
  assert.equal(s2.ok && s2.value.locationId, fx.s2);
});

test("M5: a manual item sells at once and goes straight into Products (no owner review)", async () => {
  const fx = await fixture();
  const noSig = await svc.manualItem(fx.storeId, fx.staff1, { name: "Jasmine 25 kg", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 150_000, costMinor: 120_000, openingQty: 3 });
  assert.equal(noSig.ok, false);
  assert.match(msg(noSig), /Missing signature/);
  assert.equal(await prisma.product.count({ where: { storeId: fx.storeId, name: "Jasmine 25 kg" } }), 0, "nothing half-made");

  const m = await svc.manualItem(fx.storeId, fx.staff1, { name: "Jasmine 25 kg", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 150_000, costMinor: 120_000, openingQty: 3, signatures: staffSig });
  assert.equal(m.ok, true, msg(m));
  if (!m.ok) return;
  assert.match(m.value.stockInDocNumber, /^IN-\d{6}$/);
  assert.equal(await onHand(fx, m.value.productId, fx.s1), 3);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: m.value.productId } })).reviewStatus, "ACTIVE");
  assert.equal(m.value.approvalId, null);
  assert.equal(await prisma.approvalRequest.count({ where: { storeId: fx.storeId, kind: "MANUAL_ITEM" } }), 0, "no approval is asked");
  const sale = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: m.value.productId, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(sale.ok && sale.value.totalMinor, 150_000, msg(sale));
  assert.equal((await svc.reviewList(fx.storeId)).length, 0);
});

test("M5: a pre-order item can be added with a cost and a price and nothing on hand", async () => {
  const fx = await fixture();
  const m = await svc.manualItem(fx.storeId, fx.staff1, { name: "Dinorado 25 kg", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 180_000, costMinor: 150_000, noOpeningStock: true });
  assert.equal(m.ok, true, msg(m));
  if (!m.ok) return;
  assert.equal(m.value.stockInDocNumber, "", "no stock-in was written");
  assert.equal((await onHand(fx, m.value.productId, fx.s1)) ?? 0, 0, "nothing on hand (no stock row, or a zero one)");
  const p = await prisma.product.findUniqueOrThrow({ where: { id: m.value.productId } });
  assert.deepEqual([p.priceMinor, p.costMinor, p.reviewStatus], [180_000, 150_000, "ACTIVE"]);
});

test("M5: recent stock-ins are listed with their lines (for the receipt)", async () => {
  const fx = await fixture();
  const r = await svc.stockIn(fx.storeId, fx.staff1, { lines: [{ productId: fx.sin25.id, quantity: 4, unitCostMinor: 120_000 }], supplierName: "Mang Ben", signatures: staffSig });
  assert.equal(r.ok, true, msg(r));
  const l = await svc.stockInList(fx.storeId, fx.staff1, undefined);
  assert.equal(l.ok, true, msg(l));
  if (!l.ok) return;
  assert.equal(l.value.stockIns[0]?.supplierName, "Mang Ben");
  assert.deepEqual(l.value.stockIns[0]?.lines.map((x) => [x.name, x.quantity, x.unitCostMinor]), [[fx.sin25.name ?? "", 4, 120_000]]);
});

test("M5: merging a manual item moves its stock into the real product by weight", async () => {
  const fx = await fixture();
  const m = await svc.manualItem(fx.storeId, fx.staff1, { name: "Sinandomeng 25kg (bago)", soldAs: "SACK", gramsPerSack: 25_000, priceMinor: 130_000, costMinor: 110_000, openingQty: 2, signatures: staffSig });
  assert.equal(m.ok, true, msg(m));
  if (!m.ok) return;
  await prisma.product.update({ where: { id: m.value.productId }, data: { reviewStatus: "FOR_REVIEW" } }); // an older item still waiting from before
  const staff = await svc.merge(fx.storeId, fx.staff1, m.value.productId, fx.sin25.id);
  assert.equal(staff.ok, false, "staff cannot merge");
  const r = await svc.merge(fx.storeId, fx.owner, m.value.productId, fx.sin25.id);
  assert.equal(r.ok, true, msg(r));
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 12, "10 + the 2 merged sacks");
  assert.equal(await onHand(fx, m.value.productId, fx.s1), 0);
  const p = await prisma.product.findUniqueOrThrow({ where: { id: m.value.productId } });
  assert.deepEqual([p.reviewStatus, p.isActive, p.mergedIntoId], ["MERGED", false, fx.sin25.id]);
  const moves = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, documentType: "PRODUCT_MERGE" }, select: { type: true, delta: true } });
  assert.deepEqual(moves.map((x) => `${x.type}${x.delta}`).sort(), ["MERGE_IN2", "MERGE_OUT-2"]);
  const again = await svc.merge(fx.storeId, fx.owner, m.value.productId, fx.sin25.id);
  assert.equal(again.ok, false, "a merge happens once");
});

test("M5: an encoded paper slip keeps its real time and number, once", async () => {
  const fx = await fixture();
  const when = new Date(Date.now() - 26 * 3_600_000); // yesterday afternoon
  const slip = { slipNo: "0123", occurredAt: when.toISOString() };
  const noPhoto = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" }, paperSlip: slip, signatures: staffSig });
  assert.equal(noPhoto.ok, false);
  assert.match(msg(noPhoto), /photo of the paper slip/);
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 10, "nothing moved");

  const sigs: SignatureInput[] = [...staffSig, { signerKind: "SLIP_PHOTO", imagePng: JPEG }];
  const r = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" }, paperSlip: slip, signatures: sigs });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  const o = await prisma.order.findUniqueOrThrow({ where: { id: r.value.orderId } });
  assert.equal(o.occurredAt?.toISOString(), when.toISOString(), "the real time from the slip");
  assert.equal(o.encodedLater, true);
  assert.equal(o.paperSlipNo, "0123");
  assert.ok(o.createdAt.getTime() - when.getTime() > 25 * 3_600_000, "encoded a day later");
  assert.equal(await prisma.signature.count({ where: { storeId: fx.storeId, documentType: "PAPER_SLIP", documentId: o.id } }), 2);

  const twice = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" }, paperSlip: slip, signatures: sigs });
  assert.equal(twice.ok, false);
  assert.match(msg(twice), /Paper slip #0123 is already entered/);
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 9, "the second encode moved nothing");
  const future = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" }, paperSlip: { slipNo: "0124", occurredAt: new Date(Date.now() + 86_400_000).toISOString() }, signatures: sigs });
  assert.equal(future.ok, false);
});

test("M5: utang needs a customer on the list and their signature; GCash needs a reference", async () => {
  const fx = await fixture();
  const noCust = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "utang" } });
  assert.match(msg(noCust), /customer/);
  const noSig = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "utang" }, customerId: fx.customerId });
  assert.equal(noSig.ok, false);
  assert.match(msg(noSig), /Missing signature: customer/);
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 10);
  const ok = await svc.sell(fx.storeId, fx.staff1, {
    idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "utang" }, customerId: fx.customerId,
    signatures: [{ signerKind: "CUSTOMER", signerName: "Juan", imagePng: PNG }],
  });
  assert.equal(ok.ok, true, msg(ok));
  assert.equal((await prisma.storeCustomer.findUniqueOrThrow({ where: { id: fx.customerId } })).creditBalanceMinor, 130_000);
  const o = await prisma.order.findUniqueOrThrow({ where: { id: ok.ok ? ok.value.orderId : "" } });
  assert.deepEqual([o.paymentMethod, o.paymentStatus], ["credit", "PENDING"]);

  const noRef = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "gcash" } });
  assert.match(msg(noRef), /reference/);
  const gcash = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "gcash", reference: "1234567890" } });
  assert.equal(gcash.ok, true, msg(gcash));
  assert.equal((await prisma.payment.findFirstOrThrow({ where: { orderId: gcash.ok ? gcash.value.orderId : "" } })).method, "gcash");
});

test("M5: the counter sells even when the count is short (it goes below zero); taking from another store leaves that store at once", async () => {
  const fx = await fixture();
  const short = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 11 }], payment: { method: "cash" } });
  assert.equal(short.ok, true, msg(short));
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), -1, "the count goes below zero; the next count fixes it");
  const mv = await prisma.stockMovement.findFirstOrThrow({ where: { storeId: fx.storeId, productId: fx.sin25.id, warehouseId: fx.s1, delta: -11 } });
  assert.match(mv.note ?? "", /below zero/);

  const r = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 2, sourceLocationId: fx.s2 }], payment: { method: "cash" } });
  assert.equal(r.ok, true, msg(r));
  assert.deepEqual(r.ok ? r.value.releases : null, [], "no release step any more");
  const s2 = await prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId, productId: fx.sin25.id, warehouseId: fx.s2 } });
  assert.deepEqual([s2.quantityOnHand, s2.quantityReserved], [3, 0], "taken from Store 2 at once");
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), -1, "Store 1's own stock untouched");
});

test("M5: staff sell only at their own location; another store's product is not found", async () => {
  const fx = await fixture();
  const other = await fixture();
  const away = await svc.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(away.ok, false);
  assert.equal(!away.ok && away.error.type, "forbidden");
  const cross = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: other.sin25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(cross.ok, false);
  assert.equal(await onHand(other, other.sin25.id, other.s1), 10, "the other store's stock is untouched");
  const reuse = await svc.sell(other.storeId, other.staff1, { idempotencyKey: "same-key-1234", lines: [{ productId: other.sin25.id, quantity: 1 }], payment: { method: "cash" } });
  const mine = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: "same-key-1234", lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(reuse.ok && mine.ok && reuse.value.orderId !== mine.value.orderId && !mine.value.replayed, true, "keys never cross stores");
});

test("M5: Manual na pasok adds signed stock and records the latest cost", async () => {
  const fx = await fixture();
  const noSig = await svc.stockIn(fx.storeId, fx.staff1, { lines: [{ productId: fx.sin25.id, quantity: 4, unitCostMinor: 112_000 }] });
  assert.equal(noSig.ok, false);
  const r = await svc.stockIn(fx.storeId, fx.staff1, { supplierName: "Mang Tonyo", lines: [{ productId: fx.sin25.id, quantity: 4, unitCostMinor: 112_000 }], signatures: staffSig });
  assert.equal(r.ok, true, msg(r));
  assert.match(r.ok ? r.value.docNumber : "", /^IN-\d{6}$/);
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 14);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: fx.sin25.id } })).costMinor, 112_000);
  const mv = await prisma.stockMovement.findFirstOrThrow({ where: { storeId: fx.storeId, type: "STOCK_IN" } });
  assert.deepEqual([mv.delta, mv.warehouseId, mv.documentType], [4, fx.s1, "STOCK_IN"]);
  const away = await svc.stockIn(fx.storeId, fx.staff2, { locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 1 }], signatures: staffSig });
  assert.equal(away.ok, false, "Store 2 staff cannot receive at Store 1");
});

test("Buffer store: a short sale is covered from the Buffer (the store stays at zero) and the Buffer cannot sell", async () => {
  const fx = await fixture();
  const buffer = await prisma.warehouse.create({ data: { storeId: fx.storeId, name: "Buffer store", code: "BF", type: "BUFFER" } });
  const r = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 13 }], payment: { method: "cash" } });
  assert.equal(r.ok, true, msg(r));
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 0, "the store gives what it had");
  const level = await prisma.stockLevel.findFirstOrThrow({ where: { storeId: fx.storeId, productId: fx.sin25.id, warehouseId: buffer.id } });
  assert.equal(level.quantityOnHand, -3, "the Buffer covers the rest and is now 3 short (to fix)");
  const enough = await svc.sell(fx.storeId, fx.owner, { idempotencyKey: key(), locationId: buffer.id, lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(enough.ok, false, "the Buffer is not a place to sell");
});

test("Consignment store: each sale at Store 2 charges Store 1's cost; a sale at the main store is never charged", async () => {
  const fx = await fixture();
  await prisma.warehouse.update({ where: { id: fx.s2 }, data: { consignment: true } });
  // Sell 2 sacks at Store 2 (price 1,300.00, Store 1 cost 1,100.00).
  const r = await svc.sell(fx.storeId, fx.staff2, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 2 }], payment: { method: "cash" } });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  const charges = await prisma.storePayableEntry.findMany({ where: { storeId: fx.storeId, locationId: fx.s2, orderId: r.value.orderId } });
  assert.equal(charges.length, 1);
  assert.equal(charges[0]!.kind, "CHARGE");
  assert.equal(charges[0]!.amountMinor, 220_000, "2 sacks at Store 1's cost, not the selling price");
  assert.deepEqual(r.value.belowCost, [], "sold above cost: no warning");
  // A sale at Store 1 (the main store) is never charged.
  const own = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(own.ok, true, msg(own));
  assert.equal(await prisma.storePayableEntry.count({ where: { storeId: fx.storeId } }), 1, "only the Store 2 sale was charged");
});

test("Split payment: part cash, part GCash pays one sale; the parts must add up and GCash needs its reference", async () => {
  const fx = await fixture();
  const sale = (parts: { method: string; amountMinor: number; reference?: string }[]) =>
    svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "split", tenders: parts } });
  const short = await sale([{ method: "cash", amountMinor: 80_000 }, { method: "gcash", amountMinor: 40_000, reference: "123456" }]);
  assert.equal(short.ok, false, "the parts add up to less than the sale");
  const noRef = await sale([{ method: "cash", amountMinor: 80_000 }, { method: "gcash", amountMinor: 50_000 }]);
  assert.equal(noRef.ok, false, "GCash needs a reference");
  const ok = await sale([{ method: "cash", amountMinor: 80_000 }, { method: "gcash", amountMinor: 50_000, reference: "123456" }]);
  assert.equal(ok.ok, true, msg(ok));
  if (!ok.ok) return;
  const pays = await prisma.payment.findMany({ where: { orderId: ok.value.orderId, type: "payment" }, orderBy: { amountMinor: "asc" } });
  assert.deepEqual(pays.map((p) => [p.method, p.amountMinor]), [["gcash", 50_000], ["cash", 80_000]]);
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), 9);
  const maya = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "maya", reference: "998877" } });
  assert.equal(maya.ok, true, msg(maya));
});

test("Special price: a customer's own price beats the store price, and the sale is linked to them", async () => {
  const fx = await fixture();
  const cust = await prisma.customerPrice.create({ data: { storeId: fx.storeId, storeCustomerId: fx.customerId, productId: fx.sin25.id, priceMinor: 120_000, createdById: fx.owner.userId } });
  assert.ok(cust.id);
  const r = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), customerId: fx.customerId, lines: [{ productId: fx.sin25.id, quantity: 2 }], payment: { method: "cash" } });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  assert.equal(r.value.totalMinor, 240_000, "2 sacks at the special 1,200.00, not 1,300.00");
  const o = await prisma.order.findUniqueOrThrow({ where: { id: r.value.orderId } });
  assert.equal(o.storeCustomerId, fx.customerId);
  const walkIn = await svc.sell(fx.storeId, fx.staff1, { idempotencyKey: key(), lines: [{ productId: fx.sin25.id, quantity: 1 }], payment: { method: "cash" } });
  assert.equal(walkIn.ok && walkIn.value.totalMinor, 130_000, "no customer: the store price");
});

test("a purchase order: receive against it at the agreed cost, owe the supplier, pay and undo", async () => {
  const fx = await fixture();
  const svc = new BentaService();
  const po = new PurchaseOrderService();
  const made = await po.create(fx.storeId, fx.owner.userId, {
    supplierName: "Mang Tonyo", locationId: fx.s1, expectedAt: "2026-11-05", note: "Weekly",
    lines: [{ productId: fx.sin25.id, quantity: 10, unitCostMinor: 100_000 }, { productId: fx.loose.id, quantity: 100_000, unitCostMinor: 4_000 }],
  });
  assert.ok(made.ok, msg(made));
  assert.match(made.value.docNumber, /^PO-\d{6}$/);

  // counter staff see the open order, but no cost
  const seen = await po.list(fx.storeId, "STAFF", { locationId: fx.s1 });
  assert.ok(seen.ok);
  assert.equal(seen.value.orders.length, 1);
  assert.equal(JSON.stringify(seen.value).includes("unitCostMinor"), false);
  assert.equal(JSON.stringify(seen.value).includes("totalMinor"), false);

  // a wrong place, a wrong item, and too many are all refused
  const wrongPlace = await svc.stockIn(fx.storeId, fx.staff2, { locationId: fx.s2, purchaseOrderId: made.value.id, lines: [{ productId: fx.sin25.id, quantity: 1 }], signatures: staffSig });
  assert.ok(!wrongPlace.ok);
  const tooMany = await svc.stockIn(fx.storeId, fx.staff1, { purchaseOrderId: made.value.id, lines: [{ productId: fx.sin25.id, quantity: 11 }], signatures: staffSig });
  assert.ok(!tooMany.ok);
  assert.match(msg(tooMany), /only 10 sacks left/);

  // part of it arrives: the cost comes from the order, whatever the phone sent
  const before = await onHand(fx, fx.sin25.id, fx.s1);
  const r1 = await svc.stockIn(fx.storeId, fx.staff1, { purchaseOrderId: made.value.id, lines: [{ productId: fx.sin25.id, quantity: 6, unitCostMinor: 1 }], signatures: staffSig });
  assert.ok(r1.ok, msg(r1));
  assert.equal(await onHand(fx, fx.sin25.id, fx.s1), (before ?? 0) + 6);
  const lineRow = await prisma.stockInLine.findFirst({ where: { stockInId: r1.value.id } });
  assert.equal(lineRow?.unitCostMinor, 100_000);
  assert.ok(lineRow?.poLineId);
  const after1 = await po.list(fx.storeId, "OWNER", { status: "all" });
  assert.ok(after1.ok);
  assert.equal(after1.value.orders[0]?.status, "PARTLY");
  assert.equal(after1.value.orders[0]?.receivedMinor, 600_000);

  // what we owe: 6 sacks at 1,000.00 = 6,000.00; 90,000 g still to come is "on order"
  const owed1 = await po.balances(fx.storeId);
  assert.ok(owed1.ok);
  const sup = owed1.value.suppliers.find((x) => x.name === "Mang Tonyo");
  assert.equal(sup?.owedMinor, 600_000);
  assert.equal(sup?.pendingMinor, 400_000 + 400_000);

  // the rest arrives: the order is complete
  const r2 = await svc.stockIn(fx.storeId, fx.staff1, { purchaseOrderId: made.value.id, lines: [{ productId: fx.sin25.id, quantity: 4 }, { productId: fx.loose.id, quantity: 100_000 }], signatures: staffSig });
  assert.ok(r2.ok, msg(r2));
  const after2 = await po.list(fx.storeId, "OWNER", { status: "all" });
  assert.ok(after2.ok);
  assert.equal(after2.value.orders[0]?.status, "RECEIVED");
  const closed = await svc.stockIn(fx.storeId, fx.staff1, { purchaseOrderId: made.value.id, lines: [{ productId: fx.sin25.id, quantity: 1 }], signatures: staffSig });
  assert.ok(!closed.ok);
  const owed2 = await po.balances(fx.storeId);
  assert.ok(owed2.ok);
  assert.equal(owed2.value.suppliers.find((x) => x.name === "Mang Tonyo")?.owedMinor, 1_000_000 + 400_000);

  // pay part, refuse a slipped zero, undo
  const supId = owed2.value.suppliers.find((x) => x.name === "Mang Tonyo")!.id;
  const tooBig = await po.pay(fx.storeId, fx.owner.userId, { supplierId: supId, amountMinor: 99_999_900 });
  assert.ok(!tooBig.ok);
  const paid = await po.pay(fx.storeId, fx.owner.userId, { supplierId: supId, amountMinor: 500_000, note: "Cash" });
  assert.ok(paid.ok, msg(paid));
  assert.match(paid.value.docNumber, /^SPY-\d{6}$/);
  const st = await po.statement(fx.storeId, supId);
  assert.ok(st.ok);
  assert.equal(st.value.owedMinor, 900_000);
  const undone = await po.undoPayment(fx.storeId, fx.owner.userId, paid.value.id);
  assert.ok(undone.ok, msg(undone));
  const twice = await po.undoPayment(fx.storeId, fx.owner.userId, paid.value.id);
  assert.ok(!twice.ok);
  const st2 = await po.statement(fx.storeId, supId);
  assert.ok(st2.ok);
  assert.equal(st2.value.owedMinor, 1_400_000);

  // an order nobody delivered on is cancelled; one partly delivered is closed short
  const m2 = await po.create(fx.storeId, fx.owner.userId, { supplierId: supId, locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 5, unitCostMinor: 100_000 }] });
  assert.ok(m2.ok);
  const c = await po.cancel(fx.storeId, fx.owner.userId, m2.value.id);
  assert.ok(c.ok);
  assert.equal(c.value.status, "CANCELLED");
});

test("price watch: a later order shows the move against the supplier's last cost; a cancelled order does not count; staff see nothing", async () => {
  const fx = await fixture();
  const po = new PurchaseOrderService();
  const a = await po.create(fx.storeId, fx.owner.userId, { supplierName: "Aling Nena", locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 4, unitCostMinor: 100_000 }] });
  assert.ok(a.ok, msg(a));
  const first = await po.list(fx.storeId, "OWNER", { status: "all" });
  assert.ok(first.ok);
  assert.equal(first.value.orders[0]?.lines[0]?.move?.kind, "NEW", "first time with this supplier");
  await new Promise((r) => setTimeout(r, 20));
  const cancelled = await po.create(fx.storeId, fx.owner.userId, { supplierName: "Aling Nena", locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 1, unitCostMinor: 150_000 }] });
  assert.ok(cancelled.ok);
  assert.ok((await po.cancel(fx.storeId, fx.owner.userId, cancelled.value.id)).ok);
  await new Promise((r) => setTimeout(r, 20));
  const b = await po.create(fx.storeId, fx.owner.userId, { supplierName: "Aling Nena", locationId: fx.s1, lines: [{ productId: fx.sin25.id, quantity: 4, unitCostMinor: 105_000 }] });
  assert.ok(b.ok, msg(b));
  const list = await po.list(fx.storeId, "OWNER", { status: "all" });
  assert.ok(list.ok);
  const second = list.value.orders.find((o) => o.id === b.value.id)?.lines[0]?.move;
  assert.equal(second?.kind, "UP");
  assert.equal(second?.lastMinor, 100_000, "the cancelled order is ignored");
  assert.equal(second?.changeMinor, 5_000);
  assert.equal(second?.big, true);
  const sup = list.value.orders.find((o) => o.id === b.value.id)!.supplierId;
  const last = await po.lastCosts(fx.storeId, sup);
  assert.ok(last.ok, msg(last));
  assert.equal(last.value.costs.find((x) => x.productId === fx.sin25.id)?.unitCostMinor, 105_000, "the newest real order");
  const none = await po.lastCosts(fx.storeId, undefined);
  assert.ok(!none.ok);
  const staff = await po.list(fx.storeId, "STAFF", {});
  assert.ok(staff.ok);
  assert.equal(JSON.stringify(staff.value).includes("move"), false, "counter staff never see cost moves");
});

test("reorder suggestions: fast sellers running low are listed with an amount; an order on the way takes the item off", async () => {
  const fx = await fixture();
  const po = new PurchaseOrderService();
  const empty = await po.reorder(fx.storeId);
  assert.ok(empty.ok);
  assert.equal(empty.value.items.length, 0, "nothing sold lately, nothing to suggest");
  // 70 sacks sold in the last 2 weeks = 5 a day; 15 sacks are left in all places = 3 days
  await prisma.stockMovement.create({ data: { storeId: fx.storeId, productId: fx.sin25.id, warehouseId: fx.s1, delta: -70, type: "CONSUME" } });
  const r1 = await po.reorder(fx.storeId);
  assert.ok(r1.ok, msg(r1));
  const it = r1.value.items.find((x) => x.productId === fx.sin25.id);
  assert.ok(it, "listed");
  assert.equal(it.urgency, "SOON");
  assert.equal(it.availableQty, 15);
  assert.equal(it.perDay, 5);
  assert.equal(it.suggestedQty, 55, "2 weeks of selling (70) minus the 15 left");
  assert.equal(it.supplierId, null);
  // an order of 40 on the way covers it (55 sacks = 11 days)
  const made = await po.create(fx.storeId, fx.owner.userId, { supplierName: "Mang Tonyo", locationId: fx.wh, lines: [{ productId: fx.sin25.id, quantity: 40, unitCostMinor: 101_000 }] });
  assert.ok(made.ok, msg(made));
  const r2 = await po.reorder(fx.storeId);
  assert.ok(r2.ok);
  assert.equal(r2.value.items.some((x) => x.productId === fx.sin25.id), false, "already on order");
  // cancel it: back on the list, now with the supplier and the last cost
  assert.ok((await po.cancel(fx.storeId, fx.owner.userId, made.value.id)).ok);
  const bigger = await po.create(fx.storeId, fx.owner.userId, { supplierName: "Mang Tonyo", locationId: fx.wh, lines: [{ productId: fx.sin25.id, quantity: 5, unitCostMinor: 101_000 }] });
  assert.ok(bigger.ok);
  const r3 = await po.reorder(fx.storeId);
  assert.ok(r3.ok);
  const back = r3.value.items.find((x) => x.productId === fx.sin25.id);
  assert.equal(back?.onOrderQty, 5);
  assert.equal(back?.suggestedQty, 50);
  assert.equal(back?.supplierName, "Mang Tonyo");
  assert.equal(back?.lastCostMinor, 101_000);
});

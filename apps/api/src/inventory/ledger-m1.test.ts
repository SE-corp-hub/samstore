// Rice Ops M1 — locations and the stock ledger core, against the real DB.
// Proves the M1 "done when" list: one row per product per location, sales take
// the store's own stock (not the first row), reserved stock is never sold,
// voids return stock to where it came from, and transfers can neither create
// stock nor complete twice.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { deductStock, InsufficientStockError, restoreStock } from "../domain/movements.js";
import { WarehouseService } from "../admin/warehouse.service.js";

const run = `M1R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    await prisma.signature.deleteMany({ where }); // M2: receiving signs
    await prisma.locationPrice.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/** A store with S2 created FIRST (so it is the "first row"), S1 the default, and WH. */
async function fixture(stock: { s1?: number; s2?: number; wh?: number; s1Reserved?: number } = {}) {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `M1 ${run}` } });
  storeIds.push(store.id);
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const wh = await prisma.warehouse.create({ data: { storeId: store.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" } });
  const product = await prisma.product.create({
    data: { storeId: store.id, sku: `${run}-${seq}`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 110_000 },
  });
  // S2's row is inserted first on purpose: the old code took stock from whichever row came first.
  if (stock.s2 !== undefined) await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, warehouseId: s2.id, quantityOnHand: stock.s2 } });
  if (stock.s1 !== undefined) await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, warehouseId: s1.id, quantityOnHand: stock.s1, quantityReserved: stock.s1Reserved ?? 0 } });
  if (stock.wh !== undefined) await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, warehouseId: wh.id, quantityOnHand: stock.wh } });
  const actor = await prisma.user.create({ data: { email: `${run}-${seq}@m1.test`, passwordHash: "x", name: "M1 Manager", role: "MANAGER" } });
  userIds.push(actor.id);
  return { storeId: store.id, productId: product.id, s1: s1.id, s2: s2.id, wh: wh.id, actorId: actor.id };
}

// M2: receiving a transfer needs the receiver's signature (1×1 PNG stands in for a drawn one).
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
function receive(svc: WarehouseService, fx: { storeId: string; actorId: string }, id: string) {
  return svc.completeTransfer(fx.storeId, id, { userId: fx.actorId, role: "MANAGER", homeLocationId: null }, [{ signerKind: "STAFF", imagePng: PNG }]);
}

async function onHand(storeId: string, productId: string, warehouseId: string) {
  const l = await prisma.stockLevel.findFirst({ where: { storeId, productId, warehouseId } });
  return l?.quantityOnHand ?? null;
}

async function order(storeId: string) {
  return prisma.order.create({
    data: {
      orderNumber: `${run}-O${++seq}`.toUpperCase(),
      storeId,
      status: "COMPLETED",
      source: "pos",
      currencyCode: "PHP",
      subtotalMinor: 0,
      totalMinor: 0,
      snapshot: {},
      cartToken: `cart-${run}-${seq}`,
      customerName: "M1 Customer",
      customerPhone: "09170000000",
      deliveryAddressLine1: "",
    },
  });
}

test("M1: one stock row per product per location (unique key)", async () => {
  const fx = await fixture({ s1: 5 });
  await assert.rejects(
    prisma.stockLevel.create({ data: { storeId: fx.storeId, productId: fx.productId, warehouseId: fx.s1, quantityOnHand: 1 } }),
    (e: { code?: string }) => e.code === "P2002",
  );
});

test("M1: a sale takes the store's default location, not the first row found", async () => {
  const fx = await fixture({ s2: 50, s1: 5 });
  await prisma.$transaction((tx) => deductStock(tx, fx.storeId, [{ productId: fx.productId, quantity: 3 }], { createdBy: fx.actorId }));
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 2, "Store 1's rice went down");
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s2), 50, "Store 2's rice was not touched");
  const mv = await prisma.stockMovement.findFirst({ where: { storeId: fx.storeId, type: "CONSUME" } });
  assert.equal(mv?.warehouseId, fx.s1);
  assert.equal(mv?.createdBy, fx.actorId);
});

test("M1: a sale never spreads silently to another location — short is an error that names what is elsewhere", async () => {
  const fx = await fixture({ s2: 50, s1: 2 });
  await assert.rejects(
    prisma.$transaction((tx) => deductStock(tx, fx.storeId, [{ productId: fx.productId, quantity: 5 }])),
    (e: unknown) => e instanceof InsufficientStockError && e.shortfall === 3 && e.elsewhere === 50,
  );
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 2, "nothing moved");
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s2), 50);
});

test("M1: reserved stock is not sold", async () => {
  const fx = await fixture({ s1: 10, s1Reserved: 8 });
  await assert.rejects(
    prisma.$transaction((tx) => deductStock(tx, fx.storeId, [{ productId: fx.productId, quantity: 3 }])),
    InsufficientStockError,
  );
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 10);
  await prisma.$transaction((tx) => deductStock(tx, fx.storeId, [{ productId: fx.productId, quantity: 2 }]));
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 8, "the 2 unreserved units could be sold");
});

test("M1: an explicit location is honoured, and a void returns the stock to that location", async () => {
  const fx = await fixture({ s1: 5, s2: 20 });
  const o = await order(fx.storeId);
  await prisma.$transaction((tx) =>
    deductStock(tx, fx.storeId, [{ productId: fx.productId, quantity: 4 }], { orderId: o.id, warehouseId: fx.s2, createdBy: fx.actorId }),
  );
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s2), 16);
  await prisma.$transaction((tx) =>
    restoreStock(tx, fx.storeId, [{ productId: fx.productId, quantity: 4 }], { orderId: o.id, type: "VOID_RESTORE", createdBy: fx.actorId }),
  );
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s2), 20, "back to Store 2, where it came from");
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 5, "Store 1 unchanged");
  const back = await prisma.stockMovement.findFirst({ where: { storeId: fx.storeId, type: "VOID_RESTORE" } });
  assert.equal(back?.warehouseId, fx.s2);
  assert.equal(back?.documentType, "ORDER");
  assert.equal(back?.documentId, o.id);
});

test("M1: a transfer can never create stock the source does not have", async () => {
  const fx = await fixture({ s1: 0, wh: 2 });
  const svc = new WarehouseService();
  const req = await svc.requestTransfer(fx.storeId, fx.wh, fx.s1, fx.productId, 5, fx.actorId);
  assert.equal(req.ok, false, "the request itself is refused");
  // Even a transfer row that slipped through (e.g. stock sold after approval) cannot complete.
  const t = await prisma.stockTransfer.create({
    data: { storeId: fx.storeId, fromWarehouseId: fx.wh, toWarehouseId: fx.s1, productId: fx.productId, quantity: 5, status: "APPROVED", requestedById: fx.actorId },
  });
  const done = await receive(svc, fx, t.id);
  assert.equal(done.ok, false);
  assert.match(!done.ok ? String((done.error as { message?: string }).message) : "", /Not enough stock at Warehouse/);
  assert.equal(await onHand(fx.storeId, fx.productId, fx.wh), 2, "source untouched");
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 0, "destination did not grow");
  assert.equal((await prisma.stockTransfer.findUnique({ where: { id: t.id } }))?.status, "APPROVED", "status rolled back");
});

test("M1: two concurrent completions move the stock exactly once", async () => {
  const fx = await fixture({ wh: 30, s1: 0 });
  const svc = new WarehouseService();
  const req = await svc.requestTransfer(fx.storeId, fx.wh, fx.s1, fx.productId, 10, fx.actorId, "restock S1");
  assert.equal(req.ok, true);
  const id = req.ok ? req.value.id : "";
  assert.equal((await svc.approveTransfer(fx.storeId, id, fx.actorId)).ok, true);
  const [a, b] = await Promise.all([receive(svc, fx, id), receive(svc, fx, id)]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "exactly one completion wins");
  assert.equal(await onHand(fx.storeId, fx.productId, fx.wh), 20);
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 10);
  const mv = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, documentType: "TRANSFER", documentId: id } });
  assert.deepEqual(mv.map((m) => m.type).sort(), ["TRANSFER_IN", "TRANSFER_OUT"]);
  assert.ok(mv.every((m) => m.createdBy === fx.actorId), "both ledger rows name who completed it");
  // Approving or cancelling a completed transfer is refused.
  assert.equal((await svc.approveTransfer(fx.storeId, id, fx.actorId)).ok, false);
  assert.equal((await svc.cancelTransfer(fx.storeId, id, fx.actorId)).ok, false);
});

test("M1: a transfer creates the destination row on first delivery and can be cancelled before it moves", async () => {
  const fx = await fixture({ wh: 8 });
  const svc = new WarehouseService();
  const r1 = await svc.requestTransfer(fx.storeId, fx.wh, fx.s2, fx.productId, 3, fx.actorId);
  const id1 = r1.ok ? r1.value.id : "";
  await svc.approveTransfer(fx.storeId, id1, fx.actorId);
  assert.equal((await receive(svc, fx, id1)).ok, true);
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s2), 3);

  const r2 = await svc.requestTransfer(fx.storeId, fx.wh, fx.s2, fx.productId, 2, fx.actorId);
  const id2 = r2.ok ? r2.value.id : "";
  assert.equal((await svc.cancelTransfer(fx.storeId, id2, fx.actorId, "wrong item")).ok, true);
  assert.equal((await receive(svc, fx, id2)).ok, false, "a cancelled transfer cannot complete");
  assert.equal(await onHand(fx.storeId, fx.productId, fx.wh), 5);
});

test("M1: setting counted stock needs a reason and is an attributed ADJUST, not an overwrite", async () => {
  const fx = await fixture({ s1: 10 });
  const svc = new WarehouseService();
  const noReason = await svc.setStock(fx.storeId, fx.s1, fx.productId, 7, fx.actorId, "");
  assert.equal(noReason.ok, false);
  const res = await svc.setStock(fx.storeId, fx.s1, fx.productId, 7, fx.actorId, "Counted at closing");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ok && res.value.delta, -3);
  assert.equal(await onHand(fx.storeId, fx.productId, fx.s1), 7);
  const mv = await prisma.stockMovement.findFirst({ where: { storeId: fx.storeId, type: "ADJUST" } });
  assert.equal(mv?.delta, -3);
  assert.equal(mv?.createdBy, fx.actorId);
  assert.equal(mv?.note, "Counted at closing");
  assert.equal(mv?.documentType, "STOCK_SET");
});

test("M1: a location's own selling price overrides the main price; clearing it falls back", async () => {
  const fx = await fixture({ s1: 1 });
  const svc = new WarehouseService();
  assert.equal((await svc.setPrice(fx.storeId, fx.s2, fx.productId, 0, fx.actorId)).ok, false, "zero price refused");
  assert.equal((await svc.setPrice(fx.storeId, fx.s2, fx.productId, 132_500, fx.actorId)).ok, true);
  const s2 = await svc.listPrices(fx.storeId, fx.s2);
  const row = s2.ok ? s2.value.find((p) => p.productId === fx.productId) : undefined;
  assert.equal(row?.mainPriceMinor, 130_000);
  assert.equal(row?.locationPriceMinor, 132_500);
  assert.equal(row?.effectivePriceMinor, 132_500);
  const s1 = await svc.listPrices(fx.storeId, fx.s1);
  assert.equal(s1.ok && s1.value.find((p) => p.productId === fx.productId)?.effectivePriceMinor, 130_000, "Store 1 still sells at the main price");
  assert.equal((await svc.setPrice(fx.storeId, fx.s2, fx.productId, null, fx.actorId)).ok, true);
  const cleared = await svc.listPrices(fx.storeId, fx.s2);
  assert.equal(cleared.ok && cleared.value.find((p) => p.productId === fx.productId)?.effectivePriceMinor, 130_000);
});

test("M1: locations carry code/type/address; codes are unique; the default cannot be switched off", async () => {
  const fx = await fixture({});
  const svc = new WarehouseService();
  const dup = await svc.create(fx.storeId, { name: "Another", code: "s1" });
  assert.equal(dup.ok, false, "code S1 is taken (case-insensitive input)");
  const ok = await svc.update(fx.storeId, fx.wh, { address: "Brgy. San Isidro, bodega 2" });
  assert.equal(ok.ok, true);
  assert.equal((await prisma.warehouse.findUnique({ where: { id: fx.wh } }))?.address, "Brgy. San Isidro, bodega 2");
  assert.equal((await svc.update(fx.storeId, fx.s1, { isActive: false })).ok, false);
  assert.equal((await svc.update(fx.storeId, fx.s2, { isDefault: true })).ok, true);
  const defaults = await prisma.warehouse.findMany({ where: { storeId: fx.storeId, isDefault: true } });
  assert.deepEqual(defaults.map((d) => d.id), [fx.s2], "exactly one default");
});

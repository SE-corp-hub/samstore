// M2 — stock adjustments: the reasoned, actor-attributed writer over the StockMovement
// ledger, plus the history/flow reads. Real DB.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import { InventoryService } from "./inventory.service.js";

const run = `M2${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let slugSeq = 0;

after(async () => {
  if (storeIds.length) {
    await prisma.auditLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.stockMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.stockLevel.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.warehouse.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.product.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.storeSettings.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

interface Fixture { storeId: string; productId: string; levelId: string; actorId: string; warehouseId: string }

async function fixture(onHand = 10): Promise<Fixture> {
  slugSeq += 1;
  const store = await prisma.store.create({
    data: { slug: `${run}-s${slugSeq}`.toLowerCase(), name: `M2 ${run}`, settings: { create: { requireOpenShift: false } } },
  });
  storeIds.push(store.id);
  const warehouse = await prisma.warehouse.create({ data: { storeId: store.id, name: "Main", isDefault: true } });
  const product = await prisma.product.create({
    data: { storeId: store.id, sku: `${run}-${slugSeq}`, name: "M2 Test Product", priceMinor: 10000, costMinor: 6000, isActive: true },
  });
  const level = await prisma.stockLevel.create({
    data: { storeId: store.id, productId: product.id, warehouseId: warehouse.id, quantityOnHand: onHand, quantityReserved: 0 },
  });
  const actor = await prisma.user.create({
    data: {
      email: `${run}-${slugSeq}@m2.test`, passwordHash: "x", name: "M2 Adjuster", role: "MANAGER",
    },
  });
  userIds.push(actor.id);
  return { storeId: store.id, productId: product.id, levelId: level.id, actorId: actor.id, warehouseId: warehouse.id };
}

test("M2: +delta records an ADJUST movement with the actor, the reason and balanceAfter", async () => {
  const svc = new InventoryService();
  const fx = await fixture(10);

  const res = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: 5, reason: "Delivery received (5 pcs)" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ok && res.value.balanceAfter, 15);
  assert.equal(res.ok && res.value.delta, 5);

  const level = await prisma.stockLevel.findUnique({ where: { id: fx.levelId }, select: { quantityOnHand: true } });
  assert.equal(level?.quantityOnHand, 15, "the derived balance moved");

  const mv = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, productId: fx.productId } });
  assert.equal(mv.length, 1);
  assert.equal(mv[0]?.type, "ADJUST");
  assert.equal(mv[0]?.delta, 5);
  assert.equal(mv[0]?.balanceAfter, 15);
  assert.equal(mv[0]?.createdBy, fx.actorId, "the actor is on the ledger row");
  assert.equal(mv[0]?.note, "Delivery received (5 pcs)", "the reason is on the ledger row");

  const audit = await prisma.auditLog.findMany({ where: { storeId: fx.storeId, action: "stock.adjust" } });
  assert.equal(audit.length, 1, "and it is audit-logged");
});

test("M2: removing more than is on hand is refused and writes nothing", async () => {
  const svc = new InventoryService();
  const fx = await fixture(4);

  const res = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: -10, reason: "Shrinkage" });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error.type, "conflict");
  assert.match(res.ok === false && "message" in res.error ? (res.error.message ?? "") : "", /short by 6 unit/i);

  assert.equal((await prisma.stockLevel.findUnique({ where: { id: fx.levelId }, select: { quantityOnHand: true } }))?.quantityOnHand, 4, "balance untouched");
  assert.equal(await prisma.stockMovement.count({ where: { storeId: fx.storeId } }), 0, "no movement written");
});

test("M2: a stock-take (setTo) records the DIFFERENCE, and allowNegative lets a count win", async () => {
  const svc = new InventoryService();
  const fx = await fixture(10);

  const counted = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, setTo: 7, reason: "Physical count" });
  assert.equal(counted.ok, true, JSON.stringify(counted));
  assert.equal(counted.ok && counted.value.delta, -3, "the movement carries the difference");
  assert.equal(counted.ok && counted.value.balanceAfter, 7);

  // A correction that would go negative needs the explicit flag (manager stock-take).
  const refused = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: -100, reason: "Recount" });
  assert.equal(refused.ok, false);
  const forced = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: -10, reason: "Recount after audit", allowNegative: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.ok && forced.value.balanceAfter, -3, "an allowed negative count is recorded, not hidden");

  // The ledger explains the balance exactly: opening (10, created directly by the fixture
  // and therefore NOT a movement) + Σ movements (excl. RESERVE) = current balance.
  const movements = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, productId: fx.productId }, select: { delta: true, type: true } });
  const ledger = movements.filter((m) => m.type !== "RESERVE").reduce((s, m) => s + m.delta, 0);
  const balance = (await prisma.stockLevel.findUnique({ where: { id: fx.levelId }, select: { quantityOnHand: true } }))?.quantityOnHand ?? 0;
  assert.equal(ledger, -13, "Σ movements = the changes the operator made");
  assert.equal(10 + ledger, balance, "opening stock + Σ movements = balance (the reconcile identity)");
});

test("M2: a reason is mandatory, and exactly one of delta/setTo is required", async () => {
  const svc = new InventoryService();
  const fx = await fixture(10);

  const noReason = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: 1, reason: "  " });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.ok === false && noReason.error.type, "validation");

  const both = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: 1, setTo: 5, reason: "Ambiguous" });
  assert.equal(both.ok, false);
  const neither = await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, reason: "Nothing to do" });
  assert.equal(neither.ok, false);
  assert.equal(await prisma.stockMovement.count({ where: { storeId: fx.storeId } }), 0);
});

test("M2: tenant isolation — another store's product and warehouse are not adjustable", async () => {
  const svc = new InventoryService();
  const a = await fixture(10);
  const b = await fixture(10);

  const foreignProduct = await svc.adjust(b.storeId, b.actorId, { productId: a.productId, delta: 1, reason: "Cross tenant" });
  assert.equal(foreignProduct.ok, false);
  assert.equal(foreignProduct.ok === false && foreignProduct.error.type, "not_found");

  const foreignWarehouse = await svc.adjust(b.storeId, b.actorId, { productId: b.productId, warehouseId: a.warehouseId, delta: 1, reason: "Cross tenant" });
  assert.equal(foreignWarehouse.ok, false);
  assert.equal(foreignWarehouse.ok === false && foreignWarehouse.error.type, "not_found");
});

test("M2: adjustment history and the raw stock flow read back with actor names, newest first", async () => {
  const svc = new InventoryService();
  const fx = await fixture(10);

  await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: 2, reason: "First" });
  await svc.adjust(fx.storeId, fx.actorId, { productId: fx.productId, delta: 3, reason: "Second" });

  const history = await svc.adjustments(fx.storeId, { productId: fx.productId });
  assert.equal(history.count, 2, "adjustments() = ADJUST rows only");
  assert.equal(history.movements[0]?.note, "Second", "newest first");
  assert.equal(history.movements[0]?.actor, "M2 Adjuster", "the actor name is resolved for display");
  assert.equal(history.movements[0]?.balanceAfter, 15);
  assert.equal(history.movements[1]?.balanceAfter, 12);

  const flow = await svc.movements(fx.storeId, { limit: 10 });
  assert.equal(flow.count, 2, "the flow returns the same rows (all types)");

  const empty = await svc.adjustments(fx.storeId, { productId: randomId() });
  assert.equal(empty.count, 0, "an unrelated product has no adjustments");
});

// Stock conversions: atomically convert products/variants with source-yield bounds,
// warehouse-aware balances, cost transfer, waste accounting, and idempotent retries.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { InventoryService } from "./inventory.service.js";

const svc = new InventoryService();
const run = `SC${Date.now()}${Math.floor(Math.random() * 1000)}`.toLowerCase();
const storeIds: string[] = [];
const actorIds: string[] = [];
let seq = 0;

function tag(value: string) {
  return `${run}-${value}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

async function fixture(source: { variant?: boolean; reserved?: number } = {}) {
  seq += 1;
  const store = await prisma.store.create({ data: { name: `${run} store ${seq}`, slug: tag(`store-${seq}`), status: "ACTIVE" } });
  storeIds.push(store.id);
  const warehouse = await prisma.warehouse.create({ data: { storeId: store.id, name: "Main", isDefault: true } });
  const actor = await prisma.user.create({ data: { email: `${tag(`actor-${seq}`)}@convert.test`, passwordHash: "x", name: "Conversion Operator", role: "MANAGER" } });
  actorIds.push(actor.id);
  const sourceProduct = await prisma.product.create({
    data: { storeId: store.id, sku: tag(`source-${seq}`), name: "Rice 25kg", priceMinor: 150000, costMinor: 100000, stockBaseUnit: "g", stockBaseQuantity: 25000, stockConversionFamily: "rice" },
  });
  const destinationProduct = await prisma.product.create({
    data: { storeId: store.id, sku: tag(`destination-${seq}`), name: "Rice 5kg", priceMinor: 35000, costMinor: 0, stockBaseUnit: "g", stockBaseQuantity: 5000, stockConversionFamily: "rice" },
  });

  if (source.variant) {
    const sourceVariant = await prisma.productVariant.create({
      data: { storeId: store.id, productId: sourceProduct.id, sku: tag(`source-v-${seq}`), name: "25kg sack", priceMinor: 150000, costMinor: 100000, stockBaseQuantity: 25000, quantityOnHand: 2, quantityReserved: source.reserved ?? 1 },
    });
    const destinationVariant = await prisma.productVariant.create({
      data: { storeId: store.id, productId: destinationProduct.id, sku: tag(`destination-v-${seq}`), name: "5kg bag", priceMinor: 35000, costMinor: 0, stockBaseQuantity: 5000, quantityOnHand: 0 },
    });
    return { store, actor, warehouse, sourceProduct, destinationProduct, sourceVariant, destinationVariant };
  }

  const sourceLevel = await prisma.stockLevel.create({
    data: { storeId: store.id, productId: sourceProduct.id, warehouseId: warehouse.id, quantityOnHand: 2, quantityReserved: source.reserved ?? 1 },
  });
  const destinationLevel = await prisma.stockLevel.create({
    data: { storeId: store.id, productId: destinationProduct.id, warehouseId: warehouse.id, quantityOnHand: 0 },
  });
  return { store, actor, warehouse, sourceProduct, destinationProduct, sourceLevel, destinationLevel };
}

after(async () => {
  for (const storeId of storeIds) {
    await prisma.auditLog.deleteMany({ where: { storeId } });
    await prisma.stockMovement.deleteMany({ where: { storeId } });
    await prisma.stockConversion.deleteMany({ where: { storeId } });
    await prisma.stockLevel.deleteMany({ where: { storeId } });
    await prisma.productVariant.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.warehouse.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  if (actorIds.length) await prisma.user.deleteMany({ where: { id: { in: actorIds } } });
  await prisma.$disconnect();
});

function command(fx: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}) {
  return {
    idempotencyKey: tag(`convert-${seq}`),
    sourceProductId: fx.sourceProduct.id,
    ...("sourceVariant" in fx && fx.sourceVariant ? { sourceVariantId: fx.sourceVariant.id } : {}),
    destinationProductId: fx.destinationProduct.id,
    ...("destinationVariant" in fx && fx.destinationVariant ? { destinationVariantId: fx.destinationVariant.id } : {}),
    warehouseId: fx.warehouse.id,
    sourceQuantity: 1,
    outputQuantity: 5,
    reason: "Repack rice",
    ...patch,
  };
}

test("product conversion atomically writes both ledger legs, transfers cost, and is idempotent", async () => {
  const fx = await fixture();
  const input = command(fx);
  const first = await svc.convert(fx.store.id, fx.actor.id, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  assert.equal(first.value.sourceBalanceAfter, 1);
  assert.equal(first.value.outputBalanceAfter, 5);
  assert.equal(first.value.wasteBaseQuantity, 0);

  const levels = await prisma.stockLevel.findMany({ where: { storeId: fx.store.id } });
  assert.equal(levels.find((l) => l.productId === fx.sourceProduct.id)?.quantityOnHand, 1);
  assert.equal(levels.find((l) => l.productId === fx.destinationProduct.id)?.quantityOnHand, 5);
  const rows = await prisma.stockMovement.findMany({ where: { storeId: fx.store.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(rows.map((m) => [m.type, m.delta]), [["CONVERSION_OUT", -1], ["CONVERSION_IN", 5]]);
  assert.equal(rows[0]?.conversionId, first.value.conversionId);
  assert.equal(rows[1]?.conversionId, first.value.conversionId);
  assert.equal((await prisma.product.findUnique({ where: { id: fx.destinationProduct.id } }))?.costMinor, 20000);
  assert.equal((await prisma.auditLog.findMany({ where: { storeId: fx.store.id, action: "stock.convert" } })).length, 1);

  const replay = await svc.convert(fx.store.id, fx.actor.id, input);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.value.conversionId, first.value.conversionId);
  assert.equal((await prisma.stockMovement.count({ where: { storeId: fx.store.id } })), 2, "retry cannot duplicate stock movements");
});

test("variant conversion supports actual yield and requires a waste reason for short yield", async () => {
  const fx = await fixture({ variant: true });
  if (!("sourceVariant" in fx) || !("destinationVariant" in fx)) throw new Error("variant fixture missing variants");
  const destinationVariant = fx.destinationVariant;
  if (!destinationVariant) throw new Error("destination variant fixture missing");
  const input = command(fx, { outputQuantity: 4, wasteReason: "spillage during repacking" });
  const result = await svc.convert(fx.store.id, fx.actor.id, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.sourceBalanceAfter, 1);
  assert.equal(result.value.outputBalanceAfter, 4);
  assert.equal(result.value.wasteBaseQuantity, 5000);
  const conversion = await prisma.stockConversion.findUnique({ where: { id: result.value.conversionId } });
  assert.equal(conversion?.wasteValueMinor, 20000);
  assert.equal(conversion?.wasteReason, "spillage during repacking");
  assert.equal((await prisma.productVariant.findUnique({ where: { id: destinationVariant.id } }))?.costMinor, 20000);

  const noReason = await svc.convert(fx.store.id, fx.actor.id, command(fx, { outputQuantity: 4, idempotencyKey: tag("no-waste-reason") }));
  assert.equal(noReason.ok, false);
  if (!noReason.ok) assert.match(JSON.stringify(noReason.error), /reason/i);
});

test("conversion rejects over-yield and reserved source stock without mutating balances", async () => {
  const fx = await fixture({ reserved: 2 });
  if (!("sourceLevel" in fx) || !("destinationLevel" in fx)) throw new Error("product fixture missing stock levels");
  const sourceLevel = fx.sourceLevel;
  const destinationLevel = fx.destinationLevel;
  if (!sourceLevel || !destinationLevel) throw new Error("product stock fixture missing levels");
  const over = await svc.convert(fx.store.id, fx.actor.id, command(fx, { outputQuantity: 6 }));
  assert.equal(over.ok, false);
  const unavailable = await svc.convert(fx.store.id, fx.actor.id, command(fx, { outputQuantity: 5, idempotencyKey: tag("reserved") }));
  assert.equal(unavailable.ok, false);
  const source = await prisma.stockLevel.findUnique({ where: { id: sourceLevel.id } });
  const destination = await prisma.stockLevel.findUnique({ where: { id: destinationLevel.id } });
  assert.equal(source?.quantityOnHand, 2);
  assert.equal(destination?.quantityOnHand, 0);
  assert.equal(await prisma.stockMovement.count({ where: { storeId: fx.store.id } }), 0);
});

test("conversion cannot consume or produce stock across stores", async () => {
  const storeA = await fixture();
  const storeB = await fixture();
  if (!("sourceLevel" in storeB) || !("destinationLevel" in storeB)) throw new Error("product fixture missing stock levels");
  const storeBSourceLevel = storeB.sourceLevel;
  const storeBDestinationLevel = storeB.destinationLevel;
  if (!storeBSourceLevel || !storeBDestinationLevel) throw new Error("other store stock fixtures missing levels");
  const crossStore = await svc.convert(storeA.store.id, storeA.actor.id, {
    ...command(storeA),
    destinationProductId: storeB.destinationProduct.id,
    idempotencyKey: tag("cross-store"),
  });
  assert.equal(crossStore.ok, false);
  if (!crossStore.ok) assert.equal(crossStore.error.type, "not_found");

  const otherStoreSource = await prisma.stockLevel.findUnique({ where: { id: storeBSourceLevel.id } });
  const otherStoreTarget = await prisma.stockLevel.findUnique({ where: { id: storeBDestinationLevel.id } });
  assert.equal(otherStoreSource?.quantityOnHand, 2);
  assert.equal(otherStoreTarget?.quantityOnHand, 0);
  assert.equal(await prisma.stockMovement.count({ where: { storeId: { in: [storeA.store.id, storeB.store.id] } } }), 0);
});

test("matching base units are insufficient when products belong to different conversion families", async () => {
  const fx = await fixture();
  await prisma.product.update({ where: { id: fx.destinationProduct.id }, data: { stockConversionFamily: "coffee" } });
  const result = await svc.convert(fx.store.id, fx.actor.id, command(fx));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(JSON.stringify(result.error), /same configured conversion family/i);
  assert.equal(await prisma.stockMovement.count({ where: { storeId: fx.store.id } }), 0);
});

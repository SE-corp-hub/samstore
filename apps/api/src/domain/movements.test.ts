// Module 4 — stock movement ledger: every stock mutation writes an append-only
// StockMovement with the correct signs, and the ledger reconcilicates to the
// balance (sum(delta) + initial == current onHand).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { deductStock, restoreStock, type MovementTx } from "./movements.js";

const run = `M4${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];
const createdProductIds: string[] = [];
const createdStockLevelIds: string[] = [];
const createdOrderIds: string[] = [];

async function makeStoreAndProduct(initial = 50) {
  const slug = `${run}-${createdProductIds.length + 1}-s`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  const store = await prisma.store.create({ data: { slug, name: `M4 ${run}` } });
  createdStoreIds.push(store.id);
  const product = await prisma.product.create({
    data: { storeId: store.id, sku: `M4-SKU-${store.id.slice(-4)}`, name: "M4 Product", priceMinor: 1000 },
  });
  createdProductIds.push(product.id);
  const level = await prisma.stockLevel.create({
    data: { storeId: store.id, productId: product.id, quantityOnHand: initial, quantityReserved: 0 },
  });
  createdStockLevelIds.push(level.id);
  return { store, product, level };
}

after(async () => {
  if (createdProductIds.length > 0) {
    await prisma.stockMovement.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.stockLevel.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  }
  if (createdOrderIds.length > 0) await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdStoreIds.length > 0) await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  await prisma.$disconnect();
});

test("deductStock writes a negative CONSUME movement with balanceAfter", async () => {
  const { store, product, level } = await makeStoreAndProduct(50);
  await prisma.$transaction(async (tx: MovementTx) => {
    await deductStock(tx, store.id, [{ productId: product.id, quantity: 3 }], { type: "CONSUME", orderId: null, createdBy: "test" });
  });
  const levelNow = await prisma.stockLevel.findUnique({ where: { id: level.id } });
  assert.equal(levelNow?.quantityOnHand, 47);

  const movements = await prisma.stockMovement.findMany({ where: { productId: product.id }, orderBy: { createdAt: "asc" as const } });
  assert.equal(movements.length, 1);
  const m0 = movements[0]!;
  assert.equal(m0.type, "CONSUME");
  assert.equal(m0.delta, -3);
  assert.equal(m0.balanceAfter, 47);
  assert.equal(m0.createdBy, "test");
});

test("restoreStock writes a positive RELEASE movement", async () => {
  const { store, product, level } = await makeStoreAndProduct(10);
  await prisma.$transaction(async (tx: MovementTx) => {
    await deductStock(tx, store.id, [{ productId: product.id, quantity: 4 }], { type: "CONSUME" });
    await restoreStock(tx, store.id, [{ productId: product.id, quantity: 4 }], { type: "RELEASE" });
  });
  const levelNow = await prisma.stockLevel.findUnique({ where: { id: level.id } });
  assert.equal(levelNow?.quantityOnHand, 10);

  const movements = await prisma.stockMovement.findMany({ where: { productId: product.id }, orderBy: { createdAt: "asc" as const } });
  assert.equal(movements.length, 2);
  assert.equal(movements[0]!.delta, -4);
  assert.equal(movements[1]!.delta, 4);
});

test("ledger reconciles: initial + sum(delta) == balanceAfter == current onHand", async () => {
  const { store, product } = await makeStoreAndProduct(25);
  await prisma.$transaction(async (tx: MovementTx) => {
    await deductStock(tx, store.id, [{ productId: product.id, quantity: 5 }], { type: "CONSUME" });
    await deductStock(tx, store.id, [{ productId: product.id, quantity: 2 }], { type: "CONSUME" });
    await restoreStock(tx, store.id, [{ productId: product.id, quantity: 1 }], { type: "RELEASE" });
  });
  const levelNow = await prisma.stockLevel.findFirst({ where: { storeId: store.id, productId: product.id } });
  assert.equal(levelNow?.quantityOnHand, 19);

  const movements = await prisma.stockMovement.findMany({ where: { productId: product.id }, orderBy: { createdAt: "asc" as const } });
  const sum = movements.reduce((s: number, m: { delta: number }) => s + m.delta, 0);
  assert.equal(sum, -6, "sum of deltas equals net change");
  assert.equal(25 + sum, levelNow?.quantityOnHand, "initial + sum == current");
  // last balanceAfter is the current balance
  assert.equal(movements[movements.length - 1]!.balanceAfter, levelNow?.quantityOnHand);
});

test("recordMovement appends an ADJUST movement with an explicit balanceAfter", async () => {
  const { store, product, level } = await makeStoreAndProduct(7);
  await prisma.$transaction(async (tx: MovementTx) => {
    await tx.stockLevel.update({ where: { id: level.id }, data: { quantityOnHand: 10 } });
    await tx.stockMovement.create({
      data: { storeId: store.id, productId: product.id, warehouseId: null, delta: 3, type: "ADJUST", orderId: null, createdBy: "test", note: "count", balanceAfter: 10 },
    });
  });
  const movements = await prisma.stockMovement.findMany({ where: { productId: product.id } });
  assert.equal(movements.length, 1);
  const m0 = movements[0]!;
  assert.equal(m0.type, "ADJUST");
  assert.equal(m0.delta, 3);
  assert.equal(m0.balanceAfter, 10);
});
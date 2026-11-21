// Inventory value (2026-11-21 bug hunt): after "Open sacks", the kilo rice showed a value 1000×
// too big — its stock is kept in grams but its cost is per kilo. Value must be kilos × cost per kilo.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { InventoryService } from "./inventory.service.js";
import { ResackService } from "../resack/resack.service.js";
import type { Actor } from "../people/people.service.js";

const run = `INV${Date.now()}${Math.floor(Math.random() * 1000)}`.toLowerCase();
const storeIds: string[] = [];

after(async () => {
  const where = { storeId: { in: storeIds } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.resackOutput.deleteMany({ where });
  await prisma.resackJob.deleteMany({ where });
  await prisma.stockMovement.deleteMany({ where });
  await prisma.stockLevel.deleteMany({ where });
  await prisma.product.deleteMany({ where });
  await prisma.storeCounter.deleteMany({ where });
  await prisma.storeSettings.deleteMany({ where });
  await prisma.warehouse.deleteMany({ where });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

test("Open a sack, then Inventory: 25 kg of kilo rice at ₱52/kg is worth ₱1,300 (not ₱1,300,000)", async () => {
  const store = await prisma.store.create({ data: { name: `${run} store`, slug: `${run}-s`, status: "ACTIVE" } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true, sellPerKilo: true } });
  const sack = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25", name: "Sinandomeng 25kg", priceMinor: 135_000, costMinor: 130_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const kilo = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25-KILO", name: "Sinandomeng · per kilo", priceMinor: 5_600, costMinor: 0, stockBaseUnit: "g", stockBaseQuantity: 1, soldByWeight: true, kiloOfId: sack.id } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sack.id, warehouseId: s1.id, quantityOnHand: 4 } });
  const owner: Actor = { userId: `${run}-owner`, role: "OWNER", homeLocationId: null };
  const opened = await new ResackService().openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: kilo.id });
  assert.equal(opened.ok, true, JSON.stringify(opened));

  const inv = await new InventoryService().list(store.id);
  const row = (id: string) => inv.items.find((i) => i.id === id)!;
  assert.equal(row(kilo.id).quantityOnHand, 25_000, "25 kg, kept in grams");
  assert.equal(row(kilo.id).costMinor, 5_200, "₱52 per kilo");
  assert.equal(row(kilo.id).valueMinor, 130_000, "25 kg × ₱52 = ₱1,300");
  assert.equal(row(sack.id).valueMinor, 3 * 130_000, "3 sacks × ₱1,300");
  assert.equal(inv.totalValueMinor, 4 * 130_000, "opening a sack does not change what the stock is worth");
});

test("Store counts cost per location: each shelf is valued at its own cost", async () => {
  const store = await prisma.store.create({ data: { name: `${run} pl`, slug: `${run}-p`, status: "ACTIVE" } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, costMode: "PER_LOCATION" } });
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const sack = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25", name: "Sinandomeng 25kg", priceMinor: 135_000, costMinor: 130_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sack.id, warehouseId: s1.id, quantityOnHand: 2, costMinor: 125_000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sack.id, warehouseId: s2.id, quantityOnHand: 1 } });
  const inv = await new InventoryService().list(store.id);
  assert.equal(inv.items[0]!.valueMinor, 2 * 125_000 + 130_000);
  const onlyS1 = await new InventoryService().list(store.id, { warehouseId: s1.id });
  assert.equal(onlyS1.items[0]!.valueMinor, 250_000);
});

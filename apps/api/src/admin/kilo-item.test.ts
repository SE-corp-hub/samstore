// Sell per kilo (2026-11-20): "Also sell per kilo" on a sack rice makes its kilo item, priced per
// kilo at every store from that store's sack price; off hides it; small packs are refused.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ProductAdminService } from "./product-admin.service.js";

const svc = new ProductAdminService();
const run = `KILO${Date.now()}${Math.floor(Math.random() * 1000)}`.toLowerCase();
const storeIds: string[] = [];

after(async () => {
  const where = { storeId: { in: storeIds } };
  await prisma.locationPrice.deleteMany({ where });
  await prisma.product.deleteMany({ where });
  await prisma.warehouse.deleteMany({ where });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

test("Also sell per kilo: makes the kilo item (price sack ÷ 25 rounded up + ₱2, cost ÷ 25), per-store prices, off hides, on brings it back", async () => {
  const store = await prisma.store.create({ data: { name: `${run} store`, slug: `${run}-s`, status: "ACTIVE" } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const sack = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25", name: "Samrice Sinandomeng 25kg", priceMinor: 135_000, costMinor: 130_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "bigas" } });
  const pack = await prisma.product.create({ data: { storeId: store.id, sku: "SIN5", name: "Samrice Sinandomeng 5kg", priceMinor: 27_000, costMinor: 25_000, stockBaseUnit: "g", stockBaseQuantity: 5_000 } });
  await prisma.locationPrice.create({ data: { storeId: store.id, productId: sack.id, warehouseId: s2.id, priceMinor: 140_000 } });

  const on = await svc.setKiloItem(store.id, sack.id, true);
  assert.equal(on.ok, true, JSON.stringify(on));
  if (!on.ok) return;
  const item = await prisma.product.findUniqueOrThrow({ where: { id: on.value.kiloItem!.id } });
  assert.equal(item.name, "Samrice Sinandomeng · per kilo");
  assert.equal(item.sku, "SIN25-KILO");
  assert.deepEqual([item.priceMinor, item.costMinor], [5_600, 5_200], "₱1,350 ÷ 25 = ₱54 + ₱2; cost ₱1,300 ÷ 25 = ₱52");
  assert.deepEqual([item.stockBaseUnit, item.stockBaseQuantity, item.soldByWeight, item.kiloOfId, item.unit], ["g", 1, true, sack.id, "kilo"]);
  const own = await prisma.locationPrice.findFirst({ where: { productId: item.id, warehouseId: s2.id } });
  assert.equal(own?.priceMinor, 5_800, "Store 2's sack ₱1,400 ÷ 25 = ₱56 + ₱2");
  assert.equal(await prisma.locationPrice.count({ where: { productId: item.id, warehouseId: s1.id } }), 0, "Store 1 has no own sack price: the main kilo price");

  const list = await svc.list(store.id);
  assert.equal(list.find((p) => p.id === sack.id)?.kiloItem?.id, item.id, "the sack shows its kilo item");

  const again = await svc.setKiloItem(store.id, sack.id, true);
  assert.equal(again.ok && again.value.kiloItem?.id, item.id, "a second tap makes no second item");

  const off = await svc.setKiloItem(store.id, sack.id, false);
  assert.equal(off.ok, true);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).isActive, false, "off hides it");
  await prisma.product.update({ where: { id: item.id }, data: { priceMinor: 6_000 } });
  const back = await svc.setKiloItem(store.id, sack.id, true);
  assert.equal(back.ok && back.value.kiloItem?.id, item.id, "on brings the same item back");
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: item.id } })).priceMinor, 6_000, "with the price the owner set");

  const small = await svc.setKiloItem(store.id, pack.id, true);
  assert.equal(small.ok, false, "5 kg packs stay packs");
  const kiloOfKilo = await svc.setKiloItem(store.id, item.id, true);
  assert.equal(kiloOfKilo.ok, false, "a kilo item is already per kilo");
});

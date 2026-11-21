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
  await prisma.product.updateMany({ where, data: { categoryId: null } });
  await prisma.rackSack.deleteMany({ where });
  await prisma.stockLevel.deleteMany({ where });
  await prisma.product.deleteMany({ where });
  await prisma.category.deleteMany({ where });
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
  const group = await prisma.category.findUniqueOrThrow({ where: { id: item.categoryId! } });
  assert.deepEqual([group.name, group.slug], ["1 kg", "1-kg"], "kilo items go in the 1 kg group");
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

test("Display rack: a kilo item (also one made by hand) takes several sacks; packs and other kilo rice are refused; Off with kilos left asks first", async () => {
  const store = await prisma.store.create({ data: { name: `${run} rack`, slug: `${run}-r`, status: "ACTIVE" } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const sin = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25", name: "Sinandomeng 25kg", priceMinor: 120_000, costMinor: 115_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const mik = await prisma.product.create({ data: { storeId: store.id, sku: "MIK25", name: "Mikami yellow 25kg", priceMinor: 112_000, costMinor: 107_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const pack = await prisma.product.create({ data: { storeId: store.id, sku: "SIN5", name: "Sinandomeng 5kg", priceMinor: 27_000, costMinor: 25_000, stockBaseUnit: "g", stockBaseQuantity: 5_000 } });
  // A loose rice the owner made by hand before (no own sack): it becomes the ₱50 rack.
  const rack = await prisma.product.create({ data: { storeId: store.id, sku: "RACK50", name: "Rack ₱50", priceMinor: 5_000, costMinor: 0, stockBaseUnit: "g", stockBaseQuantity: 1, soldByWeight: true } });

  const set = await svc.setRackSacks(store.id, rack.id, [sin.id, mik.id, sin.id]);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual((await svc.list(store.id)).find((p) => p.id === rack.id)?.rackSackIds?.sort(), [sin.id, mik.id].sort());
  assert.equal((await svc.setRackSacks(store.id, rack.id, [pack.id])).ok, false, "5 kg packs do not go on a rack");
  assert.equal((await svc.setRackSacks(store.id, sin.id, [mik.id])).ok, false, "only kilo rice is a rack");
  const less = await svc.setRackSacks(store.id, rack.id, [mik.id]);
  assert.equal(less.ok, true);
  assert.equal(await prisma.rackSack.count({ where: { storeId: store.id, kiloProductId: rack.id } }), 1, "unticked sack is taken off");

  // Off on a sack whose kilo item still has kilos: refused with the kilos, then "hide anyway".
  const own1kg = await prisma.category.create({ data: { storeId: store.id, name: "1kg", slug: "1kg" } });
  const on = await svc.setKiloItem(store.id, sin.id, true);
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: on.value.kiloItem!.id } })).categoryId, own1kg.id, "the owner's own 1kg group is used");
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: on.value.kiloItem!.id, warehouseId: s1.id, quantityOnHand: 7_500 } });
  const off = await svc.setKiloItem(store.id, sin.id, false);
  assert.equal(off.ok, false, "kilos left: asks first");
  if (!off.ok) assert.match(JSON.stringify(off.error), /7\.5 kg/);
  const anyway = await svc.setKiloItem(store.id, sin.id, false, true);
  assert.equal(anyway.ok, true, "hide anyway");
});

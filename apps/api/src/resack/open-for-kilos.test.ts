// Sell per kilo (2026-11-20): "Open a sack" on POS — one sack of a kilo rice's own rice leaves the
// shelf and its whole weight comes in as kilo rice at the same store; no porter, no signature.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ResackService } from "./resack.service.js";
import type { Actor } from "../people/people.service.js";

const svc = new ResackService();
const run = `OPK${Date.now()}${Math.floor(Math.random() * 1000)}`.toLowerCase();
const storeIds: string[] = [];

after(async () => {
  const where = { storeId: { in: storeIds } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.resackOutput.deleteMany({ where });
  await prisma.resackJob.deleteMany({ where });
  await prisma.stockMovement.deleteMany({ where });
  await prisma.stockLevel.deleteMany({ where });
  await prisma.rackSack.deleteMany({ where });
  await prisma.product.deleteMany({ where });
  await prisma.storeCounter.deleteMany({ where });
  await prisma.warehouse.deleteMany({ where });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

test("Open a sack on POS: 1 sack out, 25 kg of kilo rice in, kilo cost = sack cost ÷ 25, refused for other stores' staff", async () => {
  const store = await prisma.store.create({ data: { name: `${run} store`, slug: `${run}-s`, status: "ACTIVE" } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true, sellPerKilo: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const sack = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25", name: "Sinandomeng 25kg", priceMinor: 135_000, costMinor: 130_000, stockBaseUnit: "g", stockBaseQuantity: 25_000, stockConversionFamily: "bigas" } });
  const kilo = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25-KILO", name: "Sinandomeng · per kilo", priceMinor: 5_600, costMinor: 0, stockBaseUnit: "g", stockBaseQuantity: 1, soldByWeight: true, stockConversionFamily: "bigas", kiloOfId: sack.id } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sack.id, warehouseId: s1.id, quantityOnHand: 4 } });
  const owner: Actor = { userId: `${run}-owner`, role: "OWNER", homeLocationId: null };
  const staff2: Actor = { userId: `${run}-staff2`, role: "STAFF", homeLocationId: s2.id };

  const r = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: kilo.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.value.gramsIn, 25_000);
  assert.equal(r.value.kiloGramsLeft, 25_000);
  const level = (productId: string) => prisma.stockLevel.findFirst({ where: { storeId: store.id, productId, warehouseId: s1.id } }).then((l) => l?.quantityOnHand ?? null);
  assert.equal(await level(sack.id), 3, "one sack left the shelf");
  assert.equal(await level(kilo.id), 25_000, "25 kg of kilo rice came in");
  const job = await prisma.resackJob.findFirstOrThrow({ where: { storeId: store.id }, include: { outputs: true } });
  assert.deepEqual([job.status, job.openSack, job.lossGrams, job.kargadorId, job.outputs[0]?.grams], ["FINISHED", true, 0, null, 25_000]);
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: kilo.id } })).costMinor, 5_200, "₱1,300 ÷ 25");

  const other = await svc.openSackForKilos(store.id, staff2, { locationId: s1.id, kiloProductId: kilo.id });
  assert.equal(other.ok, false, "staff open sacks only at their own store");
  const notKilo = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: sack.id });
  assert.equal(notKilo.ok, false, "only a kilo rice can be filled");

  // Filling the display rack: 2 sacks at once → 50 kg more, 2 sacks fewer; 0 or 51 are refused.
  const two = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: kilo.id, sacks: 2 });
  assert.equal(two.ok, true, JSON.stringify(two));
  if (!two.ok) return;
  assert.deepEqual([two.value.sacks, two.value.gramsIn, two.value.kiloGramsLeft], [2, 50_000, 75_000]);
  assert.equal(await level(sack.id), 1, "two more sacks left the shelf");
  assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: kilo.id } })).costMinor, 5_200, "still ₱1,300 ÷ 25 per kilo");
  for (const bad of [0, 51, 1.5, "2"]) {
    const r2 = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: kilo.id, sacks: bad });
    assert.equal(r2.ok, false, `sacks ${String(bad)} refused`);
  }
});

test("Display rack ₱50: filled from two rice; asks which; cost = average by weight; a sack the count does not show still opens (below zero, fixed at the count)", async () => {
  const store = await prisma.store.create({ data: { name: `${run} rack`, slug: `${run}-r`, status: "ACTIVE" } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true, sellPerKilo: true } });
  const sin = await prisma.product.create({ data: { storeId: store.id, sku: "SIN25", name: "Sinandomeng 25kg", priceMinor: 135_000, costMinor: 130_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const mik = await prisma.product.create({ data: { storeId: store.id, sku: "MIK25", name: "Mikami yellow 25kg", priceMinor: 125_000, costMinor: 120_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const other = await prisma.product.create({ data: { storeId: store.id, sku: "ALS25", name: "Alsa 25kg", priceMinor: 125_000, costMinor: 120_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const rack = await prisma.product.create({ data: { storeId: store.id, sku: "RACK50", name: "Rack ₱50", priceMinor: 5_000, costMinor: 0, stockBaseUnit: "g", stockBaseQuantity: 1, soldByWeight: true } });
  await prisma.rackSack.createMany({ data: [{ storeId: store.id, kiloProductId: rack.id, sackProductId: sin.id }, { storeId: store.id, kiloProductId: rack.id, sackProductId: mik.id }] });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sin.id, warehouseId: s1.id, quantityOnHand: 2 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: mik.id, warehouseId: s1.id, quantityOnHand: 0 } });
  const owner: Actor = { userId: `${run}-owner2`, role: "OWNER", homeLocationId: null };
  const level = (productId: string) => prisma.stockLevel.findFirst({ where: { storeId: store.id, productId, warehouseId: s1.id } }).then((l) => l?.quantityOnHand ?? null);
  const cost = () => prisma.product.findUniqueOrThrow({ where: { id: rack.id } }).then((p) => p.costMinor);

  const which = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: rack.id });
  assert.equal(which.ok, false, "two rice go on this rack: asks which");
  const notOnRack = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: rack.id, sackProductId: other.id });
  assert.equal(notOnRack.ok, false, "Alsa is not ticked for this rack");

  const a = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: rack.id, sackProductId: sin.id });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(await cost(), 5_200, "₱1,300 ÷ 25");
  // Mikami: the count shows none here and there is no Buffer — it still opens; the shelf goes below zero.
  const b = await svc.openSackForKilos(store.id, owner, { locationId: s1.id, kiloProductId: rack.id, sackProductId: mik.id });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(await level(mik.id), -1, "1 sack below zero until the next count");
  assert.equal(await level(rack.id), 50_000);
  assert.equal(await cost(), 5_000, "25 kg at ₱52 + 25 kg at ₱48 = ₱50 a kilo");
  assert.equal(await level(sin.id), 1);
});

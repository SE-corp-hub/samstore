// P2c: admin variant + add-on management (real DB) — CRUD, SKU conflicts, stock
// ADJUST ledger, delete-when-reserved guard, and tenant isolation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { ProductAdminService } from "./product-admin.service.js";

const run = `P2AD${Date.now().toString().slice(-6)}`;
const storeIds: string[] = [];

after(async () => {
  for (const storeId of storeIds) {
    await prisma.stockMovement.deleteMany({ where: { storeId } });
    await prisma.productAddonOption.deleteMany({ where: { addon: { storeId } } });
    await prisma.productAddon.deleteMany({ where: { storeId } });
    await prisma.productVariant.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.stockLevel.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
  }
  await prisma.$disconnect();
});

const svc = new ProductAdminService();

async function makeStore(name: string) {
  const store = await prisma.store.create({ data: { slug: `${run}-${name}`.toLowerCase(), name } });
  storeIds.push(store.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${name.toUpperCase()}-PROD`, name, priceMinor: 10000 } });
  return { store, product };
}

test("addVariant creates a variant with opening stock + RECEIPT movement", async () => {
  const fx = await makeStore("alpha");
  const r = await svc.addVariant(fx.store.id, fx.product.id, { name: "Large", sku: "ALPHA-LG", priceMinor: 12000, quantityOnHand: 10 });
  assert.equal(r.ok, true);
  const v = await prisma.productVariant.findUnique({ where: { id: r.value.id } });
  assert.ok(v);
  assert.equal(v.quantityOnHand, 10);
  assert.equal(v.priceMinor, 12000);
  const mv = await prisma.stockMovement.findFirst({ where: { variantId: v.id, type: "RECEIPT" } });
  assert.ok(mv, "opening stock audited");
  assert.equal(mv?.delta, 10);
});

test("updateVariant sets price/name and absolute stock with an ADJUST movement", async () => {
  const fx = await makeStore("bravo");
  const created = await svc.addVariant(fx.store.id, fx.product.id, { name: "Small", sku: "BRAVO-SM", priceMinor: 9000, quantityOnHand: 5 });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const id = created.value.id;
  const up = await svc.updateVariant(fx.store.id, id, { priceMinor: 9500, name: "Small 2", quantityOnHand: 12 });
  assert.equal(up.ok, true);
  const v = await prisma.productVariant.findUnique({ where: { id } });
  assert.equal(v?.priceMinor, 9500);
  assert.equal(v?.name, "Small 2");
  assert.equal(v?.quantityOnHand, 12);
  const adj = await prisma.stockMovement.findFirst({ where: { variantId: id, type: "ADJUST" } });
  assert.ok(adj);
  assert.equal(adj?.delta, 7, "12 - 5");
  assert.equal(adj?.balanceAfter, 12);
});

test("duplicate SKU is a conflict; cannot set stock below reserved", async () => {
  const fx = await makeStore("charlie");
  await svc.addVariant(fx.store.id, fx.product.id, { name: "A", sku: "CHR-A", priceMinor: 1000, quantityOnHand: 3 });
  const dup = await svc.addVariant(fx.store.id, fx.product.id, { name: "B", sku: "CHR-A", priceMinor: 1000 });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.error.type, "conflict");

  const a = await prisma.productVariant.findFirst({ where: { storeId: fx.store.id, sku: "CHR-A" } });
  assert.ok(a);
  await prisma.productVariant.update({ where: { id: a.id }, data: { quantityReserved: 2 } });
  const below = await svc.updateVariant(fx.store.id, a.id, { quantityOnHand: 1 });
  assert.equal(below.ok, false);
  if (!below.ok) assert.equal(below.error.type, "conflict");
});

test("deleteVariant is refused while reserved, allowed when clear", async () => {
  const fx = await makeStore("delta");
  const c = await svc.addVariant(fx.store.id, fx.product.id, { name: "X", sku: "DEL-X", priceMinor: 1000, quantityOnHand: 3 });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  await prisma.productVariant.update({ where: { id: c.value.id }, data: { quantityReserved: 1 } });
  const blocked = await svc.deleteVariant(fx.store.id, c.value.id);
  assert.equal(blocked.ok, false);
  await prisma.productVariant.update({ where: { id: c.value.id }, data: { quantityReserved: 0 } });
  const ok = await svc.deleteVariant(fx.store.id, c.value.id);
  assert.equal(ok.ok, true);
});

test("add-on group + option CRUD", async () => {
  const fx = await makeStore("echo");
  const g = await svc.addAddon(fx.store.id, fx.product.id, {
    name: "Extras", required: true,
    options: [{ name: "Shot", priceMinor: 2000 }, { name: "Milk", priceMinor: 3000 }],
  });
  assert.equal(g.ok, true);
  const group = await prisma.productAddon.findUnique({ where: { id: g.value.id }, include: { options: true } });
  assert.equal(group?.options.length, 2);
  const opt = group?.options.find((o) => o.name === "Shot");
  assert.ok(opt);
  const upd = await svc.updateAddonOption(fx.store.id, opt!.id, { priceMinor: 2500 });
  assert.equal(upd.ok, true);
  const delOpt = await svc.deleteAddonOption(fx.store.id, opt!.id);
  assert.equal(delOpt.ok, true);
  const delG = await svc.deleteAddon(fx.store.id, g.value.id);
  assert.equal(delG.ok, true);
});

test("tenant isolation: a variant from another store is invisible", async () => {
  const fxA = await makeStore("foxtrot");
  const fxB = await makeStore("golf");
  const c = await svc.addVariant(fxA.store.id, fxA.product.id, { name: "OnlyA", sku: "FOX-OA", priceMinor: 1000 });
  assert.equal(c.ok, true);
  if (!c.ok) return;
  const look = await svc.updateVariant(fxB.store.id, c.value.id, { name: "stolen" });
  assert.equal(look.ok, false);
  if (!look.ok) assert.equal(look.error.type, "not_found");
  const del = await svc.deleteVariant(fxB.store.id, c.value.id);
  assert.equal(del.ok, false);
});
// Rice Ops M12 — the go-live import against the real DB: a file with a bad row writes
// nothing; a good one lands products + per-location prices, customers + opening utang,
// staff + PINs, kargadors; running it again changes nothing and never doubles utang;
// and nothing lands in another store.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { RiceImportService } from "./rice-import.service.js";

const run = `M12R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
const phones: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.creditEntry.deleteMany({ where });
    await prisma.storeCustomer.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.kargador.deleteMany({ where });
    const members = await prisma.userStore.findMany({ where, select: { userId: true } });
    userIds.push(...members.map((m) => m.userId));
    await prisma.userStore.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (phones.length) await prisma.customer.deleteMany({ where: { phone: { in: phones } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: [...new Set(userIds)] } } });
  await prisma.$disconnect();
});

let phoneSeq = Math.floor(Math.random() * 9_000);
function phone() {
  phoneSeq += 1;
  const local = `0919${String(Date.now() % 10_000).padStart(4, "0")}${String(phoneSeq % 1_000).padStart(3, "0")}`;
  phones.push(`+63${local.slice(1)}`);
  return local;
}

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `M12 ${run}` } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const wh = await prisma.warehouse.create({ data: { storeId: store.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" } });
  const owner = await prisma.user.create({ data: { phone: `+63${phone().slice(1)}`, passwordHash: "x", name: "Aling Nena", role: "STORE_OWNER" } });
  userIds.push(owner.id);
  await prisma.userStore.create({ data: { userId: owner.id, storeId: store.id, role: "OWNER" } });
  return { storeId: store.id, s1: s1.id, s2: s2.id, wh: wh.id, ownerId: owner.id };
}

test("M12: a bad row anywhere means nothing is written; a good import lands everything once", async () => {
  const fx = await fixture();
  const svc = new RiceImportService();
  const [rosa, tomas, lorna, jun] = [phone(), phone(), phone(), phone()];
  const sku = `${run}-SIN25`.toUpperCase().slice(0, 40);
  const files = {
    products: `sku,name,variety,sold_as,kg_per_sack,cost,price,price_S1,price_S2,price_WH\n${sku},Sinandomeng 25 kg ${run},Sinandomeng,SACK,25,"1,180","1,300",,"1,320","1,250"\n${sku}-K,Sinandomeng kilo ${run},Sinandomeng,KILO,,48,54,,,\n`,
    customers: `name,phone,limit,utang,utang_since\nRosa,${rosa},"5,000","1,250.50",2026-09-01\nTomas,${tomas},,,\n`,
    staff: `name,phone,role,home,pin\nLorna,${lorna},STAFF,S2,0482\nJun,${jun},MANAGER,,\n`,
    kargadors: `name,phone,home,photo_url\nBoy ${run},,WH,\n`,
  };
  const bad = { ...files, kargadors: `name,phone,home,photo_url\nBoy ${run},,S9,\n` };
  const refused = await svc.apply(fx.storeId, fx.ownerId, bad, "2026-10-15");
  assert.equal(refused.ok, false);
  assert.match(refused.plan.errors[0]!.message, /Unknown location/);
  assert.equal(await prisma.product.count({ where: { storeId: fx.storeId } }), 0, "no products written");
  assert.equal(await prisma.storeCustomer.count({ where: { storeId: fx.storeId } }), 0, "no customers written");
  assert.equal(await prisma.userStore.count({ where: { storeId: fx.storeId } }), 1, "only the owner");

  const plan = await svc.plan(fx.storeId, files, "2026-10-15");
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.openingUtangMinor, 125_050);
  const done = await svc.apply(fx.storeId, fx.ownerId, files, "2026-10-15");
  assert.equal(done.ok, true);

  const sack = await prisma.product.findUniqueOrThrow({ where: { storeId_sku: { storeId: fx.storeId, sku } }, select: { id: true, priceMinor: true, costMinor: true, stockBaseUnit: true, stockBaseQuantity: true, soldByWeight: true, stockConversionFamily: true, locationPrices: { select: { warehouseId: true, priceMinor: true } } } });
  assert.equal(sack.priceMinor, 130_000);
  assert.equal(sack.costMinor, 118_000);
  assert.equal(sack.stockBaseQuantity, 25_000);
  assert.equal(sack.stockConversionFamily, "Bigas", "rice joins the Bigas family (resack works on it)");
  assert.deepEqual(new Map(sack.locationPrices.map((l) => [l.warehouseId, l.priceMinor])), new Map([[fx.s2, 132_000], [fx.wh, 125_000]]));
  const kilo = await prisma.product.findUniqueOrThrow({ where: { storeId_sku: { storeId: fx.storeId, sku: `${sku}-K` } }, select: { soldByWeight: true } });
  assert.equal(kilo.soldByWeight, true);
  assert.equal(await prisma.stockLevel.count({ where: { storeId: fx.storeId } }), 0, "no stock is imported — the go-live count is the opening stock");

  const sc = await prisma.storeCustomer.findFirstOrThrow({ where: { storeId: fx.storeId, customer: { phone: `+63${rosa.slice(1)}` } }, select: { id: true, creditBalanceMinor: true, creditLimitMinor: true, creditApproved: true, credit: { select: { type: true, amountMinor: true, createdAt: true } } } });
  assert.equal(sc.creditBalanceMinor, 125_050);
  assert.equal(sc.creditLimitMinor, 500_000);
  assert.equal(sc.creditApproved, true);
  assert.equal(sc.credit.length, 1);
  assert.equal(sc.credit[0]!.type, "purchase", "counts as the oldest utang for reminders and aging");
  assert.equal(sc.credit[0]!.createdAt.toISOString(), "2026-08-31T16:00:00.000Z", "dated Manila midnight of utang_since");

  const lornaUser = await prisma.user.findFirstOrThrow({ where: { phone: `+63${lorna.slice(1)}` }, select: { id: true, pinHash: true, role: true, memberships: { where: { storeId: fx.storeId }, select: { role: true, homeLocationId: true } } } });
  assert.equal(lornaUser.memberships[0]?.role, "STAFF");
  assert.equal(lornaUser.memberships[0]?.homeLocationId, fx.s2);
  assert.ok(lornaUser.pinHash && (await bcrypt.compare("0482", lornaUser.pinHash)), "PIN set");
  assert.equal(done.ok && done.logins.length, 2, "both new staff get a one-time login");
  assert.equal(await prisma.kargador.count({ where: { storeId: fx.storeId, homeLocationId: fx.wh } }), 1);

  const before = await prisma.user.findUniqueOrThrow({ where: { id: lornaUser.id }, select: { tokenVersion: true } });
  const again = await svc.plan(fx.storeId, files, "2026-10-15");
  assert.deepEqual(again.errors, []);
  assert.deepEqual([again.products.create, again.products.update, again.customers.create, again.customers.update, again.staff.create, again.staff.update, again.kargadors.create, again.kargadors.update], [0, 0, 0, 0, 0, 0, 0, 0], "a second run finds nothing to change");
  assert.equal(again.openingUtangMinor, 0);
  const rerun = await svc.apply(fx.storeId, fx.ownerId, files, "2026-10-15");
  assert.equal(rerun.ok && rerun.logins.length, 0, "no new passwords on a re-run");
  assert.equal((await prisma.storeCustomer.findUniqueOrThrow({ where: { id: sc.id }, select: { creditBalanceMinor: true } })).creditBalanceMinor, 125_050, "utang is not doubled");
  assert.equal(await prisma.creditEntry.count({ where: { storeCustomerId: sc.id } }), 1);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: lornaUser.id }, select: { tokenVersion: true } })).tokenVersion, before.tokenVersion, "the same PIN again does not sign Lorna out");

  const changed = await svc.plan(fx.storeId, { customers: files.customers.replace('"1,250.50"', '"2,000"') }, "2026-10-15");
  assert.match(changed.errors[0]?.message ?? "", /already imported/, "a different utang after import is changed in the app, not by file");

  const priceUp = await svc.apply(fx.storeId, fx.ownerId, { products: files.products.replace(',,"1,320","1,250"', ',,,"1,250"') }, "2026-10-15");
  assert.equal(priceUp.ok, true);
  assert.equal(await prisma.locationPrice.count({ where: { productId: sack.id, warehouseId: fx.s2 } }), 0, "a blank price goes back to the main price");

  const sheet = await svc.signoff(fx.storeId, "2026-10-15 09:00");
  assert.equal(sheet.customers.find((c) => c.utangMinor > 0)?.utangSince, "2026-09-01");
  assert.equal(sheet.products.length, 2);
});

test("M12: the import never reaches another store; a sold-as change or the owner in staff.csv is refused", async () => {
  const a = await fixture();
  const b = await fixture();
  const svc = new RiceImportService();
  const shared = phone();
  const sku = `${run}-X`.toUpperCase();
  const r = await svc.apply(a.storeId, a.ownerId, {
    customers: `name,phone,limit,utang,utang_since\nShared,${shared},1000,300,2026-10-01\n`,
    products: `sku,name,sold_as,kg_per_sack,price\n${sku},Dinorado ${run},SACK,50,2800\n`,
  }, "2026-10-15");
  assert.equal(r.ok, true);
  assert.equal(await prisma.storeCustomer.count({ where: { storeId: b.storeId } }), 0, "store B has no customers");
  assert.equal(await prisma.product.count({ where: { storeId: b.storeId } }), 0, "store B has no products");
  const inB = await svc.apply(b.storeId, b.ownerId, { customers: `name,phone\nShared,${shared}\n` }, "2026-10-15");
  assert.equal(inB.ok, true);
  const scB = await prisma.storeCustomer.findFirstOrThrow({ where: { storeId: b.storeId }, select: { creditBalanceMinor: true } });
  assert.equal(scB.creditBalanceMinor, 0, "store A's utang does not follow the person to store B");

  const kilo = await svc.plan(a.storeId, { products: `sku,name,sold_as,price\n${sku},Dinorado ${run},KILO,56\n` }, "2026-10-15");
  assert.match(kilo.errors[0]?.message ?? "", /already sold as SACK/);
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: a.ownerId }, select: { phone: true } });
  const self = await svc.plan(a.storeId, { staff: `name,phone,role,home\nAko,0${owner.phone!.slice(3)},MANAGER,\n` }, "2026-10-15");
  assert.match(self.errors[0]?.message ?? "", /owner/);
});

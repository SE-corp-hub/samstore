// Per-store build, step 7 — the store head, against the real DB.
//   * the owner names a staff login with a store as the head; taking the store away ends it;
//   * the head changes the own store's prices, never under the owner's lowest price
//     (no lowest price set: never under the cost), and cannot go back to a main price that is under it;
//   * the owner side is not held to the lowest price;
//   * the head sees the own store's profit only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { WarehouseService } from "./warehouse.service.js";
import { PeopleService, isHeadOf, loadActor, seesProfitAt } from "../people/people.service.js";
import { bustMemberships } from "../auth/membership-cache.js";

const run = `HEAD${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;
const warehouses = new WarehouseService();
const people = new PeopleService();

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.locationPrice.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Head ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const bt = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const person = async (name: string, role: "OWNER" | "STAFF", homeLocationId: string | null) => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name}@head.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId } });
    return u.id;
  };
  const rice = await prisma.product.create({ data: { storeId: store.id, name: "Test rice 25kg", sku: `${run}-${seq}-R`, priceMinor: 130_000, costMinor: 120_000 } });
  return { storeId: store.id, main: main.id, bt: bt.id, rice: rice.id, owner: await person("owner", "OWNER", null), btStaff: await person("bt", "STAFF", bt.id), loose: await person("loose", "STAFF", null) };
}
const errorsOf = (r: { ok: boolean; error?: unknown }) => ((r as { error?: { errors?: string[] } }).error?.errors ?? []).join(" ");

test("the owner names the head of a store; only a staff login with a store can be one", async () => {
  const fx = await fixture();
  const noStore = await people.updateMember(fx.storeId, fx.loose, { isLocationHead: true }, fx.owner);
  assert.equal(noStore.ok, false, "a login with no store cannot be a head");
  const ownerAsHead = await people.updateMember(fx.storeId, fx.owner, { isLocationHead: true }, fx.owner);
  assert.equal(ownerAsHead.ok, false, "the owner is not a store head");

  assert.equal((await people.updateMember(fx.storeId, fx.btStaff, { isLocationHead: true }, fx.owner)).ok, true);
  await bustMemberships();
  const head = await loadActor(fx.storeId, fx.btStaff, "STAFF");
  assert.equal(isHeadOf(head, fx.bt), true);
  assert.equal(isHeadOf(head, fx.main), false, "head of the own store only");
  assert.equal(seesProfitAt(head, fx.bt), true);
  assert.equal(seesProfitAt(head, fx.main), false, "no profit of another store");
  assert.equal(seesProfitAt(await loadActor(fx.storeId, fx.loose, "STAFF"), fx.bt), false, "plain staff see no profit");

  // Taking the store away ends it.
  assert.equal((await people.updateMember(fx.storeId, fx.btStaff, { homeLocationId: null }, fx.owner)).ok, true);
  const row = await prisma.userStore.findUnique({ where: { userId_storeId: { userId: fx.btStaff, storeId: fx.storeId } }, select: { isLocationHead: true } });
  assert.equal(row?.isLocationHead, false);
});

test("the head cannot price under the owner's lowest price; the owner can", async () => {
  const fx = await fixture();
  // No lowest price yet: the cost (₱1,200) is the limit.
  const underCost = await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, 119_900, fx.btStaff, { asHead: true });
  assert.equal(underCost.ok, false);
  assert.match(errorsOf(underCost), /lowest price/i);
  assert.equal((await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, 125_000, fx.btStaff, { asHead: true })).ok, true);

  // The owner sets ₱1,280 as the lowest.
  assert.equal((await warehouses.setFloorPrice(fx.storeId, fx.rice, 128_000, fx.owner)).ok, true);
  assert.equal((await warehouses.setFloorPrice(fx.storeId, fx.rice, -5, fx.owner)).ok, false);
  const list = await warehouses.listPrices(fx.storeId, fx.bt);
  assert.equal(list.ok && list.value[0]!.lowestPriceMinor, 128_000);
  assert.equal(list.ok && list.value[0]!.floorPriceMinor, 128_000);

  assert.equal((await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, 127_900, fx.btStaff, { asHead: true })).ok, false, "₱1,279 is under ₱1,280");
  assert.equal((await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, 128_000, fx.btStaff, { asHead: true })).ok, true, "exactly the lowest price is fine");
  assert.equal((await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, null, fx.btStaff, { asHead: true })).ok, true, "main price ₱1,300 is above the lowest");

  // A main price under the lowest price: the head cannot fall back to it.
  await warehouses.setFloorPrice(fx.storeId, fx.rice, 135_000, fx.owner);
  await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, 140_000, fx.owner);
  const back = await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, null, fx.btStaff, { asHead: true });
  assert.equal(back.ok, false);
  const kept = await prisma.locationPrice.findFirst({ where: { storeId: fx.storeId, warehouseId: fx.bt, productId: fx.rice } });
  assert.equal(kept?.priceMinor, 140_000, "the refused change left the price alone");

  // The owner side is not held to it.
  assert.equal((await warehouses.setPrice(fx.storeId, fx.bt, fx.rice, 100_000, fx.owner)).ok, true);

  // Removing the lowest price brings the cost back as the limit.
  assert.equal((await warehouses.setFloorPrice(fx.storeId, fx.rice, null, fx.owner)).ok, true);
  const after = await warehouses.listPrices(fx.storeId, fx.bt);
  assert.equal(after.ok && after.value[0]!.lowestPriceMinor, 120_000);
});

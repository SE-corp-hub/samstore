// P5a: delivery zones — domain resolution + admin CRUD + checkout zone pricing.
// Real Prisma, run-scoped fixtures.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { resolveDeliveryZone } from "./zones.js";
import { DeliveryZonesAdminService } from "./zones-admin.service.js";

const zonesAdmin = new DeliveryZonesAdminService();
const run = `P5A${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];

let slugSeq = 0;
async function makeStore() {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} store`, slug: `${run}-${slugSeq}`.toLowerCase(), status: "ACTIVE", settings: { create: { deliveryFeeMinor: 5000 } } },
  });
  createdStoreIds.push(s.id);
  return s;
}

after(async () => {
  for (const storeId of createdStoreIds) {
    try {
      await prisma.deliveryZone.deleteMany({ where: { storeId } });
      await prisma.storeSettings.deleteMany({ where: { storeId } });
      await prisma.store.deleteMany({ where: { id: storeId } });
    } catch {
      // best-effort
    }
  }
  await prisma.$disconnect();
});

test("domain: match, catch-all, and out-of-coverage resolution", () => {
  const zones = [
    { name: "Metro Manila", cityCode: "1374", barangayCodes: ["1", "2"], feeMinor: 9000, etaMinutes: 30 },
    { name: "Rest of PH", cityCode: null, barangayCodes: [], feeMinor: 15000, etaMinutes: 120 },
  ];
  const match = resolveDeliveryZone(zones, "1374", "2");
  assert.equal(match.resolved, true);
  if (match.resolved) assert.equal(match.zone.feeMinor, 9000);

  const allowlistMiss = resolveDeliveryZone(zones, "1374", "999");
  assert.equal(allowlistMiss.resolved, true);
  if (allowlistMiss.resolved) assert.equal(match.resolved && allowlistMiss.zone.name, "Rest of PH");

  const otherCity = resolveDeliveryZone(zones, "0508", "999");
  assert.equal(otherCity.resolved, true);
  if (otherCity.resolved) assert.equal(otherCity.zone.name, "Rest of PH");

  const noCatchAll = resolveDeliveryZone([zones[0]!], "9999", null);
  assert.deepEqual(noCatchAll, { resolved: false, legacyFlatFee: false }, "out of coverage");

  assert.deepEqual(resolveDeliveryZone([], "1374", "2"), { resolved: false, legacyFlatFee: true }, "no zones → legacy flat fee");
});

test("admin CRUD is tenant-scoped", async () => {
  const store = await makeStore();
  const other = await makeStore();

  const created = await zonesAdmin.upsert(store.id, null, { name: "Metro Manila", cityCode: "1374", barangayCodes: ["b1", "b2"], feeMinor: 9000, etaMinutes: 30 });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const dup = await zonesAdmin.upsert(store.id, null, { name: "Metro Manila", cityCode: "1374", feeMinor: 100 });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.error.type, "conflict");

  const updated = await zonesAdmin.upsert(store.id, created.value.id, { name: "NCR", cityCode: "1374", feeMinor: 9500, etaMinutes: 25 });
  assert.equal(updated.ok, true);

  const list = await zonesAdmin.list(store.id);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "NCR");
  assert.equal(list[0]?.feeMinor, 9500);

  // Tenant isolation: store B cannot touch store A's zone.
  const cross = await zonesAdmin.upsert(other.id, created.value.id, { name: "Hijack", feeMinor: 0 });
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.error.type, "not_found");
  const delCross = await zonesAdmin.remove(other.id, created.value.id);
  assert.equal(delCross.ok, false);
});

test("zone CRUD validation", async () => {
  const store = await makeStore();
  assert.equal((await zonesAdmin.upsert(store.id, null, { name: "", feeMinor: 100 })).ok, false);
  assert.equal((await zonesAdmin.upsert(store.id, null, { name: "X", feeMinor: -1 })).ok, false);
  assert.equal((await zonesAdmin.upsert(store.id, null, { name: "X", feeMinor: 100, etaMinutes: 0 })).ok, false);
  assert.equal((await zonesAdmin.remove(store.id, "does-not-exist")).ok, false);
});
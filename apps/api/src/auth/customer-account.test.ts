// P1.portal customer account — saved PH addresses (tenant-scoped CRUD + chain
// validation) + DPA consent records. Real Prisma DB; fixtures cleaned in after().
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { AddressService } from "../address/address.service.js";
import { CustomerAuthService } from "./customer-auth.service.js";

const run = `P1AC${Date.now().toString().slice(-6)}`;
const service = new CustomerAuthService(
  { jwtSecret: "customer-test-secret-0123456789", jwtExpiresIn: "30d" },
  new AddressService(),
);

const storeIds: string[] = [];
const customerIds: string[] = [];
const regionIds: string[] = [];

const regionCode = `${run}REG`;
const provinceCode = `${run}PROV`;
const cityCode = `${run}CITY`;
const barangayCode = `${run}BRGY`;

let phSeq = 0;

async function makePhHierarchy(tag: string) {
  phSeq += 1;
  const rCode = `${regionCode}${phSeq}`;
  const pCode = `${provinceCode}${phSeq}`;
  const cCode = `${cityCode}${phSeq}`;
  const bCode = `${barangayCode}${phSeq}`;
  const region = await prisma.phRegion.create({ data: { code: rCode, name: "P1 Account Region" } });
  regionIds.push(region.id);
  const province = await prisma.phProvince.create({
    data: { code: pCode, name: "P1 Account Province", regionId: region.id },
  });
  const city = await prisma.phCity.create({
    data: { code: cCode, name: "P1 Account City", type: "city", provinceId: province.id },
  });
  await prisma.phBarangay.create({ data: { code: bCode, name: "P1 Account Barangay", cityId: city.id } });
  void tag;
  return { regionCode: rCode, provinceCode: pCode, cityCode: cCode, barangayCode: bCode };
}

after(async () => {
  if (customerIds.length) {
    await prisma.consentRecord.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.storeCustomerAddress.deleteMany({ where: { storeCustomer: { customerId: { in: customerIds } } } });
    await prisma.storeCustomer.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  }
  if (storeIds.length) await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  if (regionIds.length) {
    await prisma.phBarangay.deleteMany({ where: { city: { province: { regionId: { in: regionIds } } } } });
    await prisma.phCity.deleteMany({ where: { province: { regionId: { in: regionIds } } } });
    await prisma.phProvince.deleteMany({ where: { regionId: { in: regionIds } } });
    await prisma.phRegion.deleteMany({ where: { id: { in: regionIds } } });
  }
  await prisma.$disconnect();
});

async function makeStore() {
  const s = await prisma.store.create({ data: { slug: `${run}-${storeIds.length + 1}`.toLowerCase(), name: `P1 Account ${run}` } });
  storeIds.push(s.id);
  return s;
}

async function register(emailTag: string) {
  const r = await service.register({
    email: `${emailTag}@example.test`,
    password: "password-123456",
    name: `A ${run}`,
    consent: { scope: "dpv1", channel: "web", version: "2026.09" },
  });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("register failed");
  customerIds.push(r.value.customer.id);
  return r.value;
}

test("register records DPA consent; consents are listable", async () => {
  const c = await register(`c${Date.now()}${Math.random().toString(36).slice(2)}`);
  const consents = await service.listConsents(c.token);
  assert.equal(consents.ok, true);
  if (!consents.ok) return;
  assert.ok(consents.value.consents.some((x) => x.scope === "dpv1" && x.channel === "web" && x.granted));
});

test("saved address CRUD + PH chain snapshot", async () => {
  const store = await makeStore();
  const codes = await makePhHierarchy("crud");
  const c = await register(`d${Date.now()}${Math.random().toString(36).slice(2)}`);

  const created = await service.createAddress(c.token, store.id, {
    label: "Bahay",
    addressLine1: "12 Mabini St",
    ...codes,
  });
  assert.equal(created.ok, true);
  const list = await service.listAddresses(c.token, store.id);
  assert.equal(list.ok, true);
  if (!list.ok) return;
  const saved = list.value.addresses[0];
  if (!saved) return assert.fail("expected a saved address");
  assert.equal(saved.label, "Bahay");
  assert.equal(saved.addressLine1, "12 Mabini St");
  assert.equal(saved.barangayName, "P1 Account Barangay");
  assert.equal(saved.cityName, "P1 Account City");
  assert.equal(saved.isDefault, true, "first address becomes default");

  // update without codes must keep the PH snapshot; label changes
  const updated = await service.updateAddress(c.token, store.id, saved.id, { label: "Bahay 2" });
  assert.equal(updated.ok, true);
  const after = await service.listAddresses(c.token, store.id);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  const aft = after.value.addresses[0];
  if (!aft) return assert.fail("expected the address to remain");
  assert.equal(aft.label, "Bahay 2");
  assert.equal(aft.barangayName, "P1 Account Barangay", "snapshot survives non-PH edits");

  const deleted = await service.deleteAddress(c.token, store.id, saved.id);
  assert.equal(deleted.ok, true);
});

test("partial PH codes are rejected on create", async () => {
  const store = await makeStore();
  const codes = await makePhHierarchy("partial");
  const c = await register(`e${Date.now()}${Math.random().toString(36).slice(2)}`);
  const r = await service.createAddress(c.token, store.id, {
    label: "Incomplete", addressLine1: "1 X St", regionCode: codes.regionCode, provinceCode: codes.provinceCode, cityCode: codes.cityCode,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.type, "validation");
    assert.ok(r.error.errors.some((m) => /Complete the full address/i.test(m)));
  }
});

test("tenant isolation: customer A cannot see, edit, or delete customer B's address", async () => {
  const store = await makeStore();
  const codes = await makePhHierarchy("isolation");
  const a = await register(`a${Date.now()}${Math.random().toString(36).slice(2)}`);
  const b = await register(`b${Date.now()}${Math.random().toString(36).slice(2)}`);

  const ra = await service.createAddress(a.token, store.id, { label: "A home", addressLine1: "A St", ...codes });
  const rb = await service.createAddress(b.token, store.id, { label: "B home", addressLine1: "B St", ...codes });
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  if (!ra.ok || !rb.ok) return;

  // A lists only A's address
  const la = await service.listAddresses(a.token, store.id);
  assert.equal(la.ok, true);
  if (!la.ok) return;
  const aFirst = la.value.addresses[0];
  if (!aFirst) return assert.fail("expected A's address in A's list");
  assert.equal(aFirst.label, "A home");

  // A cannot read/update/delete B's address
  const rbId = rb.value.address.id;
  const aUpdateB = await service.updateAddress(a.token, store.id, rbId, { label: "stolen" });
  assert.equal(aUpdateB.ok, false);
  const aDeleteB = await service.deleteAddress(a.token, store.id, rbId);
  assert.equal(aDeleteB.ok, false);
  const aListB = await service.listAddresses(b.token, store.id);
  assert.equal(aListB.ok, true);
  if (!aListB.ok) return;
  const bFirst = aListB.value.addresses[0];
  if (!bFirst) return assert.fail("expected B's address in B's list");
  assert.equal(bFirst.label, "B home", "B's address untouched");
});

test("address ops reject a bad/invalid customer token", async () => {
  const store = await makeStore();
  const r = await service.listAddresses("not-a-token", store.id);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "unauthorized");
});
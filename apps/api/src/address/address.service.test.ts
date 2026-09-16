// P1: PH address service — list cascade + chain-validated resolve (real DB).
// Fixtures use the P1T prefix; all rows are deleted in the after() hook.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { AddressService } from "./address.service.js";

const run = `P1T${Date.now().toString().slice(-6)}`;
const addresses = new AddressService();

const regionCode = `${run}REG`;
const provinceCode = `${run}PROV`;
const cityCode = `${run}CITY`;
const barangayCode = `${run}BRGY`;
const otherRegionCode = `${run}OTH`;
const otherProvinceCode = `${run}OPV`;

const createdRegionIds: string[] = [];

after(async () => {
  if (createdRegionIds.length) {
    await prisma.phBarangay.deleteMany({ where: { city: { province: { regionId: { in: createdRegionIds } } } } });
    await prisma.phCity.deleteMany({ where: { province: { regionId: { in: createdRegionIds } } } });
    await prisma.phProvince.deleteMany({ where: { regionId: { in: createdRegionIds } } });
    await prisma.phRegion.deleteMany({ where: { id: { in: createdRegionIds } } });
  }
  await prisma.$disconnect();
});

async function makeRegion(code: string, name: string) {
  const r = await prisma.phRegion.create({ data: { code, name } });
  createdRegionIds.push(r.id);
  return r;
}

test("list cascade and resolve work against the reference tables", async () => {
  const region = await makeRegion(regionCode, "P1 Test Region");
  const otherRegion = await makeRegion(otherRegionCode, "P1 Other Region");
  const province = await prisma.phProvince.create({ data: { code: provinceCode, name: "P1 Test Province", regionId: region.id } });
  const otherProvince = await prisma.phProvince.create({ data: { code: otherProvinceCode, name: "P1 Other Province", regionId: otherRegion.id } });
  const city = await prisma.phCity.create({ data: { code: cityCode, name: "P1 Test City", type: "city", provinceId: province.id } });
  const barangay = await prisma.phBarangay.create({ data: { code: barangayCode, name: "P1 Test Barangay", cityId: city.id } });

  // list cascade
  const regions = await addresses.listRegions();
  assert.ok(regions.some((r) => r.code === regionCode));
  const provinces = await addresses.listProvinces(regionCode);
  assert.ok(provinces.some((p) => p.code === provinceCode));
  assert.ok(!provinces.some((p) => p.code === otherProvinceCode), "other-region province must not leak");
  assert.deepEqual(await addresses.listProvinces("nope-missing"), []);
  const cities = await addresses.listCities(provinceCode);
  assert.ok(cities.some((c) => c.code === cityCode && c.type === "city"));
  assert.deepEqual(await addresses.listCities("nope-missing"), []);
  const brgys = await addresses.listBarangays(cityCode);
  assert.ok(brgys.some((b) => b.code === barangayCode));

  // valid chain resolve → name snapshot
  const ok = await addresses.resolve(regionCode, provinceCode, cityCode, barangayCode);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.names.regionName, "P1 Test Region");
    assert.equal(ok.names.provinceName, "P1 Test Province");
    assert.equal(ok.names.cityName, "P1 Test City");
    assert.equal(ok.names.barangayName, "P1 Test Barangay");
  }

  // wrong parent chain → rejected
  const bad = await addresses.resolve(otherRegionCode, provinceCode, cityCode, barangayCode);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /Province does not belong/i);

  const badCity = await addresses.resolve(regionCode, provinceCode, cityCode, `${run}MISSING`);
  assert.equal(badCity.ok, false);

  void otherProvince;
  void barangay;
});

test("unknown codes are never guessed", async () => {
  const bad = await addresses.resolve("nope-r", "nope-p", "nope-c", "nope-b");
  assert.equal(bad.ok, false);
});
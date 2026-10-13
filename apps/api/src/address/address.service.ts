// P1: PH address reference service — reads the PhRegion/PhProvince/PhCity/PhBarangay
// lookup tables (platform reference data, NOT store-owned) for:
//   • public cascading dropdown endpoints (list)
//   • checkout chain validation + immutability snapshot (resolve)
// Codes are PSGC-style; the seed ships a curated subset (full dataset PENDING).

import { prisma } from "../persistence/prisma-repositories.js";
import { cacheGet, cacheKey, cacheSet } from "../persistence/ttl-cache.js";
import type { PhBarangayDTO, PhCityDTO, PhProvinceDTO, PhRegionDTO } from "@sam-store/contracts";

// PH reference data is seeded and effectively immutable, but checkout's address cascade
// read it fresh on every dropdown change and every submit — each read paying the pooler's
// ~300 ms round-trip. Cache it (10 min) and collapse each parent+children pair into one
// query via a relation filter.
const ADDRESS_CACHE_TTL_MS = 10 * 60_000;
const ADDRESS_PREFIX = "ph-address";

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const k = cacheKey(ADDRESS_PREFIX, key);
  const hit = await cacheGet<T>(k);
  if (hit) return hit;
  const value = await load();
  await cacheSet(k, value, ADDRESS_CACHE_TTL_MS);
  return value;
}

/** DI token — the CheckoutService consumes this as its AddressGateway. */
export const ADDRESS_GATEWAY = Symbol("ADDRESS_GATEWAY");

export type AddressResolution =
  | { ok: true; names: { regionName: string; provinceName: string; cityName: string; barangayName: string } }
  | { ok: false; message: string };

export class AddressService {
  async listRegions(): Promise<PhRegionDTO[]> {
    return cached("regions", () =>
      prisma.phRegion.findMany({
        orderBy: { sortOrder: "asc" },
        select: { code: true, name: true },
      }),
    );
  }

  /** One query: filter through the relation instead of resolving the parent id first. */
  async listProvinces(regionCode: string): Promise<PhProvinceDTO[]> {
    return cached(`provinces:${regionCode}`, () =>
      prisma.phProvince.findMany({
        where: { region: { code: regionCode } },
        orderBy: { name: "asc" },
        select: { code: true, name: true },
      }),
    );
  }

  async listCities(provinceCode: string): Promise<PhCityDTO[]> {
    return cached(`cities:${provinceCode}`, () =>
      prisma.phCity.findMany({
        where: { province: { code: provinceCode } },
        orderBy: { name: "asc" },
        select: { code: true, name: true, type: true },
      }),
    );
  }

  async listBarangays(cityCode: string): Promise<PhBarangayDTO[]> {
    return cached(`barangays:${cityCode}`, () =>
      prisma.phBarangay.findMany({
        where: { city: { code: cityCode } },
        orderBy: { name: "asc" },
        select: { code: true, name: true },
      }),
    );
  }

  /** Validate a full selection and return the frozen name snapshot for the order.
   *  Unknown codes OR codes that break the parent chain are rejected (never guessed). */
  async resolve(
    regionCode: string,
    provinceCode: string,
    cityCode: string,
    barangayCode: string,
  ): Promise<AddressResolution> {
    // Independent lookups: four sequential round-trips became one (validation against
    // each other happens below, so order does not matter).
    const [region, province, city, barangay] = await Promise.all([
      prisma.phRegion.findUnique({ where: { code: regionCode } }),
      prisma.phProvince.findUnique({ where: { code: provinceCode } }),
      prisma.phCity.findUnique({ where: { code: cityCode } }),
      prisma.phBarangay.findUnique({ where: { code: barangayCode } }),
    ]);

    if (!region || !province || !city || !barangay) {
      return { ok: false, message: "Address selection is invalid — please re-check your location" };
    }
    if (province.regionId !== region.id) {
      return { ok: false, message: "Province does not belong to the selected region" };
    }
    if (city.provinceId !== province.id) {
      return { ok: false, message: "City/municipality does not belong to the selected province" };
    }
    if (barangay.cityId !== city.id) {
      return { ok: false, message: "Barangay does not belong to the selected city/municipality" };
    }

    return {
      ok: true,
      names: {
        regionName: region.name,
        provinceName: province.name,
        cityName: city.name,
        barangayName: barangay.name,
      },
    };
  }
}
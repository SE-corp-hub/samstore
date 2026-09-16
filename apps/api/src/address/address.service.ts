// P1: PH address reference service — reads the PhRegion/PhProvince/PhCity/PhBarangay
// lookup tables (platform reference data, NOT store-owned) for:
//   • public cascading dropdown endpoints (list)
//   • checkout chain validation + immutability snapshot (resolve)
// Codes are PSGC-style; the seed ships a curated subset (full dataset PENDING).

import { prisma } from "../persistence/prisma-repositories.js";
import type { PhBarangayDTO, PhCityDTO, PhProvinceDTO, PhRegionDTO } from "@sam-store/contracts";

/** DI token — the CheckoutService consumes this as its AddressGateway. */
export const ADDRESS_GATEWAY = Symbol("ADDRESS_GATEWAY");

export type AddressResolution =
  | { ok: true; names: { regionName: string; provinceName: string; cityName: string; barangayName: string } }
  | { ok: false; message: string };

export class AddressService {
  async listRegions(): Promise<PhRegionDTO[]> {
    return prisma.phRegion.findMany({
      orderBy: { sortOrder: "asc" },
      select: { code: true, name: true },
    });
  }

  async listProvinces(regionCode: string): Promise<PhProvinceDTO[]> {
    const region = await prisma.phRegion.findUnique({
      where: { code: regionCode },
      select: { id: true },
    });
    if (!region) return [];
    return prisma.phProvince.findMany({
      where: { regionId: region.id },
      orderBy: { name: "asc" },
      select: { code: true, name: true },
    });
  }

  async listCities(provinceCode: string): Promise<PhCityDTO[]> {
    const province = await prisma.phProvince.findUnique({
      where: { code: provinceCode },
      select: { id: true },
    });
    if (!province) return [];
    return prisma.phCity.findMany({
      where: { provinceId: province.id },
      orderBy: { name: "asc" },
      select: { code: true, name: true, type: true },
    });
  }

  async listBarangays(cityCode: string): Promise<PhBarangayDTO[]> {
    const city = await prisma.phCity.findUnique({
      where: { code: cityCode },
      select: { id: true },
    });
    if (!city) return [];
    return prisma.phBarangay.findMany({
      where: { cityId: city.id },
      orderBy: { name: "asc" },
      select: { code: true, name: true },
    });
  }

  /** Validate a full selection and return the frozen name snapshot for the order.
   *  Unknown codes OR codes that break the parent chain are rejected (never guessed). */
  async resolve(
    regionCode: string,
    provinceCode: string,
    cityCode: string,
    barangayCode: string,
  ): Promise<AddressResolution> {
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
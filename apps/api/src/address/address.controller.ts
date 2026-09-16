import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ADDRESS_GATEWAY, AddressService } from "./address.service.js";

// Public PH-address cascade endpoints (no auth — guest checkout needs them).
// GET /public/address/regions
// GET /public/address/provinces?region=<code>
// GET /public/address/cities?province=<code>
// GET /public/address/barangays?city=<code>
// Unknown parents return [] (same shape, no leakage of what exists).

@Controller("public/address")
export class AddressController {
  constructor(@Inject(ADDRESS_GATEWAY) private readonly addresses: AddressService) {}

  @Get("regions")
  async regions() {
    return this.addresses.listRegions();
  }

  @Get("provinces")
  async provinces(@Query("region") region?: string) {
    if (typeof region !== "string" || region.length === 0 || region.length > 120) return [];
    return this.addresses.listProvinces(region);
  }

  @Get("cities")
  async cities(@Query("province") province?: string) {
    if (typeof province !== "string" || province.length === 0 || province.length > 120) return [];
    return this.addresses.listCities(province);
  }

  @Get("barangays")
  async barangays(@Query("city") city?: string) {
    if (typeof city !== "string" || city.length === 0 || city.length > 120) return [];
    return this.addresses.listBarangays(city);
  }
}
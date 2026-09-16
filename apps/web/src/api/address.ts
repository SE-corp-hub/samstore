// PH address cascade helpers — hit the public NestJS endpoints directly.
import { API_URL } from "../config";

export interface PhRegionOption {
  code: string;
  name: string;
}
export interface PhProvinceOption {
  code: string;
  name: string;
}
export interface PhCityOption {
  code: string;
  name: string;
  type: string;
}
export interface PhBarangayOption {
  code: string;
  name: string;
}

async function get<T>(path: string): Promise<T[]> {
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

export const fetchRegions = () => get<PhRegionOption>("/public/address/regions");
export const fetchProvinces = (regionCode: string) =>
  get<PhProvinceOption>(`/public/address/provinces?region=${encodeURIComponent(regionCode)}`);
export const fetchCities = (provinceCode: string) =>
  get<PhCityOption>(`/public/address/cities?province=${encodeURIComponent(provinceCode)}`);
export const fetchBarangays = (cityCode: string) =>
  get<PhBarangayOption>(`/public/address/barangays?city=${encodeURIComponent(cityCode)}`);
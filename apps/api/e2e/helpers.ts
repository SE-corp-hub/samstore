// Shared helpers for the critical-path E2E suite.
import { APIRequestContext, Page, expect } from "@playwright/test";

export const API = "http://localhost:4100";
export const ADMIN_EMAIL = "admin@samstore.test";
export const ADMIN_PASSWORD = "admin-pass-123"; // seeded demo credential (prisma/seed.ts)
// Platform operator — holds PLATFORM_ADMIN but NO store membership, so every
// store-scoped endpoint 403s until they explicitly target a store (tenant-context.ts).
export const PLATFORM_EMAIL = "platform@samstore.test";
export const PLATFORM_PASSWORD = "platform-pass-123";

/** Browser admin login — the current form uses a single "Phone or email" identifier field. */
export async function loginAs(page: Page, identifier: string, password: string) {
  await page.goto("/admin/login");
  await page.locator('input[placeholder="0917 123 4567 or owner@store.com"]').fill(identifier);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign\s?in|login/i }).first().click();
  await expect(page).toHaveURL(/\/admin\/(dashboard|delivery)/, { timeout: 20_000 });
}

/** Select the first real PH address from the cascading region→province→city→barangay selects. */
export async function pickFirstPhAddress(page: Page) {
  for (const label of ["Region", "Province", "City / Municipality", "Barangay"]) {
    const select = page.getByLabel(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await select.waitFor({ state: "visible", timeout: 15_000 });
    await select.locator("option").nth(1).waitFor({ state: "attached", timeout: 15_000 });
    await select.selectOption({ index: 1 });
  }
}

/** Select a PH address that the current store's configured delivery zones accept. */
export async function pickCoveredPhAddress(page: Page, request: APIRequestContext) {
  const token = await apiLogin(request);
  const authHeaders = { Authorization: `Bearer ${token}` };
  const settingsRes = await request.get(`${API}/admin/settings`, { headers: authHeaders });
  if (settingsRes.status() !== 200) throw new Error(`could not load store settings for E2E address selection: HTTP ${settingsRes.status()}`);
  const settings = await settingsRes.json();
  const storeId = (settings.storeId ?? settings.id) as string | undefined;
  if (!storeId) throw new Error("store settings did not return a store id for E2E address selection");

  const zonesRes = await request.get(`${API}/admin/delivery-zones`, {
    headers: { ...authHeaders, "X-Store-Id": storeId },
  });
  if (zonesRes.status() !== 200) throw new Error(`could not load delivery zones for E2E address selection: HTTP ${zonesRes.status()}`);
  const zonesBody = await zonesRes.json();
  const zones = (zonesBody.zones ?? zonesBody.value?.zones ?? []) as {
    isActive: boolean;
    cityCode: string | null;
    barangayCodes: string[];
  }[];
  const activeZones = zones.filter((zone) => zone.isActive);

  // No zones preserves the legacy flat-fee behavior; a catch-all accepts any address.
  if (activeZones.length === 0 || activeZones.some((zone) => zone.cityCode === null)) {
    await pickFirstPhAddress(page);
    return;
  }

  const getAddressList = async <T>(path: string): Promise<T[]> => {
    const res = await request.get(`${API}${path}`);
    if (res.status() !== 200) throw new Error(`PH address lookup failed: HTTP ${res.status()} for ${path}`);
    return (await res.json()) as T[];
  };
  type AddressOption = { code: string; name: string };
  const regions = await getAddressList<AddressOption>("/public/address/regions");
  const matchedZoneCityCodes = new Set<string>();

  for (const region of regions) {
    const provinces = await getAddressList<AddressOption>(`/public/address/provinces?region=${encodeURIComponent(region.code)}`);
    for (const province of provinces) {
      const cities = await getAddressList<AddressOption>(`/public/address/cities?province=${encodeURIComponent(province.code)}`);
      for (const city of cities) {
        const cityZones = activeZones.filter((zone) => zone.cityCode === city.code);
        if (cityZones.length === 0) continue;
        matchedZoneCityCodes.add(city.code);
        const barangays = await getAddressList<AddressOption>(`/public/address/barangays?city=${encodeURIComponent(city.code)}`);
        const barangay = cityZones
          .flatMap((zone) => zone.barangayCodes.length > 0
            ? barangays.filter((candidate) => zone.barangayCodes.includes(candidate.code))
            : barangays)
          .find(Boolean);
        if (!barangay) continue;

        const chain = [
          ["Region", region.code],
          ["Province", province.code],
          ["City / Municipality", city.code],
          ["Barangay", barangay.code],
        ] as const;
        for (const [label, code] of chain) {
          const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const select = page.getByLabel(new RegExp(`^${escapedLabel}`));
          await select.waitFor({ state: "visible", timeout: 15_000 });
          await select.locator(`option[value="${code}"]`).waitFor({ state: "attached", timeout: 15_000 });
          await select.selectOption(code);
        }
        return;
      }
    }
  }

  throw new Error(
    `no seeded PH address matches the store's configured delivery zones; ` +
    `zone city codes: ${activeZones.map((zone) => zone.cityCode).join(", ")}; ` +
    `matching seeded city codes: ${[...matchedZoneCityCodes].join(", ") || "none"}`,
  );
}

/** POST /auth/login → returns { token, ... }. Retries: a pooled DB can throw one transient 5xx. */
export async function apiLogin(request: APIRequestContext) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (res.status() >= 200 && res.status() < 300) {
      const body = await res.json();
      const token = body.token ?? body.value?.token ?? body.data?.token;
      if (!token) throw new Error(`login response had no token: ${JSON.stringify(body).slice(0, 200)}`);
      return token;
    }
    last = `HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`;
    if (res.status() < 500) break; // a 4xx is a real problem — retrying will not help
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`login failed: ${last}`);
}

export interface PublicLink {
  slug: string;
  token: string;
  status: string;
}

/** GET /admin/settings with tenant headers → public link (slug + token). */
export async function fetchPublicLink(request: APIRequestContext): Promise<PublicLink> {
  const token = await apiLogin(request);
  const res = await request.get(`${API}/admin/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status() !== 200) throw new Error(`settings failed: HTTP ${res.status()}`);
  const body = await res.json();
  const link = body?.publicLink ?? body?.value?.publicLink;
  if (!link) throw new Error(`settings had no publicLink: ${JSON.stringify(body).slice(0, 200)}`);
  return link as PublicLink;
}

export async function apiJson<T>(request: APIRequestContext, path: string, init?: Parameters<APIRequestContext["get"]>[1]): Promise<{ status: number; body: T }> {
  const res = await request.get(`${API}${path}`, init);
  return { status: res.status(), body: (await res.json()) as T };
}

/**
 * The storefront specs add the FIRST in-stock product to a cart and check out — every run therefore
 * consumes demo stock, and after enough runs the Add buttons render DISABLED and the specs die on a
 * click timeout for a reason that has nothing to do with the code under test. Top the demo store's
 * sellable products back up through the real admin adjustment endpoint before those specs run, so
 * the suite is self-healing instead of silently stock-dependent.
 */
export async function ensureStorefrontStock(request: APIRequestContext, minQuantity = 25): Promise<number> {
  const token = await apiLogin(request);
  const settings = await request.get(`${API}/admin/settings`, { headers: { Authorization: `Bearer ${token}` } });
  if (settings.status() !== 200) return 0;
  const storeId = (await settings.json())?.id as string | undefined;
  if (!storeId) return 0;
  const headers = { Authorization: `Bearer ${token}`, "X-Store-Id": storeId };

  const productsRes = await request.get(`${API}/admin/products`, { headers });
  if (productsRes.status() !== 200) return 0;
  const products = ((await productsRes.json()).products ?? []) as { id: string; name: string; quantityOnHand: number; isActive: boolean }[];

  let toppedUp = 0;
  for (const p of products) {
    if (!p.isActive) continue;
    // Availability is onHand − reserved, and every pending order holds its reservation — so top up
    // against the RESERVED figure, not the raw on-hand, or a fully committed product stays 0-available.
    const reserved = p.quantityReserved ?? 0;
    const need = reserved + minQuantity;
    if ((p.quantityOnHand ?? 0) >= need) continue;
    const res = await request.post(`${API}/admin/stock/adjust`, {
      headers,
      data: { productId: p.id, setTo: need, reason: "E2E suite: top up sellable demo stock" },
    });
    if (res.status() < 300) toppedUp++;
    if (toppedUp >= 2) break; // two sellable products is plenty for the storefront specs
  }
  return toppedUp;
}

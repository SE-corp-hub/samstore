// Shared helpers for the critical-path E2E suite.
import { APIRequestContext } from "@playwright/test";

export const API = "http://localhost:4100";
export const ADMIN_EMAIL = "admin@samstore.test";
export const ADMIN_PASSWORD = "admin-pass-123"; // seeded demo credential (prisma/seed.ts)

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
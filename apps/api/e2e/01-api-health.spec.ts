// E2E 01 — API health + public-link access control (M2/M11 surface).
import { test, expect } from "@playwright/test";
import { API, fetchPublicLink } from "./helpers.js";

test("/health liveness + /health/ready db", async ({ request }) => {
  const h = await request.get(`${API}/health`);
  expect(h.status()).toBe(200);
    const hb = await h.json();
    expect(hb.status).toBe("ok");

  const r = await request.get(`${API}/health/ready`);
  expect(r.status()).toBe(200);
  const rb = await r.json();
  expect(rb.db).toBe("ok");
});

test("storefront link: wrong token → 404, right token → store + products", async ({ request }) => {
  const link = await fetchPublicLink(request);
  expect(link.status).toBe("ACTIVE");
  expect(link.slug.length).toBeGreaterThan(0);
  expect(link.token.length).toBeGreaterThan(20); // high-entropy token, not sequential

  const wrong = await request.get(`${API}/public/stores/${link.slug}?token=wrong-token`);
  expect(wrong.status()).toBe(404);

  const right = await request.get(`${API}/public/stores/${link.slug}?token=${encodeURIComponent(link.token)}`);
  expect(right.status()).toBe(200);
  const body = await right.json();
    expect(typeof body.store?.name).toBe("string");
    expect(Array.isArray(body.products)).toBe(true);

  const noToken = await request.get(`${API}/public/stores/${link.slug}`);
  expect(noToken.status()).toBe(404);
});
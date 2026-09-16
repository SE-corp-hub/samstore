// E2E 04 — guest PICKUP journey (flow matrix #2): no address required, no delivery
// fee, and the order records fulfillmentType PICKUP.
import { test, expect } from "@playwright/test";
import { API, apiLogin, fetchPublicLink, ensureStorefrontStock } from "./helpers.js";

const ORDER_NUMBER = /SAMSTO-\d+/i;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("guest pickup: cart → checkout without an address → placed with PICKUP + zero delivery fee", async ({ page, request }) => {
  test.setTimeout(150_000); // remote-DB latency: a checkout POST can take several seconds per query
  await ensureStorefrontStock(request);
  const link = await fetchPublicLink(request);

  await page.goto(`/${link.slug}?token=${encodeURIComponent(link.token)}`);
  const addButtons = page.locator(".card-body button:enabled", { hasText: "Add" });
  expect(await addButtons.count(), "storefront needs ≥1 in-stock product").toBeGreaterThan(0);
  await addButtons.first().click();

  await page.getByRole("button", { name: /cart/i }).first().click();
  await page.getByRole("button", { name: /^Checkout ·/ }).click();

  // Pickup: the address block must disappear, so only name + phone are required.
  await page.getByRole("button", { name: /Pickup/ }).click();
  await expect(page.getByPlaceholder("House no. & street")).toHaveCount(0);
  await page.locator('input:not([placeholder])').first().fill("E2E Pickup");
  await page.getByPlaceholder("+63...").fill("+639178456124");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Review order" }).click();
  // The review summary must show pickup with no fee.
  await expect(page.getByText("Free — self pickup")).toBeVisible();
  await page.getByRole("button", { name: /^Place order ·/ }).click();

  await expect(page.getByText("Order placed!")).toBeVisible({ timeout: 25_000 });
  const orderNumber = (await page.getByText(ORDER_NUMBER).first().textContent())?.trim();
  expect(orderNumber).toMatch(ORDER_NUMBER);

  // Server truth: PICKUP fulfillment, zero delivery fee, no address stored.
  const token = await apiLogin(request);
  const list = await request.get(`${API}/admin/orders`, { headers: { Authorization: `Bearer ${token}` } });
  const orders = (await list.json()).orders ?? [];
  const found = orders.find((o: { orderNumber: string }) => o.orderNumber === orderNumber);
  expect(found, `order ${orderNumber} visible in /admin/orders`).toBeTruthy();

  const detail = await request.get(`${API}/admin/orders/${found.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await detail.json();
  expect(d.fulfillmentType ?? (d.deliveryType === "pickup" ? "PICKUP" : null)).toBe("PICKUP");
  expect(d.deliveryFeeMinor).toBe(0);
  expect((d.deliveryAddressLine1 ?? "").trim() === "").toBe(true);
});

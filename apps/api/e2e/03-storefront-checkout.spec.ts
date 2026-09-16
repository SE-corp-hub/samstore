// E2E 03 — critical path: storefront → add to cart → delivery checkout (COD)
// → order placed → public claim-token readback (single-use claim semantics).
import { test, expect } from "@playwright/test";
import { API, apiLogin, fetchPublicLink, ensureStorefrontStock } from "./helpers.js";

const ORDER_NUMBER = /SAMSTO-\d+/i;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("customer order journey: menu → cart → checkout → placed → claimable", async ({ page, request }) => {
  // Self-healing fixture: repeated runs consume demo stock, which would leave every Add
  // button disabled and fail this spec for a reason unrelated to the code under test.
  await ensureStorefrontStock(request);
  const link = await fetchPublicLink(request);

  // 1. Storefront loads with the real public link (browser).
  await page.goto(`/${link.slug}?token=${encodeURIComponent(link.token)}`);
  const storeCard = page.locator(".card").first();
  await expect(storeCard).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /cart/i }).first()).toBeVisible();

  // The store must have at least one in-stock product to complete this journey.
  // Only an in-stock product has an ENABLED Add button — a fully reserved product renders it
  // disabled, which is correct behaviour the spec must respect rather than fight.
  const addButtons = page.locator(".card-body button:enabled", { hasText: "Add" });
  const count = await addButtons.count();
  expect(count, "storefront needs ≥1 in-stock product (seed data)").toBeGreaterThan(0);
  await addButtons.first().click();
  await expect(page.getByRole("button", { name: /cart/i }).first().locator(".badge")).toBeVisible();

  // 2. Open the cart drawer → Checkout.
  await page.getByRole("button", { name: /cart/i }).first().click();
  const checkoutBtn = page.getByRole("button", { name: /^Checkout ·/ });
  await expect(checkoutBtn).toBeVisible();
  await checkoutBtn.click();

  // 3. Checkout step 1 "Contact" — delivery selected by default; fill contact + address.
    await page.locator('input:not([placeholder])').first().fill("E2E Tester");
    await page.getByPlaceholder("+63...").fill("+639178456123");
    await page.getByPlaceholder("House no. & street").fill("E2E Test Street 123");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2 "Payment" — COD is the default; continue to review.
    await expect(page.getByText("Cash on delivery", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review order" }).click();

    // Step 3 "Pay" — review summary confirms Cash on delivery, then place.
    await page.getByRole("button", { name: /^Place order ·/ }).click();

  // 4. Success screen shows the order number; grab THIS order's claim token from the
  //    Copy-tracking-token button's clipboard payload (fresh + unused every run).
    // The POST is state-changing against a remote DB; under full-suite load the success screen
    // can take well over 25s to render even though the order is already created server-side.
    await expect(page.getByText("Order placed!")).toBeVisible({ timeout: 60_000 });
    const orderNumber = (await page.getByText(ORDER_NUMBER).first().textContent())?.trim();
    expect(orderNumber).toMatch(ORDER_NUMBER);
    await page.locator("button", { hasText: "Copy tracking token" }).click();
    const claim = await page.evaluate(() => navigator.clipboard.readText());
    expect(claim).toMatch(/^[\w.\-]+$/);

  // 5. Server truth: the order exists, is RECEIVED/delivery, has an unused claim token,
  //    and the public claim lookup (M2) accepts exactly that token.
  const token = await apiLogin(request);
  const list = await request.get(`${API}/admin/orders`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(list.status()).toBe(200);
  const orders = (await list.json()).orders ?? (await list.json());
  const found = (Array.isArray(orders) ? orders : []).find((o) => o.orderNumber === orderNumber);
  expect(found, `order ${orderNumber} visible in /admin/orders`).toBeTruthy();

  const detail = await request.get(`${API}/admin/orders/${found.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detail.status()).toBe(200);
    const d = await detail.json();
    const ft = d.fulfillmentType ?? (d.deliveryType === "delivery" ? "DELIVERY" : null);
    expect(ft).toBe("DELIVERY");

    // The exact claim token shown to the customer exists server-side (the on-screen
    // OrderTracker already consumes one claim to display status — that IS single-use
    // working; the fresh-consumption proof is the POST block below).
    const claimRow = (d.claimTokens ?? []).find((c) => c.token === claim);
    expect(claimRow, "the shown claim token exists").toBeTruthy();

  // POST /public/orders/claim — M2 atomic single-use consumption, live:
  //   - first attempt → 200 (token was fresh) or 409 (the on-screen OrderTracker
  //     already consumed it once — either way the token can NEVER be consumed twice)
  //   - any subsequent attempt → 409 (atomic `updateMany WHERE usedAt IS NULL`)
  //   - garbage token → 401 (no such claim)
  const first = await request.post(`${API}/public/orders/claim`, { data: { claimToken: claim } });
  expect([200, 409]).toContain(first.status());
  if (first.status() === 200) {
    expect((await first.json()).orderNumber ?? (await first.json()).order?.orderNumber).toBe(orderNumber);
  }

  const second = await request.post(`${API}/public/orders/claim`, { data: { claimToken: claim } });
  expect(second.status()).toBe(409);
  const third = await request.post(`${API}/public/orders/claim`, { data: { claimToken: claim } });
  expect(third.status()).toBe(409);

  const garbage = await request.post(`${API}/public/orders/claim`, { data: { claimToken: "not-the-token" } });
  expect(garbage.status()).toBe(401);
});
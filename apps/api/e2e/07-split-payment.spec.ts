// E2E 07 (M1.4) — split payment through the REAL staff flow: a POS hold is paid with
// cash + gcash in the Orders "Pay" modal, and the server writes one tender row per method.
import { test, expect } from "@playwright/test";
import { API, ADMIN_EMAIL, ADMIN_PASSWORD, apiLogin } from "./helpers.js";

interface HoldResponse { orderId: string; orderNumber: string; totalMinor: number }

test("M1.4: the Pay modal settles a hold with a cash + gcash split", async ({ page, request }) => {
  test.setTimeout(120_000); // login + nav + modal + API assertions is a long path
  const token = await apiLogin(request);
  const mineRes = await request.get(`${API}/admin/stores/mine`, { headers: { Authorization: `Bearer ${token}` } });
  const mine = await mineRes.json();
  const storeId = (mine.stores ?? [])[0]?.id as string;
  expect(storeId, "the admin must own a store").toBeTruthy();
  const headers = { Authorization: `Bearer ${token}`, "X-Store-Id": storeId };

  // A counter CASH sale needs an open drawer shift (N1). Open one for this run.
  const openRes = await request.post(`${API}/admin/registers/open`, { headers, data: { openingFloatMinor: 50000 } });
  expect([200, 201, 409], `open shift: HTTP ${openRes.status()}`).toContain(openRes.status());

  // ── Setup through the API: a product and a held (ON_HOLD) order to pay ──
  const productsRes = await request.get(`${API}/admin/products`, { headers });
  expect(productsRes.status()).toBe(200);
  const productsBody = await productsRes.json();
  const products = productsBody.products ?? productsBody.value?.products ?? [];
  expect(products.length, "the demo store must have at least one product").toBeGreaterThan(0);
  const productId = products[0].id as string;

  const holdRes = await request.post(`${API}/admin/pos/hold`, {
    headers,
    data: { items: [{ productId, quantity: 1 }], customerName: "E2E M1 split" },
  });
  expect([200, 201], `hold failed: HTTP ${holdRes.status()} ${(await holdRes.text()).slice(0, 160)}`).toContain(holdRes.status());
  const holdBody = await holdRes.json();
  const hold: HoldResponse = holdBody.value ?? holdBody;
  expect(hold.orderId, "hold must return an orderId").toBeTruthy();

  // A cash + gcash split: ₱20 handed to cash, the rest on gcash — computed from the real total.
  const cashMinor = Math.min(2000, hold.totalMinor - 100);
  const gcashMinor = hold.totalMinor - cashMinor;

  // ── The staff flow in the browser ──
  await page.goto("/admin/login");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign\s?in|login/i }).first().click();
  await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 20_000 });

  // The sidebar items are buttons whose accessible name includes the count badge.
  await page.getByRole("button", { name: /Orders/ }).first().click();
  const search = page.getByPlaceholder(/Search order/i).first();
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.fill(hold.orderNumber);

  // ON_HOLD rows live under the On Process pipeline tab; icon glyphs prefix the names.
  const onProcess = page.getByRole("button", { name: /On Process/ }).first();
  if (await onProcess.isVisible().catch(() => false)) await onProcess.click();

  // The hold row exposes Pay (ON_HOLD orders are handled by dedicated buttons).
  const payButton = page.getByRole("button", { name: /Pay/ }).first();
  await expect(payButton).toBeVisible({ timeout: 15_000 });
  await payButton.click();

  await expect(page.locator("#splitPayToggle")).toBeVisible({ timeout: 10_000 });
  await page.locator("#splitPayToggle").check();

  const row0 = page.locator("#tender-row-0");
  await expect(row0).toBeVisible();
  await row0.locator("select").selectOption("cash");
  await row0.locator('input[type="number"]').first().fill((cashMinor / 100).toFixed(2));

  await page.getByRole("button", { name: /Add tender/i }).click();
  const row1 = page.locator("#tender-row-1");
  await expect(row1).toBeVisible();
  await row1.locator("select").selectOption("gcash");
  await row1.locator('input[type="number"]').first().fill((gcashMinor / 100).toFixed(2));
  await row1.locator('input[placeholder*="reference" i]').fill("GC-E2E-07");

  // The modal shows the split is settled before submitting.
  await expect(page.getByText(/Fully tendered/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Complete", exact: true }).click();

  // ── Server truth: two tender rows, one per method ──
  await expect
    .poll(async () => {
      const res = await request.get(`${API}/admin/orders/${hold.orderId}/payments`, { headers });
      if (res.status() !== 200) return 0;
      const body = await res.json();
      const payments = body.payments ?? body.value?.payments ?? [];
      return payments.length;
    }, { timeout: 20_000, intervals: [500, 1000, 2000] })
    .toBe(2);

  const paymentsRes = await request.get(`${API}/admin/orders/${hold.orderId}/payments`, { headers });
  const body = await paymentsRes.json();
  const payments = (body.payments ?? body.value?.payments ?? []) as { method: string; amountMinor: number; reference: string | null }[];
  const methods = payments.map((p) => p.method).sort();
  expect(methods).toEqual(["cash", "gcash"]);
  expect(payments.find((p) => p.method === "cash")?.amountMinor).toBe(cashMinor);
  expect(payments.find((p) => p.method === "gcash")?.reference).toBe("GC-E2E-07");

  // The order itself is completed and collected.
  const orderRes = await request.get(`${API}/admin/orders?status=COMPLETED`, { headers });
  const ordersBody = await orderRes.json();
  const orders = (ordersBody.orders ?? ordersBody.value?.orders ?? []) as { id: string; paymentStatus: string }[];
  const order = orders.find((o) => o.id === hold.orderId);
  expect(order, "the paid hold appears as COMPLETED").toBeTruthy();
  expect(order?.paymentStatus).toBe("COLLECTED");

  // Leave the drawer as we found it: close the shift counted at its expected amount.
  const xRes = await request.get(`${API}/admin/registers/report?kind=x`, { headers });
  if (xRes.status() === 200) {
    const xBody = await xRes.json();
    const expected = xBody.report?.session?.live?.expectedMinor;
    if (typeof expected === "number") {
      await request.post(`${API}/admin/registers/close`, { headers, data: { countedMinor: expected } });
    }
  }
});

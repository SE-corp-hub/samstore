// E2E 08 (M2) — the stock-adjustment flow through the real Inventory panel: the operator
// adjusts a product with a reason, and the ledger records the movement.
import { test, expect } from "@playwright/test";
import { API, ADMIN_EMAIL, ADMIN_PASSWORD, apiLogin } from "./helpers.js";

test("M2: an inventory adjustment writes a reasoned ledger row", async ({ page, request }) => {
  test.setTimeout(120_000);
  const token = await apiLogin(request);
  const mineRes = await request.get(`${API}/admin/stores/mine`, { headers: { Authorization: `Bearer ${token}` } });
  const storeId = (await mineRes.json()).stores?.[0]?.id as string;
  const headers = { Authorization: `Bearer ${token}`, "X-Store-Id": storeId };
  expect(storeId).toBeTruthy();

  const before = await request.get(`${API}/admin/stock/movements?limit=500`, { headers });
  const beforeCount = (await before.json()).count as number;

  // ── The staff flow: Inventory → Adjust on a real product → save ──
  await page.goto("/admin/login");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign\s?in|login/i }).first().click();
  await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 20_000 });

  await page.getByRole("button", { name: /Inventory/ }).first().click();
  const adjustButton = page.getByRole("button", { name: /Adjust/ }).first();
  // The inventory query aggregates every product's stock levels on a remote pooler — it can
  // take a while under load, so give the panel room before failing.
  await expect(adjustButton).toBeVisible({ timeout: 60_000 });
  await adjustButton.click();

  const modal = page.locator("#adjustModalTitle");
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await page.locator("#adjustQty").fill("3");
  await page.locator("#adjustReason").fill("E2E M2 adjustment");
  await page.getByRole("button", { name: /Save adjustment/ }).click();

  // ── Server truth: a new ADJUST movement carrying the reason ──
  await expect
    .poll(async () => {
      const res = await request.get(`${API}/admin/stock/movements?limit=500`, { headers });
      if (res.status() !== 200) return beforeCount;
      return ((await res.json()).count as number);
    }, { timeout: 90_000, intervals: [1000, 2000, 4000] })
    .toBeGreaterThan(beforeCount);

  const after = await request.get(`${API}/admin/stock/movements?limit=5`, { headers });
  const movements = (await after.json()).movements as { type: string; delta: number; note: string | null; actor: string | null; balanceAfter: number | null }[];
  const mine = movements.find((m) => m.note === "E2E M2 adjustment");
  expect(mine, "the adjustment is on the ledger").toBeTruthy();
  expect(mine?.type).toBe("ADJUST");
  expect(mine?.delta).toBe(3);
  expect(typeof mine?.balanceAfter).toBe("number");
  expect(mine?.actor, "the ledger row names the actor").toBeTruthy();

  // The panel's own history view shows it (the row is visible with its reason).
  await page.getByRole("button", { name: /Stock flow/ }).click();
  await expect(page.getByText("E2E M2 adjustment").first()).toBeVisible({ timeout: 15_000 });
});

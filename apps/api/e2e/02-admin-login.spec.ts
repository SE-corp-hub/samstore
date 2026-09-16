// E2E 02 — staff login → admin dashboard.
import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers.js";

test("admin login with seeded demo credentials opens the dashboard", async ({ page }) => {
  await page.goto("/admin/login");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign\s?in|login/i }).first().click();

  // First-login guard would show a password-change form instead — fail loudly.
  await expect(page.getByText(/At least 8 characters/i)).not.toBeVisible();

  await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 20_000 });

  // The dashboard renders widgets + nav (a healthy boot means the browser JS loaded).
  await expect(page.locator("nav, .navbar").first()).toBeVisible({ timeout: 15_000 });
  const token = await page.evaluate(() => sessionStorage.getItem("samstore.admin.token"));
  expect(token).toBeTruthy();

  // A live API round-trip from the browser session: orders list loads (200).
  const res = await page.evaluate(async () => {
      const t = sessionStorage.getItem("samstore.admin.token");
      const sid = sessionStorage.getItem("samstore.admin.storeId");
      const headers: Record<string, string> = { Authorization: `Bearer ${t}` };
      if (sid) headers["X-Store-Id"] = sid;
      return fetch("http://localhost:4100/admin/orders", { headers }).then((r) => ({ status: r.status }));
    });
    expect(res.status).toBe(200);
});
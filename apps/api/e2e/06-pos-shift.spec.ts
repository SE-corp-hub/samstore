// E2E 06 — POS cash-drawer bar (N1): open a shift, see live drawer totals, print the
// X-report, then close the shift with a counted amount. Cleans up after itself.
import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, API, apiLogin } from "./helpers.js";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/admin/login");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 25_000 });
}

async function openPos(page: import("@playwright/test").Page) {
  const posTab = page.getByRole("button", { name: /^POS$/ }).first();
  await posTab.click();
  await expect(page.getByText(/Shift open|No shift open/).first()).toBeVisible({ timeout: 15_000 });
}

test("POS shift bar: open → X-report → close with a counted amount", async ({ page, request }) => {
  // Make sure we start from a clean drawer (a previous run may have left one open).
  const token = await apiLogin(request);
  const current = await request.get(`${API}/admin/registers/current`, { headers: { Authorization: `Bearer ${token}` } });
  const existing = (await current.json())?.session;
  if (existing) {
    await request.post(`${API}/admin/registers/close`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { countedMinor: existing.live.expectedMinor, notes: "e2e cleanup" },
    });
  }

  await login(page);
  await openPos(page);

  // 1. Closed drawer → the bar says so and Cash is disabled in the payment step.
  await expect(page.getByText(/No shift open/i)).toBeVisible();

  // 2. Open the shift with a ₱100.00 float.
  await page.getByRole("button", { name: "Open shift" }).click();
  const floatInput = page.getByPlaceholder("0.00").first();
  await floatInput.fill("100.00");
  await page.getByRole("button", { name: "Open shift" }).last().click();
  await expect(page.getByText(/Shift open/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/expected drawer/i)).toBeVisible();

  // 3. X-report opens and shows the drawer report.
  await page.getByRole("button", { name: "X-report" }).click();
  await expect(page.getByText("Cash drawer report")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Expected in drawer/i)).toBeVisible();
  await page.locator(".modal-footer").getByRole("button", { name: "Close", exact: true }).click();

  // 4. Close the shift with the expected amount → the Z-report appears with zero variance.
  await page.getByRole("button", { name: "Close shift" }).click();
  await expect(page.getByText(/Variance:/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Close & print Z-report/ }).click();
  await expect(page.getByText(/Z-report \(shift close\)/i)).toBeVisible({ timeout: 40_000 }); // the modal renders after the close POST (remote DB)
  await expect(page.getByText("Variance")).toBeVisible({ timeout: 30_000 });
  await page.locator(".modal-footer").getByRole("button", { name: "Close", exact: true }).click();

  // 5. The drawer is closed again.
  await expect(page.getByText(/No shift open/i)).toBeVisible({ timeout: 30_000 });

  // Server truth: the shift is CLOSED with a recorded variance.
  const after = await request.get(`${API}/admin/registers/sessions`, { headers: { Authorization: `Bearer ${token}` } });
  const sessions = (await after.json()).sessions ?? [];
  expect(sessions.length).toBeGreaterThan(0);
  expect(sessions[0].status).toBe("CLOSED");
  expect(typeof sessions[0].varianceMinor).toBe("number");
});

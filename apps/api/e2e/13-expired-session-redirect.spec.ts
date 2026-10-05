// E2E 13 — a dead admin session must not strand the operator on a broken dashboard.
// An expired or tampered token used to pass the "token present" check, then every
// panel call 401'd and the operator stared at "Failed to load overview" with no
// way back to the login screen.
import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, loginAs } from "./helpers.js";

const DEAD_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJleHBpcmVkLXNlc3Npb24tdXNlciIsInJvbGUiOiJPV05FciIsInN0b3JlSWQiOiJleHBpcmVkIn0." +
  "bm90LWEtcmVhbC1zaWduYXR1cmU";

test("an expired admin token redirects to the login screen instead of a failed dashboard", async ({ page }) => {
  // Seed a token that is syntactically valid but signed by nobody. Set it once (not
  // via addInitScript, which would re-seed it on every navigation and mask the fix).
  await page.goto("/admin/login");
  await page.evaluate((token) => {
    sessionStorage.setItem("samstore.admin.token", token);
    sessionStorage.setItem("samstore.admin.storeId", "expired-store-id");
  }, DEAD_TOKEN);

  await page.goto("/admin/dashboard");

  await expect(page).toHaveURL(/\/admin\/login/, { timeout: 20_000 });

  // The dead credentials are cleared, so the login screen starts clean.
  const leftovers = await page.evaluate(() => ({
    token: sessionStorage.getItem("samstore.admin.token"),
    storeId: sessionStorage.getItem("samstore.admin.storeId"),
  }));
  expect(leftovers.token).toBeNull();
  expect(leftovers.storeId).toBeNull();

  // And the operator can actually get back in with a real account.
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page.getByText(/Failed to load overview/i)).not.toBeVisible();
});
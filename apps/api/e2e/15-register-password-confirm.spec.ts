// E2E 15 — registration refuses a mistyped password.
// A password is unrecoverable for a store owner, so the re-enter field must catch
// the typo before the account is created. No account is created here: the form
// blocks submission, so nothing reaches the API.
import { test, expect } from "@playwright/test";

test("registration blocks a mismatched password confirmation", async ({ page }) => {
  await page.goto("/admin/register");

  const password = page.locator('input[type="password"]').first();
  const confirm = page.locator('input[type="password"]').nth(1);
  await expect(password, "the registration form should ask for the password twice").toBeVisible();
  await expect(confirm).toBeVisible();

  await page.locator('input[type="email"]').fill(`typo-${Date.now()}@example.test`);
  await password.fill("password123");
  await confirm.fill("password124");

  // Inline warning appears as soon as the two entries diverge.
  await expect(page.getByText(/passwords do not match/i).first()).toBeVisible();

  await page.getByRole("button", { name: /create account/i }).click();

  // Still on the form, with the error shown — no account, no redirect.
  await expect(page).toHaveURL(/\/admin\/register/);
  await expect(page.getByText(/passwords do not match/i).first()).toBeVisible();

  // Correcting the confirmation clears the warning.
  await confirm.fill("password123");
  await expect(page.getByText(/passwords do not match/i)).toHaveCount(0);
});
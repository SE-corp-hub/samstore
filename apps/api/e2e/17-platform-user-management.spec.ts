// E2E 17 — the platform User Access surface (Task 4).
// A PLATFORM_ADMIN holds no store membership, so the panel used to hit
// /admin/stores/mine (empty for them) and the store picker rendered nothing.
// Task 6 extends this spec with full add-user / role / reset assertions; this
// file currently proves the picker lists every store, e.g. Sam's Store.
import { test, expect } from "@playwright/test";
import { PLATFORM_EMAIL, PLATFORM_PASSWORD, loginAs } from "./helpers.js";

test("the platform User Access store picker lists Sam's Store", async ({ page }) => {
  await loginAs(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);
  await page.getByRole("button", { name: "User Access" }).first().click();

  const picker = page
    .locator("div.d-flex.flex-wrap.gap-2.align-items-center.mb-2", { hasText: "Platform admin — any store's users" })
    .locator("select");
  await expect(picker, "the platform store picker renders").toBeVisible({ timeout: 20_000 });
  await expect(
    picker.locator("option", { hasText: "Sam's Store" }),
    "Sam's Store is listed in the picker (it used to list nothing)",
  ).toHaveCount(1);
});

test("a storeless platform admin is prompted to select a store on Analytics", async ({ page }) => {
  await loginAs(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);
  await page.getByRole("button", { name: "Analytics" }).first().click();

  await expect(
    page.getByText("Select a store"),
    "the store-scoped Analytics panel prompts for a store instead of a generic failure",
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Failed to load analytics/i)).toHaveCount(0);
});
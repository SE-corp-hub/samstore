// Phase 12 required two-store PH scenario.
// It is intentionally opt-in because it needs operator-provisioned two-store
// fixtures, managed DB, running API/web, and provider-safe credentials.
import { test, expect, type Page } from "@playwright/test";
import { pickFirstPhAddress } from "./helpers.js";

test.describe("two-store PH production scenario", () => {
  test.skip(!process.env.PH_E2E_TWO_STORE, "Set PH_E2E_TWO_STORE=1 after provisioning two isolated stores and servers");

  async function placeGuestOrder(page: Page, url: string) {
    await page.goto(url);
    await expect(page.locator(".navbar-brand").first()).toBeVisible({ timeout: 30_000 });
    const brand = (await page.locator(".navbar-brand").first().textContent())?.trim() ?? "";
    const add = page.locator(".card-body button:enabled", { hasText: "Add" }).first();
    await expect(add).toBeVisible({ timeout: 30_000 });
    await add.click();
    await page.getByRole("button", { name: /cart/i }).first().click();
    await page.getByRole("button", { name: /^Checkout ·/ }).click();
    await page.locator('input[placeholder="+63..."]').fill("+639178456123");
    await pickFirstPhAddress(page);
    await page.locator('input[placeholder="e.g. 123 Mabini St."]').fill("Phase 12 Test Street 123");
    await page.locator('input:not([placeholder])').first().fill("Phase 12 Tester");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Review order" }).click();
    const consent = page.locator("#dpconsent");
    if (!(await consent.isChecked())) await consent.check();
    await page.getByRole("button", { name: /^Place order ·/ }).click();
    await expect(page.getByText("Order placed!")).toBeVisible({ timeout: 60_000 });
    return { brand, orderNumber: (await page.locator(".h3").first().textContent())?.trim() ?? "" };
  }

  test("Store A and Store B remain isolated through browse→cart→checkout→receipt", async ({ page }) => {
    test.setTimeout(240_000); // two independent guest checkouts against the managed DB
    // Operator fixture contract:
    // PH_E2E_STORE_A_URL and PH_E2E_STORE_B_URL must be tokenized public links.
    const storeA = process.env.PH_E2E_STORE_A_URL;
    const storeB = process.env.PH_E2E_STORE_B_URL;
    if (!storeA || !storeB) throw new Error("PH_E2E_STORE_A_URL and PH_E2E_STORE_B_URL are required");
    const a = await placeGuestOrder(page, storeA);
    const b = await placeGuestOrder(page, storeB);
    expect(a.brand).not.toBe(b.brand);
    expect(a.orderNumber).toBeTruthy();
    expect(b.orderNumber).toBeTruthy();
    expect(a.orderNumber).not.toBe(b.orderNumber);

    // A token from Store A must not unlock Store B's public link.
    const aUrl = new URL(storeA);
    const bUrl = new URL(storeB);
    bUrl.searchParams.set("token", aUrl.searchParams.get("token") ?? "");
    await page.goto(bUrl.toString());
    await expect(page.getByText("Store not found")).toBeVisible();
  });
});

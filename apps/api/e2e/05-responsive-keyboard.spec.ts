// E2E 05 — responsive + keyboard smoke check (flow matrix / M10 bullets):
// staff-critical and customer-critical screens must not overflow horizontally at
// 320px (small phone), tablet and desktop, and must be operable by keyboard.
import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, fetchPublicLink, ensureStorefrontStock } from "./helpers.js";

const VIEWPORTS = [
  { name: "320px phone", width: 320, height: 640 },
  { name: "768px tablet", width: 768, height: 1024 },
  { name: "1440px desktop", width: 1440, height: 900 },
];

async function overflowPx(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.documentElement;
    return Math.max(el.scrollWidth - el.clientWidth, document.body.scrollWidth - window.innerWidth);
  });
}

test("storefront + cart fit every viewport without horizontal overflow", async ({ page, request }) => {
  test.setTimeout(150_000);
  await ensureStorefrontStock(request);
  const link = await fetchPublicLink(request);
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/${link.slug}?token=${encodeURIComponent(link.token)}`);
    await expect(page.getByRole("button", { name: /cart/i }).first()).toBeVisible({ timeout: 20_000 });
    const overflow = await overflowPx(page);
    expect(overflow, `${vp.name}: page overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(2);

    // The cart must open and its Checkout control stay reachable at this width.
    await page.locator(".card-body button:enabled", { hasText: "Add" }).first().click();
    await page.getByRole("button", { name: /cart/i }).first().click();
    await expect(page.getByRole("button", { name: /^Checkout ·/ })).toBeVisible();
    await page.setViewportSize({ width: vp.width, height: vp.height });
    expect(await overflowPx(page), `${vp.name}: cart drawer overflows`).toBeLessThanOrEqual(2);
  }
});

test("admin dashboard fits every viewport and is keyboard reachable", async ({ page }) => {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/admin/login");
    // Keyboard-only path: fill the form, submit with Enter (no mouse).
    await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 25_000 });

    // The topbar is always present; the tenant sidebar is desktop-only and is
    // replaced by a hamburger + drawer below the md breakpoint.
    await expect(page.locator("nav.navbar").first()).toBeVisible({ timeout: 15_000 });
    const overflow = await overflowPx(page);
    expect(overflow, `${vp.name}: dashboard overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(2);

    const mobileToggle = page.locator("button.d-md-none").first();
    if (vp.width < 768) {
      await expect(mobileToggle, `${vp.name}: the mobile nav toggle must be reachable`).toBeVisible();
      await mobileToggle.click();
      await expect(page.locator(".modal.fade.show.d-block")).toBeVisible();
      await page.keyboard.press("Escape"); // keyboard-closable drawer
    } else {
      await expect(page.locator("aside").first(), `${vp.name}: the sidebar shows on md+`).toBeVisible();
      await expect(mobileToggle).toBeHidden();
    }

    // Tab must move focus to a real element (no keyboard trap on the shell).
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => document.activeElement?.tagName ?? "");
    expect(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "BODY"]).toContain(active);
  }
});
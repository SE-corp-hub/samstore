// E2E 14 — a platform operator can actually see data.
// PLATFORM_ADMIN holds no store membership, and by design every store-scoped
// endpoint answers 403 until an explicit store is targeted (tenant-context.ts:52-60).
// The dashboard used to hide the switcher for them and render a generic
// "Failed to load overview", so the platform role looked permanently broken.
import { test, expect } from "@playwright/test";
import { PLATFORM_EMAIL, PLATFORM_PASSWORD, loginAs } from "./helpers.js";

test("a platform admin targets a store and sees its data instead of an error", async ({ page }) => {
  await loginAs(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);

  // No store is targeted yet: the page must say so plainly, not blame a load failure.
  await expect(page.getByText(/Select a store/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Failed to load overview/i)).not.toBeVisible();

  // The switcher is populated from the platform-wide store list.
  const switcher = page.locator("select").first();
  await expect(switcher).toBeVisible({ timeout: 20_000 });
  const samOption = await switcher
    .locator("option")
    .filter({ hasText: "Sam's Store" })
    .first()
    .getAttribute("value");
  expect(samOption, "Sam's Store should be listed for a platform admin").toBeTruthy();
  if (!samOption) throw new Error("Sam's Store missing from the platform store list");

  // Targeting it loads that store's widgets (the switcher sends X-Store-Id).
  await switcher.selectOption(samOption);
  await expect(page.getByText(/Here's how Sam's Store is doing today/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Failed to load overview/i)).not.toBeVisible();
  await expect(page.getByText(/Today's sales/i)).toBeVisible();

  // Switching to another tenant re-scopes every widget.
  const otherValue = await switcher.locator("option").evaluateAll(
    (opts, current) =>
      (opts as HTMLOptionElement[]).find((o) => o.value && o.value !== current)?.value ?? "",
    samOption!,
  );
  expect(otherValue, "the platform list should hold more than one store").toBeTruthy();
  if (!otherValue) throw new Error("the platform store list held a single store");
  await switcher.selectOption(otherValue);
  await expect(page.getByText(/Here's how .+ is doing today/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Failed to load overview/i)).not.toBeVisible();
});
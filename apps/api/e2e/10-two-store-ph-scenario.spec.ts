// Phase 12 required two-store PH scenario.
// It is intentionally opt-in because it needs operator-provisioned two-store
// fixtures, managed DB, running API/web, and provider-safe credentials.
import { test } from "@playwright/test";

test.describe("two-store PH production scenario", () => {
  test.skip(!process.env.PH_E2E_TWO_STORE, "Set PH_E2E_TWO_STORE=1 after provisioning two isolated stores and servers");

  test("Store A and Store B remain isolated through browse→cart→checkout→delivery→receipt", async ({ page }) => {
    // Operator fixture contract:
    // PH_E2E_STORE_A_URL and PH_E2E_STORE_B_URL must be tokenized public links.
    // The completed scenario must verify:
    // 1. separate owners/catalogs/public links;
    // 2. guest browse/cart/voucher/loyalty/checkout/payment update;
    // 3. inventory reservation + delivery-zone/courier mock update;
    // 4. Messenger mock notification + BIR receipt;
    // 5. Store A cannot read Store B data and vice versa.
    const storeA = process.env.PH_E2E_STORE_A_URL;
    const storeB = process.env.PH_E2E_STORE_B_URL;
    if (!storeA || !storeB) throw new Error("PH_E2E_STORE_A_URL and PH_E2E_STORE_B_URL are required");
    await page.goto(storeA);
    await page.goto(storeB);
    throw new Error("Operator fixture steps are required before enabling this scenario");
  });
});

# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps\api\e2e\13-expired-session-redirect.spec.ts >> an expired admin token redirects to the login screen instead of a failed dashboard
- Location: apps\api\e2e\13-expired-session-redirect.spec.ts:13:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/admin/dashboard", waiting until "load"

```

# Test source

```ts
  1  | // E2E 13 — a dead admin session must not strand the operator on a broken dashboard.
  2  | // An expired or tampered token used to pass the "token present" check, then every
  3  | // panel call 401'd and the operator stared at "Failed to load overview" with no
  4  | // way back to the login screen.
  5  | import { test, expect } from "@playwright/test";
  6  | import { ADMIN_EMAIL, ADMIN_PASSWORD, loginAs } from "./helpers.js";
  7  | 
  8  | const DEAD_TOKEN =
  9  |   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  10 |   "eyJzdWIiOiJleHBpcmVkLXNlc3Npb24tdXNlciIsInJvbGUiOiJPV05FciIsInN0b3JlSWQiOiJleHBpcmVkIn0." +
  11 |   "bm90LWEtcmVhbC1zaWduYXR1cmU";
  12 | 
  13 | test("an expired admin token redirects to the login screen instead of a failed dashboard", async ({ page }) => {
  14 |   // Seed a token that is syntactically valid but signed by nobody.
  15 |   await page.addInitScript((token) => {
  16 |     sessionStorage.setItem("samstore.admin.token", token);
  17 |     sessionStorage.setItem("samstore.admin.storeId", "expired-store-id");
  18 |   }, DEAD_TOKEN);
  19 | 
> 20 |   await page.goto("/admin/dashboard");
     |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  21 | 
  22 |   await expect(page).toHaveURL(/\/admin\/login/, { timeout: 20_000 });
  23 | 
  24 |   // The dead credentials are cleared, so the login screen starts clean.
  25 |   const leftovers = await page.evaluate(() => ({
  26 |     token: sessionStorage.getItem("samstore.admin.token"),
  27 |     storeId: sessionStorage.getItem("samstore.admin.storeId"),
  28 |   }));
  29 |   expect(leftovers.token).toBeNull();
  30 |   expect(leftovers.storeId).toBeNull();
  31 | 
  32 |   // And the operator can actually get back in with a real account.
  33 |   await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  34 |   await expect(page.getByText(/Failed to load overview/i)).not.toBeVisible();
  35 | });
```
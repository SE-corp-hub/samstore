import { defineConfig } from "@playwright/test";

/** SAM STORE critical-path E2E — runs against the LOCAL servers (web :3000, API :4100).
 *  Order: 01 (api) → 02 (login) → 03 (storefront+checkout+claim).
 *  Single worker: the Supabase pool (~15 sessions) cannot serve parallel browsers. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "en-PH",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
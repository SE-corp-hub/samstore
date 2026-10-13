// E2E 17 — the platform User Access surface (Task 4) plus the full
// add-user / role / reset / visibility assertions (Task 6).
// A PLATFORM_ADMIN holds no store membership, so the panel used to hit
// /admin/stores/mine (empty for them) and the store picker rendered nothing.
// Task 6 covers: add-user with a temp password shown once, honest role lists,
// reset-button gating, the analytics days window, STAFF sidebar visibility,
// the last-owner demotion guard, and the owner's real team surface.
import { test, expect } from "@playwright/test";
import { API, PLATFORM_EMAIL, PLATFORM_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, loginAs } from "./helpers.js";
import { prisma } from "../src/persistence/prisma-repositories.js";

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

test("a platform admin adds a STAFF user: temp password shown once, member listed, honest role/reset controls", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `e2e-pau-${Date.now()}@example.test`;

  try {
    await loginAs(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);
    await page.getByRole("button", { name: "User Access" }).first().click();

    // The panel auto-selects the first store (Sam's Store — the only one), but
    // pick it explicitly so the test does not depend on that ordering.
    const picker = page
      .locator("div.d-flex.flex-wrap.gap-2.align-items-center.mb-2", { hasText: "Platform admin — any store's users" })
      .locator("select");
    const samValue = await picker.locator("option", { hasText: "Sam's Store" }).first().getAttribute("value");
    expect(samValue, "Sam's Store has a picker value").toBeTruthy();
    await picker.selectOption(samValue as string);

    // The owner row loads before we interact — it anchors the table.
    const ownerRow = page.locator("tr", { hasText: "admin@samstore.test" });
    await expect(ownerRow).toBeVisible({ timeout: 20_000 });

    // Add user — the role option list must not offer PLATFORM_ADMIN.
    await page.getByRole("button", { name: "Add user" }).click();
    const modal = page.locator(".modal");
    const addRoleSelect = modal.locator("select");
    await expect(
      addRoleSelect.locator("option", { hasText: "PLATFORM_ADMIN" }),
      "the platform add-user role list never offers PLATFORM_ADMIN",
    ).toHaveCount(0);
    await addRoleSelect.selectOption("STAFF");
    await modal.locator('input[type="email"]').fill(email);
    await modal.getByRole("button", { name: "Add user", exact: true }).click();

    // The temp password is shown once, right after creation.
    await expect(
      page.locator(".alert-warning", { hasText: "Temporary password" }),
      "the add-user flow surfaces the one-time temp password",
    ).toBeVisible({ timeout: 20_000 });

    // The new member appears with the assigned role.
    const row = page.locator("tr", { hasText: email });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator("select")).toHaveValue("STAFF");

    // Reset is absent on the STAFF row and present on the OWNER row
    // (platform admin resets only store owners — admin.controller.ts:239-247).
    await expect(row.getByRole("button", { name: /Reset/i }), "no Reset on a STAFF row").toHaveCount(0);
    await expect(ownerRow.getByRole("button", { name: /Reset/i }), "Reset present on the OWNER row").toHaveCount(1);

    // Point 2 — the role-change select on a STAFF row offers no PLATFORM_ADMIN.
    await expect(
      row.locator("select").locator("option", { hasText: "PLATFORM_ADMIN" }),
      "a STAFF row's role-change list never offers PLATFORM_ADMIN",
    ).toHaveCount(0);
  } finally {
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (u) {
      await prisma.userStore.deleteMany({ where: { userId: u.id } });
      await prisma.user.deleteMany({ where: { id: u.id } });
    }
  }
});

test("GET /admin/analytics/daily?days=7 honours the days window (API)", async ({ request }) => {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect([200, 201], `login HTTP ${res.status()}`).toContain(res.status());
  const token = (await res.json()).token as string;
  expect(token, "owner login returns a token").toBeTruthy();

  const settings = await (await request.get(`${API}/admin/settings`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const storeId = (settings.storeId ?? settings.id) as string | undefined;
  expect(storeId, "owner settings expose the store id for X-Store-Id").toBeTruthy();

  const daily = await request.get(`${API}/admin/analytics/daily?days=7`, {
    headers: { Authorization: `Bearer ${token}`, "X-Store-Id": storeId as string },
  });
  expect(daily.status(), `analytics daily HTTP ${daily.status()}`).toBe(200);
  const body = await daily.json();
  expect(Array.isArray(body.days), "analytics daily returns a days array").toBe(true);
  expect(
    body.days.length,
    "?days=7 returns at most 7 entries (the query controls the window, Task 3)",
  ).toBeLessThanOrEqual(7);
});

test("a STAFF account sees POS but no Stores or User Access in the sidebar", async ({ page }) => {
  await loginAs(page, "staff@samstore.test", "staff-pass-123");
  await expect(page.getByRole("button", { name: /^POS$/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /^Stores$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^User Access$/ })).toHaveCount(0);
});

test("the API and UI refuse to demote Sam's Store's last owner", async ({ page, request }) => {
  const login = await request.post(`${API}/auth/login`, {
    data: { email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD },
  });
  expect([200, 201], `platform login HTTP ${login.status()}`).toContain(login.status());
  const token = (await login.json()).token as string;
  const headers = { Authorization: `Bearer ${token}` };

  const stores = await (await request.get(`${API}/admin/stores`, { headers })).json();
  const store = (stores.stores ?? []).find((s: { slug: string }) => s.slug === "sam-store");
  expect(store, "the platform list contains sam-store").toBeTruthy();

  const members = await (await request.get(`${API}/admin/stores/${store.id}/users`, { headers })).json();
  const owner = (members.members ?? []).find((m: { role: string }) => m.role === "OWNER");
  expect(owner, "sam-store has an OWNER membership").toBeTruthy();

  const demote = await request.patch(`${API}/admin/stores/${store.id}/users/${owner.userId}/role`, {
    headers: { ...headers, "Content-Type": "application/json" },
    data: { role: "STAFF" },
  });
  expect(demote.status(), "demoting the last owner is refused").toBe(409);
  const demoteBody = await demote.json();
  expect(
    demoteBody.message,
    "the refusal names the last-owner rule (auth.service.ts:302-309)",
  ).toContain("Cannot demote the last active owner");

  // The UI surfaces the same message.
  await loginAs(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);
  await page.getByRole("button", { name: "User Access" }).first().click();
  const ownerRow = page.locator("tr", { hasText: "admin@samstore.test" });
  await expect(ownerRow).toBeVisible({ timeout: 20_000 });
  await ownerRow.locator("select").selectOption("STAFF");
  await expect(
    page.locator(".alert-danger", { hasText: "Cannot demote the last active owner" }),
    "the panel shows the API's refusal instead of a silent failure",
  ).toBeVisible({ timeout: 20_000 });
});

test("an owner's team surface lists only staff roles to add and no PLATFORM_ADMIN to assign", async ({ page }) => {
  // Ruling 2026-10-13: assert against the owner's real surface (TeamPanel) — the
  // owner sidebar has no User Access tab (TABS_BY_ROLE), so the unified panel's
  // owner-mode lists (exactly the 4) are covered by Task 4's review instead.
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  // Substring match: sidebar buttons carry an icon glyph in their accessible name.
  await page.getByRole("button", { name: "Team" }).first().click();

  // Add/invite role list: exactly MANAGER/STAFF/SALES_AGENT/DELIVERY.
  const inviteSelect = page.locator("form.card select");
  await expect(inviteSelect).toBeVisible({ timeout: 20_000 });
  for (const role of ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"]) {
    await expect(inviteSelect.locator(`option[value="${role}"]`)).toHaveCount(1);
  }
  await expect(inviteSelect.locator("option", { hasText: "OWNER" })).toHaveCount(0);
  await expect(inviteSelect.locator("option", { hasText: "PLATFORM_ADMIN" })).toHaveCount(0);

  // Role-change list on a non-owner row: the 4 staff roles plus OWNER — but never
  // PLATFORM_ADMIN. The OWNER option is pre-existing legacy TeamPanel behaviour
  // whose selection the API rejects (422, team.service.ts:75-77); deferred as a
  // follow-up outside this plan.
  const row = page.locator("tr", { hasText: "staff@samstore.test" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const changeSelect = row.locator("select");
  for (const role of ["MANAGER", "STAFF", "SALES_AGENT", "DELIVERY"]) {
    await expect(changeSelect.locator(`option[value="${role}"]`)).toHaveCount(1);
  }
  await expect(changeSelect.locator("option", { hasText: "OWNER" })).toHaveCount(1);
  await expect(changeSelect.locator("option", { hasText: "PLATFORM_ADMIN" })).toHaveCount(0);
});

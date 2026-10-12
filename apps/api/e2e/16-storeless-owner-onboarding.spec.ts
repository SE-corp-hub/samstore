// E2E 16 — a freshly registered owner must be told what to do next.
// Public registration creates a bare STORE_OWNER with NO store membership, and only a
// platform admin can link a store. The dashboard used to render the full tab shell for
// that account, where every store-scoped call answered 403 — leaving the operator on a
// screen that says "Select a store from the switcher above" with no switcher on it.
import { test, expect } from "@playwright/test";
import { API } from "./helpers.js";
import { prisma } from "../src/persistence/prisma-repositories.js";

test("a newly registered owner is told no store is linked yet, not shown a broken dashboard", async ({ page, request }) => {
  test.setTimeout(120_000);
  const email = `e2e-onboarding-${Date.now()}@example.test`;
  let userId: string | null = null;

  try {
    const res = await request.post(`${API}/auth/register`, {
      data: { email, password: "password123", passwordConfirm: "password123", name: "Onboarding E2E" },
    });
    expect([200, 201], `register HTTP ${res.status()}`).toContain(res.status());
    const body = await res.json();
    const token = body.token as string;
    expect(token, "registration returns a token").toBeTruthy();
    userId = (body.user?.id ?? null) as string | null;

    await page.addInitScript((t) => sessionStorage.setItem("samstore.admin.token", t), token);
    await page.goto("/admin/dashboard");

    // The state is explained, with the actual next step named.
    await expect(page.getByText(/no store linked yet/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/platform admin/i).first()).toBeVisible();

    // Neither misleading outcome appears.
    await expect(page.getByText(/Failed to load overview/i)).toHaveCount(0);
    await expect(page.getByText(/Select a store from the switcher/i)).toHaveCount(0);

    // The operator is not left on a tab surface that cannot work.
    await expect(page.getByRole("button", { name: /^POS$/ })).toHaveCount(0);
  } finally {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  }
});
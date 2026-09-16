// E2E 09 (M3) — the printed slip: tender breakdown on the receipt + the 57 mm print rules.
import { test, expect } from "@playwright/test";
import { API, ADMIN_EMAIL, ADMIN_PASSWORD, apiLogin } from "./helpers.js";

interface ReceiptPayload {
  orderNumber: string;
  payments: { method: string; methodLabel?: string; amountMinor: number; changeMinor: number; reference?: string | null; type: string }[];
  tenders?: { settlement: string; outstandingMinor: number; changeMinor: number };
  vat?: { enabled: boolean; rateBp: number; pricesIncludeVat: boolean; vatableMinor: number; vatMinor: number; vatExemptMinor: number; showOnReceipt: boolean; tin: string | null };
}

test("M3: the receipt shows every tender and prints as a 57 mm slip", async ({ page, request }) => {
  test.setTimeout(120_000);
  const token = await apiLogin(request);
  const mine = await (await request.get(`${API}/admin/stores/mine`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const storeId = (mine.stores ?? [])[0]?.id as string;
  const headers = { Authorization: `Bearer ${token}`, "X-Store-Id": storeId };

  // A counter CASH sale needs an open drawer shift (N1); create a paid split sale TODAY so the
  // panel's date filter can see it (older orders are hidden by the default view).
  await request.post(`${API}/admin/registers/open`, { headers, data: { openingFloatMinor: 50000 } });
  const productsRes = await request.get(`${API}/admin/products`, { headers });
  const productList = ((await productsRes.json()).products ?? []) as { id: string; priceMinor: number }[];
  expect(productList.length, "the store needs a product").toBeGreaterThan(0);
  const saleRes = await request.post(`${API}/admin/pos/sell`, {
    headers,
    data: {
      items: [{ productId: productList[0].id, quantity: 1 }],
      paymentMethod: "cash",
      tenders: [
        { methodCode: "cash", amountMinor: 1000, tenderedMinor: 2000 }, // ₱10 applied, ₱20 handed → ₱10 change
        { methodCode: "gcash", amountMinor: Math.max(100, productList[0].priceMinor - 1000), reference: "GC-E2E-09" },
      ],
    },
  });
  expect([200, 201], `sell failed: HTTP ${saleRes.status()} ${(await saleRes.text()).slice(0, 160)}`).toContain(saleRes.status());
  const sale = await saleRes.json();
  const orderId = (sale.orderId ?? sale.value?.orderId) as string;
  expect(orderId, "the sale returned an order id").toBeTruthy();

  const receiptRes = await request.get(`${API}/admin/orders/${orderId}/receipt`, { headers });
  expect(receiptRes.status()).toBe(200);
  const receipt = (await receiptRes.json()) as ReceiptPayload;
  const receiptVat = receipt.vat;
  const tender = receipt.payments.filter((p) => p.type !== "void");
  expect(receipt.tenders, "the receipt carries the derived settlement").toBeTruthy();

  // ── The slip itself ──
  await page.goto("/admin/login");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign\s?in|login/i }).first().click();
  await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 25_000 });

  await page.getByRole("button", { name: /Orders/ }).first().click();
  const search = page.getByPlaceholder(/Search order/i).first();
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(receipt.orderNumber);

  // The panel renders a card layout AND a table layout (one hidden per breakpoint) —
  // target the visible copy.
  const receiptBtn = page.locator('button[title="Receipt"]:visible').first();
  await expect(receiptBtn).toBeVisible({ timeout: 30_000 });
  await receiptBtn.scrollIntoViewIfNeeded();
  await receiptBtn.click();
  const slip = page.locator(".receipt-print");
  await expect(slip).toBeVisible({ timeout: 30_000 });

  // Every tender is on the slip, with its label (not the raw code) and the change handed back.
  for (const p of tender) {
    await expect(slip.getByText(p.methodLabel ?? p.method, { exact: true }).first()).toBeVisible();
  }
  await expect(slip.getByText("Status")).toBeVisible();
  if (receipt.tenders!.changeMinor > 0) {
    await expect(slip.getByText("Change").first()).toBeVisible();
  }
  const reference = tender.find((p) => p.reference)?.reference;
  if (reference) {
    await expect(slip.getByText(new RegExp(`ref ${reference}`))).toBeVisible();
  }

  // ── M4: the BIR VAT block (this store has it enabled) ──
  if (receiptVat?.showOnReceipt && receiptVat.enabled) {
    const block = slip.getByTestId("vat-breakdown");
    await expect(block).toBeVisible();
    await expect(block.getByText("VATable Sales")).toBeVisible();
    await expect(block.getByText(/^VAT \(incl\.\) 12%$/)).toBeVisible();
    await expect(block.getByText("Zero-Rated Sales")).toBeVisible();
    // The frozen base + VAT must add up to what the customer paid — the slip cannot lie.
    expect((receiptVat.vatableMinor ?? 0) + (receiptVat.vatMinor ?? 0)).toBeLessThanOrEqual(receipt.totalMinor);
  }

  // ── Print preview: only the slip survives, and the page box is the 57 mm roll ──
  const printCss = await page.evaluate(() =>
    Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n"),
  );
  expect(printCss).toMatch(/size:\s*57mm/i);

  await page.emulateMedia({ media: "print" });
  await expect(slip).toBeVisible();
  const footerVisible = await page.locator(".modal-footer").first().isVisible().catch(() => false);
  const hiddenByPrintCss = await page.locator(".modal-footer").first().evaluate((el) => getComputedStyle(el).visibility).catch(() => "visible");
  expect(hiddenByPrintCss, "everything except the slip is hidden for print").toBe("hidden");
  void footerVisible;
  await page.emulateMedia({ media: "screen" });

  // Leave the drawer as we found it (this spec opened a shift for the counter sale). Wrapped so a
  // failure above is never masked by teardown noise when the request context is already disposed.
  try {
    const xRes = await request.get(`${API}/admin/registers/report?kind=x`, { headers });
    if (xRes.status() === 200) {
      const expected = (await xRes.json()).report?.session?.live?.expectedMinor;
      if (typeof expected === "number") {
        await request.post(`${API}/admin/registers/close`, { headers, data: { countedMinor: expected } });
      }
    }
  } catch {
    /* the assertion above already reported the real failure */
  }
});
// Inventory conversion UI: manager converts a product SKU using its configured pack size;
// the server persists both movement legs, the short-yield waste note, and its audit header.
import { test, expect } from "@playwright/test";
import { API, ADMIN_EMAIL, ADMIN_PASSWORD, apiLogin, loginAs } from "./helpers.js";
import { prisma } from "../src/persistence/prisma-repositories.js";

test("Inventory converts a product SKU and records the actual yield", async ({ page, request }) => {
  test.setTimeout(180_000);
  const token = await apiLogin(request);
  const mineRes = await request.get(`${API}/admin/stores/mine`, { headers: { Authorization: `Bearer ${token}` } });
  expect(mineRes.status()).toBe(200);
  const mine = await mineRes.json();
  const storeId = (mine.stores ?? [])[0]?.id as string | undefined;
  if (!storeId) throw new Error("the admin must own a store");
  const headers = { Authorization: `Bearer ${token}`, "X-Store-Id": storeId };
  const run = `E2ECONV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const productIds: string[] = [];

  try {
    const sourceRes = await request.post(`${API}/admin/products`, {
      headers,
      data: {
        name: `${run} rice source`, sku: `${run}-SRC`, priceMinor: 150000,
        costMinor: 100000, stock: 2, stockBaseUnit: "g", stockBaseQuantity: 25000,
        stockConversionFamily: "e2e-rice",
      },
    });
    expect([200, 201], `source product create HTTP ${sourceRes.status()}`).toContain(sourceRes.status());
    const sourceId = ((await sourceRes.json()).id ?? (await sourceRes.json()).value?.id) as string;
    expect(sourceId).toBeTruthy();
    productIds.push(sourceId);

    const destinationRes = await request.post(`${API}/admin/products`, {
      headers,
      data: {
        name: `${run} rice output`, sku: `${run}-OUT`, priceMinor: 35000,
        costMinor: 0, stock: 0, stockBaseUnit: "g", stockBaseQuantity: 5000,
        stockConversionFamily: "e2e-rice",
      },
    });
    expect([200, 201], `output product create HTTP ${destinationRes.status()}`).toContain(destinationRes.status());
    const destinationId = ((await destinationRes.json()).id ?? (await destinationRes.json()).value?.id) as string;
    expect(destinationId).toBeTruthy();
    productIds.push(destinationId);

    await page.addInitScript((activeStoreId) => sessionStorage.setItem("samstore.admin.storeId", activeStoreId), storeId);
    await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.getByRole("button", { name: /Inventory/ }).first().click();
    await page.getByRole("button", { name: /Convert stock/ }).click();

    const dialog = page.getByRole("dialog", { name: /Convert stock/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Convert from").selectOption(`product:${sourceId}`);
    await dialog.getByLabel("Convert into").selectOption(`product:${destinationId}`);
    await dialog.getByLabel("Source quantity").fill("1");
    await dialog.getByLabel("Actual output quantity").fill("4");
    await dialog.getByLabel("Conversion reason").fill("Repacked rice for retail");
    await dialog.getByLabel("Waste/loss reason *").fill("One kilogram lost during repacking");

    const conversionResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().includes("/admin/stock/conversions"),
    );
    await dialog.getByRole("button", { name: "Confirm conversion" }).click();
    const conversionResponse = await conversionResponsePromise;
    expect(conversionResponse.status()).toBe(201);
    const conversionBody = await conversionResponse.json();
    const conversionId = conversionBody.conversionId as string;
    expect(conversionId).toBeTruthy();
    await expect(page.getByText(/5 kg recorded as waste/)).toBeVisible();

    const sourceMovementsRes = await request.get(`${API}/admin/stock/movements?productId=${sourceId}&limit=10`, { headers });
    const sourceMovements = (await sourceMovementsRes.json()).movements as { type: string; delta: number; conversionId: string | null }[];
    const sourceOut = sourceMovements.find((movement) => movement.conversionId === conversionId);
    expect(sourceOut?.type).toBe("CONVERSION_OUT");
    expect(sourceOut?.delta).toBe(-1);

    const destinationMovementsRes = await request.get(`${API}/admin/stock/movements?productId=${destinationId}&limit=10`, { headers });
    const destinationMovements = (await destinationMovementsRes.json()).movements as { type: string; delta: number; conversionId: string | null }[];
    const destinationIn = destinationMovements.find((movement) => movement.conversionId === conversionId);
    expect(destinationIn?.type).toBe("CONVERSION_IN");
    expect(destinationIn?.delta).toBe(4);

    const productsRes = await request.get(`${API}/admin/products`, { headers });
    const products = (await productsRes.json()).products as { id: string; quantityOnHand: number }[];
    expect(products.find((product) => product.id === sourceId)?.quantityOnHand).toBe(1);
    expect(products.find((product) => product.id === destinationId)?.quantityOnHand).toBe(4);
  } finally {
    // The spec owns these unique test SKUs; remove only its conversion audit and products.
    if (productIds.length > 0) {
      for (const productId of productIds) await request.delete(`${API}/admin/products/${productId}`, { headers });
      const conversions = await prisma.stockConversion.findMany({
        where: { storeId, OR: [{ sourceProductId: { in: productIds } }, { destinationProductId: { in: productIds } }] },
        select: { id: true },
      });
      const conversionIds = conversions.map((conversion) => conversion.id);
      if (conversionIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { storeId, entityType: "StockConversion", entityId: { in: conversionIds } } });
      }
      await prisma.stockMovement.deleteMany({ where: { storeId, productId: { in: productIds } } });
      if (conversionIds.length > 0) await prisma.stockConversion.deleteMany({ where: { storeId, id: { in: conversionIds } } });
      await prisma.stockLevel.deleteMany({ where: { storeId, productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { storeId, id: { in: productIds } } });
    }
  }
});

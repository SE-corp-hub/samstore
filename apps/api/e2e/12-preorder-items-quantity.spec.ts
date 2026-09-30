// Pre-Orders tab: the Items column lists every line WITH its quantity (e.g. "2 × Iced Kape")
// instead of showing only a bare item count, and the row still carries the order number,
// customer and total.
import { test, expect } from "@playwright/test";
import { API, ADMIN_EMAIL, ADMIN_PASSWORD, apiLogin, loginAs } from "./helpers.js";
import { prisma } from "../src/persistence/prisma-repositories.js";

test("Pre-Orders list shows each item with its quantity", async ({ page, request }) => {
  test.setTimeout(180_000);
  const token = await apiLogin(request);
  const mineRes = await request.get(`${API}/admin/stores/mine`, { headers: { Authorization: `Bearer ${token}` } });
  expect(mineRes.status()).toBe(200);
  const mine = await mineRes.json();
  const storeId = (mine.stores ?? [])[0]?.id as string | undefined;
  if (!storeId) throw new Error("the admin must own a store");
  const headers = { Authorization: `Bearer ${token}`, "X-Store-Id": storeId };

  const run = `E2EPRE-${Date.now()}`.toUpperCase();
  const productName = `${run} qty kape`;
  const customerName = `${run} buyer`;
  const productIds: string[] = [];
  let orderId: string | null = null;

  try {
    const productRes = await request.post(`${API}/admin/products`, {
      headers,
      data: { name: productName, sku: `${run}-QTY`, priceMinor: 12000, stock: 10 },
    });
    expect([200, 201], `product create HTTP ${productRes.status()}`).toContain(productRes.status());
    const productBody = await productRes.json();
    const productId = (productBody.id ?? productBody.value?.id) as string;
    expect(productId).toBeTruthy();
    productIds.push(productId);

    const customerRes = await request.post(`${API}/admin/pos/quick-customer`, { headers, data: { name: customerName } });
    expect([200, 201], `quick customer HTTP ${customerRes.status()}`).toContain(customerRes.status());
    const customerId = ((await customerRes.json()).id ?? productBody.id) as string;

    const preRes = await request.post(`${API}/admin/pos/preorder`, {
      headers,
      data: { customerId, items: [{ productId, quantity: 2 }] },
    });
    expect([200, 201], `pre-order create HTTP ${preRes.status()}`).toContain(preRes.status());
    const pre = await preRes.json();
    orderId = (pre.orderId ?? pre.value?.orderId) as string;
    expect(orderId).toBeTruthy();

    // ── The staff view: Pre Orders tab ──
    const listRes = await request.get(`${API}/admin/pos/preorders`, { headers });
    expect(listRes.status()).toBe(200);
    const listed = ((await listRes.json()).preorders ?? []) as { id: string; orderNumber: string; items: { quantity: number }[] }[];
    const listedMine = listed.find((p) => p.id === orderId);
    expect(listedMine, "the draft is returned by the list endpoint").toBeTruthy();
    expect(listedMine?.items?.[0]?.quantity, "the list endpoint carries the line quantity").toBe(2);
    const orderNumber = listedMine!.orderNumber;

    await page.addInitScript((activeStoreId) => sessionStorage.setItem("samstore.admin.storeId", activeStoreId), storeId);
    await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.getByRole("button", { name: /Pre Order/ }).first().click();

    // The draft row for this pre-order. Scope by ORDER NUMBER: the panel also renders an
    // aggregate hold/sold table that repeats product names without an order number.
    const row = page.getByRole("row").filter({ hasText: orderNumber });
    await expect(row, "the pre-order row is listed").toBeVisible({ timeout: 60_000 });
    const itemsCell = row.getByRole("cell").nth(2);
    await expect(itemsCell, "the Items cell carries the quantity").toContainText("2");
    await expect(itemsCell).toContainText(run);
    // "2 × <product name>" — the quantity belongs to the item, not a bare count.
    await expect(itemsCell).toHaveText(new RegExp(`2\\s*[×x]\\s*${run}\\s+qty kape`));
  } finally {
    if (orderId) {
      await request.post(`${API}/admin/pos/holds/${orderId}/void`, { headers, data: { reason: "E2E cleanup" } });
      const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
      if (order) {
        await prisma.orderStatusHistory.deleteMany({ where: { orderId } });
        await prisma.orderItem.deleteMany({ where: { orderId } });
        await prisma.orderClaimToken.deleteMany({ where: { orderId } });
        await prisma.payment.deleteMany({ where: { orderId } });
        await prisma.creditEntry.deleteMany({ where: { orderId } });
        await prisma.loyaltyEntry.deleteMany({ where: { orderId } });
        await prisma.order.deleteMany({ where: { id: orderId } });
      }
    }
    for (const productId of productIds) await request.delete(`${API}/admin/products/${productId}`, { headers });
    await prisma.stockMovement.deleteMany({ where: { storeId, productId: { in: productIds } } });
    await prisma.stockLevel.deleteMany({ where: { storeId, productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { storeId, id: { in: productIds } } });
    const storeCustomer = await prisma.storeCustomer.findFirst({ where: { storeId, customer: { name: customerName } }, select: { id: true, customerId: true } });
    if (storeCustomer) {
      await prisma.storeCustomer.deleteMany({ where: { id: storeCustomer.id } });
      await prisma.customer.deleteMany({ where: { id: storeCustomer.customerId, name: customerName } });
    }
  }
});

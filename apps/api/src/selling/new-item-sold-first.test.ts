// Inventory audit 2026-11-21: a new item (made in Products with no opening stock) is sold before its first
// Stock in. The sale must still come off the shelf, so the Stock in that follows shows what is really there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { BentaService } from "./benta.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { clearStoreActivity } from "../admin/clear-store-activity.js";
import { checkChain } from "../domain/stock-book.js";
import type { Actor } from "../people/people.service.js";

const run = `newfirst${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const storeIds: string[] = [];
const userIds: string[] = [];

after(async () => {
  for (const storeId of storeIds) {
    await clearStoreActivity(storeId, { apply: true });
    const where = { storeId };
    await prisma.auditLog.deleteMany({ where });
    await prisma.priceHistory.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.delete({ where: { id: storeId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("a new item sold before its first Stock in: the count goes to −1, Stock in of 5 shows 4, a refund puts it back, the stock book holds", async () => {
  const store = await prisma.store.create({ data: { slug: run, name: "New item first" } });
  storeIds.push(store.id);
  const storeId = store.id;
  await prisma.storeSettings.create({ data: { storeId, requireOpenShift: false } });
  const s1 = await prisma.warehouse.create({ data: { storeId, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  // As Products → New product makes it with no opening stock: no stock row anywhere.
  const rice = await prisma.product.create({ data: { storeId, sku: `${run}-J25`, name: "Jasmine 25 kg", priceMinor: 150_000, costMinor: 130_000, stockBaseUnit: "g", stockBaseQuantity: 25_000 } });
  const user = await prisma.user.create({ data: { email: `${run}@new.test`, passwordHash: "x", name: "Lucy", role: "STORE_OWNER" } });
  userIds.push(user.id);
  await prisma.userStore.create({ data: { userId: user.id, storeId, role: "OWNER" } });
  const owner: Actor = { userId: user.id, role: "OWNER", homeLocationId: null };
  const counter = new BentaService();
  const shelf = async () => (await prisma.stockLevel.findFirst({ where: { storeId, productId: rice.id, warehouseId: s1.id } }))?.quantityOnHand ?? null;

  const sale = await counter.sell(storeId, owner, { idempotencyKey: `tap-${randomBytes(8).toString("hex")}`, locationId: s1.id, lines: [{ productId: rice.id, quantity: 1 }], payment: { method: "cash" } });
  assert.ok(sale.ok, JSON.stringify(sale));
  assert.equal(await shelf(), -1, "the sale is on the count (it was skipped: no row, no stock book line)");

  const stockIn = await counter.stockIn(storeId, owner, { locationId: s1.id, lines: [{ productId: rice.id, quantity: 5, unitCostMinor: 130_000 }], signatures: [{ signerKind: "STAFF", imagePng: PNG }] });
  assert.ok(stockIn.ok, JSON.stringify(stockIn));
  assert.equal(await shelf(), 4, "5 arrived, 1 was already sold (it showed 5)");

  assert.ok((await new PaymentsService().refundOrder(sale.value.orderId, storeId, owner.userId, undefined, "x")).ok);
  assert.equal(await shelf(), 5);

  const rows = await prisma.stockMovement.findMany({ where: { storeId, productId: rice.id, warehouseId: s1.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  assert.equal(checkChain(rows, 5).status, "ok");
});

test("Track stock off still never touches the count", async () => {
  const storeId = storeIds[0]!;
  const s1 = await prisma.warehouse.findFirstOrThrow({ where: { storeId, code: "S1" } });
  const owner: Actor = { userId: userIds[0]!, role: "OWNER", homeLocationId: null };
  const bag = await prisma.product.create({ data: { storeId, sku: `${run}-BAG`, name: "Plastic bag", priceMinor: 500, trackStock: false } });
  const sale = await new BentaService().sell(storeId, owner, { idempotencyKey: `tap-${randomBytes(8).toString("hex")}`, locationId: s1.id, lines: [{ productId: bag.id, quantity: 3 }], payment: { method: "cash" } });
  assert.ok(sale.ok, JSON.stringify(sale));
  assert.equal(await prisma.stockLevel.count({ where: { storeId, productId: bag.id } }), 0);
  assert.equal(await prisma.stockMovement.count({ where: { storeId, productId: bag.id } }), 0);
});

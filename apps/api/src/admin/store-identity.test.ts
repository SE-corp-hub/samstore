// Per-store build, step 9 — what a store calls itself, against the real DB.
//   * the owner sets a store's own receipt name and text, daily target and order-number start;
//     empty goes back to the business's;
//   * a sale's receipt carries the selling store's name and text; a store with none uses the business's;
//   * the start of the order number is the selling store's own when set.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { WarehouseService } from "./warehouse.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { cleanIdentityText, orderPrefixAt } from "../domain/store-identity.js";
import { formatOrderNumber } from "../domain/order-number.js";

const run = `idn${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const warehouses = new WarehouseService();

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.order.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

async function fixture() {
  const store = await prisma.store.create({ data: { slug: run, name: "Sam Rice Trading" } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false, orderNumberPrefix: "SAM" } });
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const lipa = await prisma.warehouse.create({ data: { storeId: store.id, name: "Lipa", code: "S3", type: "STORE", consignment: true } });
  return { storeId: store.id, main: main.id, lipa: lipa.id };
}
const order = (storeId: string, locationId: string, n: number) => prisma.order.create({
  data: { storeId, orderNumber: `${run}-${n}`, status: "COMPLETED", source: "pos", subtotalMinor: 135_000, totalMinor: 135_000, currencyCode: "PHP", sellingLocationId: locationId, snapshot: {}, cartToken: `${run}-cart-${n}`, customerName: "Walk-in", customerPhone: "", deliveryAddressLine1: "" },
});

test("the pure rules for a store's own text", () => {
  assert.deepEqual(cleanIdentityText("receiptName", "  Lipa   Rice  Store "), { ok: true, value: "Lipa Rice Store" });
  assert.deepEqual(cleanIdentityText("receiptFooter", "   "), { ok: true, value: null });
  assert.deepEqual(cleanIdentityText("orderPrefix", "lipa-1"), { ok: true, value: "LIPA1" });
  assert.equal(cleanIdentityText("orderPrefix", "L").ok, false);
  assert.equal(cleanIdentityText("orderPrefix", "LIPACITY").ok, false);
  assert.equal(cleanIdentityText("receiptName", "x".repeat(61)).ok, false);
});

test("a store's own name, text, target and order numbers; empty goes back to the business's", async () => {
  const fx = await fixture();
  const saved = await warehouses.update(fx.storeId, fx.lipa, { receiptName: "Lipa Rice Store", receiptHeader: "P. Torres St., Lipa City", receiptFooter: "Salamat po!", receiptContact: "0917 555 0101", dailySalesTargetMinor: 2_000_000, orderPrefix: "lipa" });
  assert.equal(saved.ok, true);
  const row = (await warehouses.list(fx.storeId)).find((w) => w.id === fx.lipa)!;
  assert.deepEqual(
    { n: row.receiptName, h: row.receiptHeader, f: row.receiptFooter, c: row.receiptContact, t: row.dailySalesTargetMinor, p: row.orderPrefix },
    { n: "Lipa Rice Store", h: "P. Torres St., Lipa City", f: "Salamat po!", c: "0917 555 0101", t: 2_000_000, p: "LIPA" },
  );
  assert.equal((await warehouses.update(fx.storeId, fx.lipa, { orderPrefix: "L" })).ok, false);
  assert.equal((await warehouses.update(fx.storeId, fx.lipa, { dailySalesTargetMinor: -1 })).ok, false);

  // Order numbers: the selling store's own start, else the business's.
  assert.equal(await orderPrefixAt(prisma, fx.storeId, fx.lipa, "SAM"), "LIPA");
  assert.equal(await orderPrefixAt(prisma, fx.storeId, fx.main, "SAM"), "SAM");
  assert.equal(await orderPrefixAt(prisma, fx.storeId, null, null), undefined);
  assert.match(formatOrderNumber(run, 7, { prefix: await orderPrefixAt(prisma, fx.storeId, fx.lipa, "SAM") }), /^LIPA-\d{4}-000007$/);

  // Receipts: the selling store's name and text; the main store has none of its own.
  const payments = new PaymentsService();
  const atLipa = await order(fx.storeId, fx.lipa, 1);
  const atMain = await order(fx.storeId, fx.main, 2);
  const r1 = (await payments.receipt(atLipa.id, fx.storeId)) as { storeName: string; locationId: string | null; receiptHeader: string | null; receiptFooter: string | null; receiptContact: string | null };
  assert.deepEqual({ n: r1.storeName, l: r1.locationId, h: r1.receiptHeader, f: r1.receiptFooter, c: r1.receiptContact }, { n: "Lipa Rice Store", l: fx.lipa, h: "P. Torres St., Lipa City", f: "Salamat po!", c: "0917 555 0101" });
  const r2 = (await payments.receipt(atMain.id, fx.storeId)) as typeof r1;
  assert.deepEqual({ n: r2.storeName, h: r2.receiptHeader, f: r2.receiptFooter }, { n: "Sam Rice Trading", h: null, f: null });

  // Emptied: back to the business's.
  assert.equal((await warehouses.update(fx.storeId, fx.lipa, { receiptName: "", orderPrefix: null, dailySalesTargetMinor: 0 })).ok, true);
  const again = (await warehouses.list(fx.storeId)).find((w) => w.id === fx.lipa)!;
  assert.deepEqual({ n: again.receiptName, p: again.orderPrefix, t: again.dailySalesTargetMinor, h: again.receiptHeader }, { n: null, p: null, t: null, h: "P. Torres St., Lipa City" });
  assert.equal(await orderPrefixAt(prisma, fx.storeId, fx.lipa, "SAM"), "SAM");
});

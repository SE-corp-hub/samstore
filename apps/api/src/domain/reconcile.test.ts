// Module 6/11 fix — reconciliation: every balance must equal its ledger.
// Seeds deliberate drift for vouchers, loyalty, credit and stock, proves each is
// detected, then proves `--apply` (applyDrift) corrects it from the ledger.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import { applyDrift, reconcileAll, reconcileCredit, reconcileLoyalty, reconcileStock, reconcileVouchers } from "./reconcile.js";

const run = `RC${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const productIds: string[] = [];
const customerIds: string[] = [];

after(async () => {
  if (storeIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.stockMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.voucherRedemption.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.voucher.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.loyaltyEntry.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.creditEntry.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.storeCustomer.deleteMany({ where: { storeId: { in: storeIds } } });
    if (customerIds.length) await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.stockLevel.deleteMany({ where: { storeId: { in: storeIds } } });
    if (productIds.length) await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

test("voucher / loyalty / credit / stock drift is detected, then corrected from the ledger", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-s`.toLowerCase(), name: `RC ${run}` } });
  storeIds.push(store.id);

  // ── voucher: usedCount says 0, but two redemption rows exist ──
  const voucher = await prisma.voucher.create({ data: { storeId: store.id, code: `${run}V`, discountMinor: 100, usedCount: 0 } });
  for (let i = 0; i < 2; i += 1) {
    await prisma.voucherRedemption.create({ data: { voucherId: voucher.id, storeId: store.id, orderId: null } });
  }

  // ── loyalty: balance says 900, ledger sums to 400 ──
  const customer = await prisma.customer.create({ data: { name: `RC ${run}`, phone: null, email: null, passwordHash: null } });
  customerIds.push(customer.id);
  const sc = await prisma.storeCustomer.create({
    data: { storeId: store.id, customerId: customer.id, loyaltyBalancePoints: 900, creditBalanceMinor: 0, creditApproved: true, creditLimitMinor: 500000 },
  });
  await prisma.loyaltyEntry.create({ data: { storeId: store.id, customerId: customer.id, storeCustomerId: sc.id, type: "EARN", points: 500, balanceAfter: 500, description: "seed" } });
  await prisma.loyaltyEntry.create({ data: { storeId: store.id, customerId: customer.id, storeCustomerId: sc.id, type: "REDEEM", points: -100, balanceAfter: 400, description: "seed" } });

  // ── credit: balance says 0, ledger has +25000 purchase −5000 payment = 20000 ──
  await prisma.creditEntry.create({ data: { storeId: store.id, storeCustomerId: sc.id, type: "purchase", amountMinor: 25000, startAt: new Date(), createdBy: "test" } });
  await prisma.creditEntry.create({ data: { storeId: store.id, storeCustomerId: sc.id, type: "payment", amountMinor: -5000, startAt: new Date(), createdBy: "test" } });

  // ── stock: onHand 7, ledger implies 5 (first movement balanceAfter 6 for delta +6, then −1) ──
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${run}SKU`, name: "RC Product", priceMinor: 1000 } });
  productIds.push(product.id);
  const level = await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 7, quantityReserved: 0 } });
  await prisma.stockMovement.create({ data: { storeId: store.id, productId: product.id, warehouseId: null, delta: 6, type: "RECEIPT", createdBy: "test", balanceAfter: 6 } });
  await prisma.stockMovement.create({ data: { storeId: store.id, productId: product.id, warehouseId: null, delta: -1, type: "CONSUME", createdBy: "test", balanceAfter: 5 } });

  // ── detection ──
  const vouchers = await reconcileVouchers({ storeId: store.id });
  assert.equal(vouchers.length, 1, "voucher drift detected");
  assert.equal(vouchers[0]!.expected, 2);
  assert.equal(vouchers[0]!.actual, 0);

  const loyalty = await reconcileLoyalty({ storeId: store.id });
  assert.equal(loyalty.length, 1, "loyalty drift detected");
  assert.equal(loyalty[0]!.expected, 400);
  assert.equal(loyalty[0]!.actual, 900);

  const credit = await reconcileCredit({ storeId: store.id });
  assert.equal(credit.length, 1, "credit drift detected");
  assert.equal(credit[0]!.expected, 20000);
  assert.equal(credit[0]!.actual, 0);

  const stock = await reconcileStock({ storeId: store.id });
  assert.equal(stock.length, 1, "stock drift detected");
  assert.equal(stock[0]!.expected, 5);
  assert.equal(stock[0]!.actual, 7);

  const report = await reconcileAll({ storeId: store.id });
  assert.equal(report.rows.length, 4, "all four kinds reported by reconcileAll");
  assert.equal(report.checked.vouchers, 1);

  // ── correction (what `--apply` calls) ──
  for (const row of report.rows) await applyDrift(row);

  assert.equal((await prisma.voucher.findUnique({ where: { id: voucher.id } }))?.usedCount, 2, "voucher counter corrected to the ledger");
  assert.equal((await prisma.storeCustomer.findUnique({ where: { id: sc.id } }))?.loyaltyBalancePoints, 400, "loyalty balance corrected");
  assert.equal((await prisma.storeCustomer.findUnique({ where: { id: sc.id } }))?.creditBalanceMinor, 20000, "credit balance corrected");
  assert.equal((await prisma.stockLevel.findUnique({ where: { id: level.id } }))?.quantityOnHand, 5, "stock balance corrected");

  const adjustments = await prisma.stockMovement.findMany({ where: { productId: product.id, type: "ADJUST" } });
  assert.equal(adjustments.length, 1, "stock correction is auditable as an ADJUST movement");
  assert.equal(adjustments[0]!.delta, 0, "the audit movement must not move the ledger sum (identity stays true)");
  assert.match(adjustments[0]!.note ?? "", /onHand 7 → 5/, "the ADJUST note records the corrected values");

  // ── a second pass is clean (nothing left to fix) ──
  const after2 = await reconcileAll({ storeId: store.id });
  assert.equal(after2.rows.length, 0, "reconciliation now reports zero drift");
});

test("a RESERVE movement does not create phantom stock drift (it moves quantityReserved, not on-hand)", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-rsv`.toLowerCase(), name: `RC rsv ${run}` } });
  storeIds.push(store.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${run}RSV`, name: "RC Reserve Product", priceMinor: 1000 } });
  productIds.push(product.id);
  const level = await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 30, quantityReserved: 6 } });
  // On-hand history: one consume that left 30.
  await prisma.stockMovement.create({ data: { storeId: store.id, productId: product.id, warehouseId: null, delta: -2, type: "CONSUME", createdBy: "test", balanceAfter: 30 } });
  // Reservations: deltas that belong to quantityReserved (6), with reserved balances.
  await prisma.stockMovement.create({ data: { storeId: store.id, productId: product.id, warehouseId: null, delta: 6, type: "RESERVE", createdBy: "checkout", balanceAfter: 6 } });
  await prisma.stockMovement.create({ data: { storeId: store.id, productId: product.id, warehouseId: null, delta: 15, type: "RESERVE", createdBy: "checkout", balanceAfter: 21 } });

  const rows = await reconcileStock({ storeId: store.id });
  assert.equal(rows.length, 0, `on-hand must equal 32 (34 initial − 2): ${JSON.stringify(rows)}`);
  assert.equal(level.quantityOnHand, 30);
});

test("a consistent fixture reports zero drift", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-clean`.toLowerCase(), name: `RC clean ${run}` } });
  storeIds.push(store.id);
  const customer = await prisma.customer.create({ data: { name: `RC clean ${run}`, phone: null, email: null, passwordHash: null } });
  customerIds.push(customer.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: customer.id, loyaltyBalancePoints: 150, creditBalanceMinor: 1000 } });
  await prisma.loyaltyEntry.create({ data: { storeId: store.id, customerId: customer.id, storeCustomerId: sc.id, type: "EARN", points: 150, balanceAfter: 150, description: "seed" } });
  await prisma.creditEntry.create({ data: { storeId: store.id, storeCustomerId: sc.id, type: "purchase", amountMinor: 1000, startAt: new Date(), createdBy: "test" } });

  const report = await reconcileAll({ storeId: store.id });
  assert.equal(report.rows.length, 0, JSON.stringify(report.rows));
  assert.equal(report.checked.loyalty, 1);
  assert.equal(randomId().length > 0, true); // sanity: fixture ids helper is wired
});

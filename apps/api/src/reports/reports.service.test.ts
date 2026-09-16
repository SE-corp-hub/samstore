import { test } from "node:test";
import assert from "node:assert/strict";
import { ReportsService } from "./reports.service.js";

const svc = new ReportsService();

test("profitSummary returns shaped estimate for unknown store", async () => {
  const r = await svc.profitSummary("nope", new Date(Date.now() - 86_400_000), new Date());
  assert.equal(typeof r.revenueMinor, "number");
  assert.equal(typeof r.profitMinor, "number");
  assert.equal(typeof r.cogsNote, "string");
});

test("salesReport returns splits", async () => {
  const r = await svc.salesReport("nope", new Date(Date.now() - 86_400_000), new Date());
  assert.ok(Array.isArray(r.paymentSplit));
  assert.ok(Array.isArray(r.topCustomers));
  assert.equal(typeof r.utangAging.currentMinor, "number");
});

// M8 reports

test("stockLow returns low-stock rows (empty for unknown store)", async () => {
  const r = await svc.stockLow("nope", new Date(Date.now() - 86_400_000), new Date());
  assert.equal(Array.isArray(r.rows), true);
  assert.equal(typeof r.count, "number");
  assert.equal(r.count, 0);
});

test("soldStock returns sold-units rows (empty for unknown store)", async () => {
  const r = await svc.soldStock("nope", new Date(Date.now() - 86_400_000), new Date());
  assert.equal(Array.isArray(r.rows), true);
  assert.equal(typeof r.totalUnitsSold, "number");
  assert.equal(r.totalUnitsSold, 0);
});

test("incomeLoss returns shaped breakdown (empty for unknown store)", async () => {
  const r = await svc.incomeLoss("nope", new Date(Date.now() - 86_400_000), new Date());
  assert.equal(typeof r.income.revenueMinor, "number");
  assert.equal(typeof r.expenses.totalMinor, "number");
  assert.equal(typeof r.profitMinor, "number");
  assert.ok(Array.isArray(r.expenses.lineItems));
});

test("salesByPayment returns payment-method rows (empty for unknown store)", async () => {
  const r = await svc.salesByPayment("nope", new Date(Date.now() - 86_400_000), new Date());
  assert.ok(Array.isArray(r.rows));
  assert.equal(typeof r.grandTotal, "number");
});

test("customerStatement returns per-customer rows (empty for unknown store)", async () => {
  const r = await svc.customerStatement("nope", new Date(Date.now() - 86_400_000), new Date());
  assert.ok(Array.isArray(r.rows));
  assert.equal(typeof r.totalPaidMinor, "number");
  assert.equal(typeof r.totalCreditMinor, "number");
});
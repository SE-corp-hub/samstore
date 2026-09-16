// v4 admin customers & loyalty + credit ledger filters.
// Uses the real Prisma client (like the other *.test.ts files); every fixture is a
// unique run-scoped record and is deleted in the after() hook so the shared DB stays clean.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { CreditService } from "../credit/credit.service.js";

const loyalty = new LoyaltyService();
const credit = new CreditService();

const run = `V4T${Date.now()}${Math.floor(Math.random() * 1000)}`;
const STORE = "cmtifdks2000094ic1j9w8th7"; // seeded sam-store
const OTHER_STORE = "cmtl2go8u000194dgi5ysohv5"; // seeded store two

const scIds: string[] = [];
const customerIds: string[] = [];

function phone(tag: string) {
  return `0917-${run}-${tag}`;
}

/** Create via the service and track for cleanup. */
async function createTracked(storeId: string, input: { name: string; phone: string; email?: string; creditApproved?: boolean; creditLimitMinor?: number }) {
  const r = await loyalty.createCustomer(storeId, input);
  assert.equal(r.ok, true, `fixture create failed: ${input.name}`);
  if (!r.ok) throw new Error(`fixture create failed: ${input.name}`);
  customerIds.push(r.value.customerId);
  scIds.push(r.value.id);
  return r.value;
}

/** Seed a ledger customer directly (controlled balance + entry timestamps). */
async function makeLedgerCustomer(name: string, balanceMinor: number, entryAt: Date, amountMinor: number) {
  const customer = await prisma.customer.create({
    data: { name, phone: phone(name), email: `${phone(name)}@example.test` },
  });
  customerIds.push(customer.id);
  const sc = await prisma.storeCustomer.create({
    data: { storeId: STORE, customerId: customer.id, creditBalanceMinor: balanceMinor, creditApproved: true, creditLimitMinor: 100_000 },
  });
  scIds.push(sc.id);
  await prisma.creditEntry.create({
    data: {
      storeId: STORE,
      storeCustomerId: sc.id,
      type: "purchase",
      amountMinor,
      startAt: entryAt,
      dueAt: new Date(entryAt.getTime() + 30 * 86_400_000),
      createdAt: entryAt,
      note: `v4 test entry ${run}`,
    },
  });
  return { scId: sc.id, customerId: customer.id };
}

after(async () => {
  if (customerIds.length > 0) {
    const scs = await prisma.storeCustomer.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
    const ids = [...new Set([...scIds, ...scs.map((s) => s.id)])];
    if (ids.length > 0) {
      await prisma.creditEntry.deleteMany({ where: { storeCustomerId: { in: ids } } });
      await prisma.loyaltyEntry.deleteMany({ where: { storeCustomerId: { in: ids } } });
      await prisma.storeCustomer.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  }
  await prisma.$disconnect();
});

// ─────────────────────────────── createCustomer ───────────────────────────────

test("createCustomer requires a non-blank name", async () => {
  const r = await loyalty.createCustomer(STORE, { name: "   " });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("createCustomer rejects bad creditLimitMinor", async () => {
  for (const v of [-1, 1.5, "100"]) {
    const r = await loyalty.createCustomer(STORE, { name: `${run} badlimit ${v}`, creditLimitMinor: v as number });
    assert.equal(r.ok, false, `limit ${v} should be rejected`);
    if (!r.ok) assert.equal(r.error.type, "validation");
  }
});

test("createCustomer creates a pre-approved store profile", async () => {
  const row = await createTracked(STORE, {
    name: `${run} Alice`,
    phone: phone("alice"),
    email: `${phone("alice")}@example.test`,
    creditApproved: true,
    creditLimitMinor: 25_000,
  });
  assert.equal(row.name, `${run} Alice`);
  assert.equal(row.phone, phone("alice"));
  assert.equal(row.approvalStatus, "APPROVED");
  assert.equal(row.creditApproved, true);
  assert.equal(row.creditLimitMinor, 25_000);
  assert.equal(row.loyaltyPoints, 0);
  assert.equal(row.creditBalanceMinor, 0);
  assert.ok(row.joinedAt instanceof Date);
});

test("createCustomer same phone in same store → conflict", async () => {
  const a = await loyalty.createCustomer(STORE, { name: `${run} Dup`, phone: phone("dup") });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  customerIds.push(a.value.customerId);
  scIds.push(a.value.id);

  const again = await loyalty.createCustomer(STORE, { name: `${run} Dup2`, phone: phone("dup") });
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.equal(again.error.type, "conflict");
    assert.equal(again.error.message, "Customer already exists in this store");
  }
});

test("createCustomer reuses the global customer across stores (new store profile)", async () => {
  const a = await loyalty.createCustomer(STORE, { name: `${run} Shared`, phone: phone("shared") });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  customerIds.push(a.value.customerId);
  scIds.push(a.value.id);

  // Same phone in another store → same global Customer, NEW StoreCustomer (find-or-create reuses the global row as-is).
  const b = await loyalty.createCustomer(OTHER_STORE, { name: `${run} Shared 2`, phone: phone("shared") });
  assert.equal(b.ok, true);
  if (b.ok) {
    assert.notEqual(b.value.id, a.value.id, "a fresh store profile is created for the second store");
    scIds.push(b.value.id);
    assert.equal(b.value.customerId, a.value.customerId, "global customer is shared across stores");
    assert.equal(b.value.name, a.value.name, "global customer record is reused unchanged");
  }
});

test("createCustomer falls back to email when phone is new", async () => {
  const a = await loyalty.createCustomer(STORE, { name: `${run} MailA`, phone: phone("maila"), email: `${phone("maila")}@example.test` });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  customerIds.push(a.value.customerId);
  scIds.push(a.value.id);

  const b = await loyalty.createCustomer(STORE, { name: `${run} MailB`, phone: phone("mailb"), email: `${phone("maila")}@example.test` });
  assert.equal(b.ok, false, "different phone + same email should resolve to the existing global customer");
  if (!b.ok) assert.equal(b.error.type, "conflict");
});

// ─────────────────────────────── updateCustomer ───────────────────────────────

test("updateCustomer updates name + credit limit; scoped to store (404 cross-store)", async () => {
  const row = await createTracked(STORE, { name: `${run} Upd`, phone: phone("upd") });

  const r = await loyalty.updateCustomer(STORE, row.id, { name: `${run} Upd2`, creditLimitMinor: 5_000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.name, `${run} Upd2`);
    assert.equal(r.value.creditLimitMinor, 5_000);
  }

  const cross = await loyalty.updateCustomer(OTHER_STORE, row.id, { name: "nope" });
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.error.type, "not_found");

  const missing = await loyalty.updateCustomer(STORE, "no-such-id", { name: "nope" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.type, "not_found");
});

test("updateCustomer validates name + creditLimitMinor", async () => {
  const row = await createTracked(STORE, { name: `${run} UpdVal`, phone: phone("updval") });

  const badName = await loyalty.updateCustomer(STORE, row.id, { name: "   " });
  assert.equal(badName.ok, false);
  if (!badName.ok) assert.equal(badName.error.type, "validation");

  const badLimit = await loyalty.updateCustomer(STORE, row.id, { creditLimitMinor: -3 });
  assert.equal(badLimit.ok, false);
  if (!badLimit.ok) assert.equal(badLimit.error.type, "validation");
});

// ─────────────────────────────── adjustPoints ───────────────────────────────

test("adjustPoints adds and subtracts with audit entries", async () => {
  const row = await createTracked(STORE, { name: `${run} Pts`, phone: phone("pts") });

  const add = await loyalty.adjustPoints(STORE, row.id, 50, "  promo  ");
  assert.equal(add.ok, true);
  if (!add.ok) return;
  assert.equal(add.value.balanceAfter, 50);
  assert.equal(add.value.entry.type, "ADJUST");
  assert.equal(add.value.entry.points, 50);
  assert.equal(add.value.entry.balanceAfter, 50);
  assert.equal(add.value.entry.description, "Manual adjust: promo");
  assert.ok(add.value.entry.id.length > 0);

  const sub = await loyalty.adjustPoints(STORE, row.id, -20, "correction");
  assert.equal(sub.ok, true);
  if (sub.ok) assert.equal(sub.value.balanceAfter, 30);
});

test("adjustPoints rejects below-zero and leaves balance unchanged", async () => {
  const row = await createTracked(STORE, { name: `${run} PtsMin`, phone: phone("ptsmin") });

  const r = await loyalty.adjustPoints(STORE, row.id, -5, "oops");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.type, "conflict");
    assert.equal(r.error.message, "Balance cannot go below 0");
  }
  const sc = await prisma.storeCustomer.findUnique({ where: { id: row.id } });
  assert.equal(sc?.loyaltyBalancePoints, 0);
  const entries = await prisma.loyaltyEntry.findMany({ where: { storeCustomerId: row.id } });
  assert.equal(entries.length, 0);
});

test("adjustPoints validates delta + note", async () => {
  const row = await createTracked(STORE, { name: `${run} PtsVal`, phone: phone("ptsval") });

  for (const delta of [0, 1.5, "10"]) {
    const r = await loyalty.adjustPoints(STORE, row.id, delta as unknown as number, "x");
    assert.equal(r.ok, false, `delta ${delta} should be rejected`);
    if (!r.ok) assert.equal(r.error.type, "validation");
  }
  const blank = await loyalty.adjustPoints(STORE, row.id, 10, "  ");
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.error.type, "validation");
});

test("adjustPoints unknown customer → not_found", async () => {
  const r = await loyalty.adjustPoints(STORE, "no-such-sc", 10, "x");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

// ─────────────────────────────── credit ledger filters ───────────────────────────────

test("utangList search matches customer name (insensitive)", async () => {
  const alpha = await makeLedgerCustomer(`${run} SearchAlpha`, 1_200, new Date("2026-06-01T08:00:00.000Z"), 1_200);
  const beta = await makeLedgerCustomer(`${run} SearchBeta`, 0, new Date("2026-06-01T08:00:00.000Z"), 500);

  const unpaid = await credit.utangList(STORE, "unpaid", { search: "SEARCHALPHA" });
  assert.ok(unpaid.some((r) => r.id === alpha.scId), "SearchAlpha should match case-insensitively");
  assert.ok(!unpaid.some((r) => r.id === beta.scId), "SearchBeta (paid balance) stays out of the unpaid tab");

  const paid = await credit.utangList(STORE, "paid", { search: "searchbeta" });
  assert.ok(paid.some((r) => r.id === beta.scId));
  assert.ok(!paid.some((r) => r.id === alpha.scId));
});

test("utangList from/to filters by credit entry createdAt (inclusive)", async () => {
  const jan = await makeLedgerCustomer(`${run} RangeJan`, 0, new Date("2026-01-15T10:00:00.000Z"), 100);
  const feb = await makeLedgerCustomer(`${run} RangeFeb`, 900, new Date("2026-02-15T10:00:00.000Z"), 900);
  const mar = await makeLedgerCustomer(`${run} RangeMar`, 800, new Date("2026-03-15T10:00:00.000Z"), 800);
  const paidMar = await makeLedgerCustomer(`${run} RangePaidMar`, 0, new Date("2026-03-16T10:00:00.000Z"), 50);

  const janWindow = { from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-01-31T23:59:59.999Z") };
  const paid = await credit.utangList(STORE, "paid", { search: run, ...janWindow });
  assert.ok(paid.some((r) => r.id === jan.scId), "paid balance + Jan entry → listed");
  assert.ok(!paid.some((r) => r.id === paidMar.scId), "paid balance but entry outside window → excluded");
  assert.ok(!paid.some((r) => r.id === feb.scId), "unpaid balance stays out of paid tab");
  assert.ok(!paid.some((r) => r.id === mar.scId));

  const febWindow = { from: new Date("2026-02-01T00:00:00.000Z"), to: new Date("2026-02-28T23:59:59.999Z") };
  const unpaid = await credit.utangList(STORE, "unpaid", { search: run, ...febWindow });
  assert.ok(unpaid.some((r) => r.id === feb.scId), "unpaid balance + Feb entry → listed");
  assert.ok(!unpaid.some((r) => r.id === mar.scId), "unpaid balance but entry outside window → excluded");
  assert.ok(!unpaid.some((r) => r.id === jan.scId));
  assert.ok(!unpaid.some((r) => r.id === paidMar.scId));

  const singleBound = await credit.utangList(STORE, "unpaid", { search: run, to: new Date("2026-03-01T00:00:00.000Z") });
  assert.ok(singleBound.some((r) => r.id === feb.scId));
  assert.ok(!singleBound.some((r) => r.id === mar.scId));
});

test("customerCredit from/to filters entries (inclusive)", async () => {
  const { scId } = await makeLedgerCustomer(`${run} Ledger`, 250, new Date("2026-04-01T08:00:00.000Z"), 100);
  await prisma.creditEntry.create({
    data: { storeId: STORE, storeCustomerId: scId, type: "purchase", amountMinor: 200, startAt: new Date("2026-05-01T08:00:00.000Z"), createdAt: new Date("2026-05-01T08:00:00.000Z"), note: "v4 test entry" },
  });
  await prisma.creditEntry.create({
    data: { storeId: STORE, storeCustomerId: scId, type: "payment", amountMinor: -50, startAt: new Date("2026-06-01T08:00:00.000Z"), createdAt: new Date("2026-06-01T08:00:00.000Z"), note: "v4 test entry" },
  });

  const may = await credit.customerCredit(STORE, scId, { from: new Date("2026-05-01T00:00:00.000Z"), to: new Date("2026-05-31T23:59:59.999Z") });
  assert.ok(may);
  assert.equal(may.entries.length, 1);
  assert.equal(may.entries[0]!.amountMinor, 200);

  const full = await credit.customerCredit(STORE, scId);
  assert.ok(full);
  assert.equal(full.entries.length, 3);
});
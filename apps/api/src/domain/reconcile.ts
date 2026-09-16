// Reconciliation engine (Module 6/11 fix) — every stored BALANCE must equal the
// sum of its append-only LEDGER. A non-zero drift means a bug or a partial write;
// `--apply` (see scripts/reconcile.ts) rewrites the balance from the ledger, and
// for stock also appends a correction movement so the ledger stays the source of
// truth. Dry-run by default; nothing here runs unless called.
//
// Identities checked:
//   Voucher.usedCount                     == count(VoucherRedemption)
//   StoreCustomer.loyaltyBalancePoints    == sum(LoyaltyEntry.points)
//   StoreCustomer.creditBalanceMinor      == sum(CreditEntry.amountMinor)  (+purchase / -payment)
//   StockLevel.quantityOnHand             == impliedInitial + sum(StockMovement.delta)

import { prisma } from "../persistence/prisma-repositories.js";

export type DriftKind = "voucher" | "loyalty" | "credit" | "stock";

export interface DriftRow {
  kind: DriftKind;
  storeId: string;
  storeSlug: string;
  /** Human-readable reference (voucher code, customer name, product SKU). */
  ref: string;
  /** Row id that `--apply` would correct. */
  targetId: string;
  expected: number;
  actual: number;
  detail: string;
}

export interface ReconcileReport {
  rows: DriftRow[];
  checked: { vouchers: number; loyalty: number; credit: number; stock: number };
}

export interface ReconcileOptions {
  storeId?: string;
}

async function storeSlugs(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const stores = await prisma.store.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true } });
  return new Map(stores.map((s) => [s.id, s.slug]));
}

export async function reconcileVouchers(opts: ReconcileOptions = {}): Promise<DriftRow[]> {
  const vouchers = await prisma.voucher.findMany({
    where: opts.storeId ? { storeId: opts.storeId } : {},
    select: { id: true, storeId: true, code: true, usedCount: true },
  });
  if (vouchers.length === 0) return [];
  const counts = await prisma.voucherRedemption.groupBy({
    by: ["voucherId"],
    _count: { _all: true },
    where: { voucherId: { in: vouchers.map((v) => v.id) } },
  });
  const byVoucher = new Map(counts.map((c) => [c.voucherId, c._count._all]));
  const slugs = await storeSlugs([...new Set(vouchers.map((v) => v.storeId))]);

  const rows: DriftRow[] = [];
  for (const v of vouchers) {
    const expected = byVoucher.get(v.id) ?? 0;
    if (v.usedCount !== expected) {
      rows.push({
        kind: "voucher",
        storeId: v.storeId,
        storeSlug: slugs.get(v.storeId) ?? v.storeId,
        ref: v.code,
        targetId: v.id,
        expected,
        actual: v.usedCount,
        detail: `usedCount=${v.usedCount} but ${expected} redemption row(s) exist`,
      });
    }
  }
  return rows;
}

export async function reconcileLoyalty(opts: ReconcileOptions = {}): Promise<DriftRow[]> {
  const customers = await prisma.storeCustomer.findMany({
    where: opts.storeId ? { storeId: opts.storeId } : {},
    select: { id: true, storeId: true, loyaltyBalancePoints: true, customer: { select: { name: true } } },
  });
  if (customers.length === 0) return [];
  const sums = await prisma.loyaltyEntry.groupBy({
    by: ["storeCustomerId"],
    _sum: { points: true },
    where: { storeCustomerId: { in: customers.map((c) => c.id) } },
  });
  const byCustomer = new Map(sums.map((s) => [s.storeCustomerId, s._sum.points ?? 0]));
  const slugs = await storeSlugs([...new Set(customers.map((c) => c.storeId))]);

  const rows: DriftRow[] = [];
  for (const c of customers) {
    const expected = byCustomer.get(c.id) ?? 0;
    if (c.loyaltyBalancePoints !== expected) {
      rows.push({
        kind: "loyalty",
        storeId: c.storeId,
        storeSlug: slugs.get(c.storeId) ?? c.storeId,
        ref: c.customer?.name ?? c.id,
        targetId: c.id,
        expected,
        actual: c.loyaltyBalancePoints,
        detail: `balance=${c.loyaltyBalancePoints} but ledger sums to ${expected}`,
      });
    }
  }
  return rows;
}

export async function reconcileCredit(opts: ReconcileOptions = {}): Promise<DriftRow[]> {
  const customers = await prisma.storeCustomer.findMany({
    where: opts.storeId ? { storeId: opts.storeId } : {},
    select: { id: true, storeId: true, creditBalanceMinor: true, customer: { select: { name: true } } },
  });
  if (customers.length === 0) return [];
  const sums = await prisma.creditEntry.groupBy({
    by: ["storeCustomerId"],
    _sum: { amountMinor: true },
    where: { storeCustomerId: { in: customers.map((c) => c.id) } },
  });
  const byCustomer = new Map(sums.map((s) => [s.storeCustomerId, s._sum.amountMinor ?? 0]));
  const slugs = await storeSlugs([...new Set(customers.map((c) => c.storeId))]);

  const rows: DriftRow[] = [];
  for (const c of customers) {
    const expected = byCustomer.get(c.id) ?? 0;
    if (c.creditBalanceMinor !== expected) {
      rows.push({
        kind: "credit",
        storeId: c.storeId,
        storeSlug: slugs.get(c.storeId) ?? c.storeId,
        ref: c.customer?.name ?? c.id,
        targetId: c.id,
        expected,
        actual: c.creditBalanceMinor,
        detail: `balance=${c.creditBalanceMinor} but ledger sums to ${expected}`,
      });
    }
  }
  return rows;
}

export async function reconcileStock(opts: ReconcileOptions = {}): Promise<DriftRow[]> {
  const levels = await prisma.stockLevel.findMany({
    where: opts.storeId ? { storeId: opts.storeId } : {},
    include: { product: { select: { sku: true, name: true } } },
  });
  if (levels.length === 0) return [];
  const slugs = await storeSlugs([...new Set(levels.map((l) => l.storeId))]);

  const rows: DriftRow[] = [];
  for (const level of levels) {
    const movements = await prisma.stockMovement.findMany({
      // RESERVE movements move `quantityReserved`, NOT the on-hand balance — including
      // them would report a phantom drift of exactly the reserved quantity.
      where: { storeId: level.storeId, productId: level.productId, warehouseId: level.warehouseId ?? null, type: { not: "RESERVE" } },
      orderBy: { createdAt: "asc" },
    });
    if (movements.length === 0) continue; // no on-hand history — predates the ledger
    const first = movements[0]!;
    const impliedInitial = first.balanceAfter !== null ? first.balanceAfter - first.delta : null;
    if (impliedInitial === null) continue;
    const expected = impliedInitial + movements.reduce((s, m) => s + m.delta, 0);
    if (level.quantityOnHand !== expected) {
      rows.push({
        kind: "stock",
        storeId: level.storeId,
        storeSlug: slugs.get(level.storeId) ?? level.storeId,
        ref: level.product.sku || level.product.name,
        targetId: level.id,
        expected,
        actual: level.quantityOnHand,
        detail: `onHand=${level.quantityOnHand} but the on-hand ledger implies ${expected}`,
      });
    }
  }
  return rows;
}

/** Run every reconciliation check. SEQUENTIAL on purpose: the managed pooler caps
 *  sessions (pool_size 15) and a parallel burst plus the API's own client exceeds it
 *  (EMAXCONNSESSION). The checks are cheap; correctness beats concurrency here. */
export async function reconcileAll(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const vouchers = await reconcileVouchers(opts);
  const loyalty = await reconcileLoyalty(opts);
  const credit = await reconcileCredit(opts);
  const stock = await reconcileStock(opts);
  const where = opts.storeId ? { storeId: opts.storeId } : {};
  const voucherCount = await prisma.voucher.count({ where });
  const customerCount = await prisma.storeCustomer.count({ where });
  const levelCount = await prisma.stockLevel.count({ where });
  return {
    rows: [...vouchers, ...loyalty, ...credit, ...stock],
    checked: { vouchers: voucherCount, loyalty: customerCount, credit: customerCount, stock: levelCount },
  };
}

/**
 * Correct ONE drift row from its ledger (the ledger is authoritative).
 * Stock also appends an ADJUST movement so the correction is auditable; loyalty
 * and credit balances are rewritten in place and logged by the caller.
 */
export async function applyDrift(row: DriftRow, actor = "reconcile"): Promise<void> {
  switch (row.kind) {
    case "voucher":
      await prisma.voucher.update({ where: { id: row.targetId }, data: { usedCount: row.expected } });
      return;
    case "loyalty":
      await prisma.storeCustomer.update({ where: { id: row.targetId }, data: { loyaltyBalancePoints: row.expected } });
      return;
    case "credit":
      await prisma.storeCustomer.update({ where: { id: row.targetId }, data: { creditBalanceMinor: row.expected } });
      return;
    case "stock": {
      const level = await prisma.stockLevel.findUnique({ where: { id: row.targetId } });
      if (!level) return;
      await prisma.$transaction(async (tx) => {
        const updated = await tx.stockLevel.update({ where: { id: level.id }, data: { quantityOnHand: row.expected } });
        // The balance is rewritten TO the ledger, so the correction itself must not
        // move the ledger sum — otherwise the identity we just checked would break
        // again. A zero-delta ADJUST movement records who/when/why in the ledger.
        await tx.stockMovement.create({
          data: {
            storeId: level.storeId,
            productId: level.productId,
            warehouseId: level.warehouseId,
            delta: 0,
            type: "ADJUST",
            orderId: null,
            createdBy: actor,
            note: `reconciliation: onHand ${row.actual} → ${row.expected} (ledger is authoritative)`,
            balanceAfter: updated.quantityOnHand,
          },
        });
      });
      return;
    }
  }
}

/** Adjust loyalty points by writing an ADJUST ledger entry (keeps the ledger authoritative). */
export async function applyLoyaltyAdjustment(input: {
  storeId: string;
  customerId: string;
  storeCustomerId: string;
  points: number;
  description: string;
  actor?: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const changed = await tx.$executeRawUnsafe(
      'UPDATE "StoreCustomer" SET "loyaltyBalancePoints" = "loyaltyBalancePoints" + $2 WHERE "id" = $1 AND "loyaltyBalancePoints" + $2 >= 0',
      input.storeCustomerId,
      input.points,
    );
    if (changed === 0) throw new Error("Loyalty adjustment would drive the balance negative");
    const sc = await tx.storeCustomer.findUnique({ where: { id: input.storeCustomerId }, select: { loyaltyBalancePoints: true } });
    await tx.loyaltyEntry.create({
      data: {
        storeId: input.storeId,
        customerId: input.customerId,
        storeCustomerId: input.storeCustomerId,
        type: "ADJUST",
        points: input.points,
        balanceAfter: sc?.loyaltyBalancePoints ?? 0,
        description: input.description,
      },
    });
  });
}

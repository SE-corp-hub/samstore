// Reconciliation CLI (Module 6/11 fix) — DRY-RUN BY DEFAULT.
//
//   npx tsx scripts/reconcile.ts                 # report drift for every store
//   npx tsx scripts/reconcile.ts --apply         # correct every drifted balance
//   npx tsx scripts/reconcile.ts --store <id>    # limit to one tenant
//
// Checks (see apps/api/src/domain/reconcile.ts):
//   Voucher.usedCount                  == count(VoucherRedemption)
//   StoreCustomer.loyaltyBalancePoints == sum(LoyaltyEntry.points)
//   StoreCustomer.creditBalanceMinor   == sum(CreditEntry.amountMinor)
//   StockLevel.quantityOnHand          == ledger-implied balance
//
// Exit code: 0 when clean, 1 when drift was found (so it can gate a deploy/cron).

import { applyDrift, reconcileAll } from "../apps/api/src/domain/reconcile.js";
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

async function main() {
  const apply = process.argv.includes("--apply");
  const storeIdx = process.argv.indexOf("--store");
  const storeId = storeIdx > -1 ? process.argv[storeIdx + 1] : undefined;

  const report = await reconcileAll(storeId ? { storeId } : {});
  const { checked, rows } = report;

  console.log("Reconciliation" + (storeId ? ` (store ${storeId})` : " (all stores)"));
  console.log(`  checked: ${checked.vouchers} voucher(s) · ${checked.loyalty} customer balance(s) · ${checked.credit} credit balance(s) · ${checked.stock} stock level(s)`);

  if (rows.length === 0) {
    console.log("  result: no drift — every balance equals its ledger");
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log(`  result: ${rows.length} drifted balance(s):`);
  for (const row of rows) {
    console.log(`   - [${row.kind}] ${row.storeSlug} · ${row.ref}: ${row.detail}`);
  }

  if (!apply) {
    console.log("\n  dry-run: nothing was changed. Re-run with --apply to correct from the ledger.");
    await prisma.$disconnect();
    process.exit(1);
  }

  for (const row of rows) {
    await applyDrift(row);
    console.log(`   ✓ corrected [${row.kind}] ${row.storeSlug} · ${row.ref}: ${row.actual} → ${row.expected}`);
  }

  const after = await reconcileAll(storeId ? { storeId } : {});
  console.log(`\n  post-check: ${after.rows.length === 0 ? "clean (0 drift)" : `${after.rows.length} still drifted`}`);
  await prisma.$disconnect();
  process.exit(after.rows.length === 0 ? 0 : 1);
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

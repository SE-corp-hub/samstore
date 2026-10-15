// Ledger rebase — for stock rows whose ledger does not add up to the counted stock,
// TRUST THE COUNT: write one ADJUST movement that brings the ledger to the on-hand
// quantity. The on-hand number itself is never changed. (`npm run reconcile -- --apply`
// does the opposite: it rewrites on-hand to whatever the ledger says.)
//
// When to use: the ledger is known to be wrong, e.g. two rows' histories were merged
// (Rice Ops M1 moved location-less stock onto the default location: the merged history
// is missing the second row's opening balance), or demo/test activity left gaps.
//
//   npm run ledger:rebase -- --store sam-store                (dry run: lists what would change)
//   npm run ledger:rebase -- --store sam-store --sku KAPE-001 --apply

import { PrismaClient } from "@prisma/client";
import { reconcileStock } from "../apps/api/src/domain/reconcile.js";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const slug = arg("--store");
  const sku = arg("--sku");
  const apply = process.argv.includes("--apply");
  if (!slug) {
    console.error("usage: npm run ledger:rebase -- --store <slug> [--sku <SKU>] [--apply]");
    return 2;
  }
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!store) { console.error(`No store "${slug}"`); return 2; }

  const drift = (await reconcileStock({ storeId: store.id })).filter((r) => !sku || r.ref === sku);
  if (drift.length === 0) {
    console.log("No stock drift — nothing to rebase.");
    return 0;
  }
  console.log(`${store.name}: ${drift.length} stock row(s) where the ledger disagrees with the count`);
  for (const r of drift) {
    console.log(`  ${r.ref}: counted ${r.actual}, ledger says ${r.expected} → ADJUST ${r.actual - r.expected} (on-hand stays ${r.actual})`);
  }
  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to write the correction movement(s).");
    return 0;
  }
  for (const r of drift) {
    await prisma.$transaction(async (tx) => {
      const level = await tx.stockLevel.findUniqueOrThrow({ where: { id: r.targetId } });
      await tx.stockMovement.create({
        data: {
          storeId: level.storeId,
          productId: level.productId,
          warehouseId: level.warehouseId,
          delta: level.quantityOnHand - r.expected,
          type: "ADJUST",
          orderId: null,
          createdBy: "ledger-rebase",
          documentType: "LEDGER_REBASE",
          note: `ledger rebased to counted stock: ledger ${r.expected} → counted ${level.quantityOnHand}`,
          balanceAfter: level.quantityOnHand,
        },
      });
      await tx.auditLog.create({
        data: {
          storeId: level.storeId, actorType: "system", actorId: null, action: "stock.ledger.rebase",
          entityType: "StockLevel", entityId: level.id,
          before: { ledgerImplied: r.expected }, after: { quantityOnHand: level.quantityOnHand },
        },
      });
    });
    console.log(`  ✓ ${r.ref}: ledger now ${r.actual}`);
  }
  const after = (await reconcileStock({ storeId: store.id })).filter((r) => !sku || r.ref === sku);
  console.log(`\npost-check: ${after.length === 0 ? "clean (0 drift)" : `${after.length} still drifted`}`);
  return after.length === 0 ? 0 : 1;
}

main()
  .then(async (c) => { await prisma.$disconnect(); process.exit(c); })
  .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });

// Diagnose the live drift reported by scripts/reconcile.ts (read-only).
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

async function main() {
  // 1) Stock: HALO-001 movement history
  const product = await prisma.product.findFirst({ where: { sku: "HALO-001" }, select: { id: true, storeId: true, sku: true, name: true } });
  if (product) {
    const movements = await prisma.stockMovement.findMany({ where: { productId: product.id }, orderBy: { createdAt: "asc" }, select: { type: true, delta: true, balanceAfter: true, createdAt: true, createdBy: true } });
    const level = await prisma.stockLevel.findFirst({ where: { productId: product.id }, select: { quantityOnHand: true, quantityReserved: true } });
    console.log(`stock ${product.sku}: onHand=${level?.quantityOnHand} reserved=${level?.quantityReserved} movements=${movements.length}`);
    console.log("  first:", JSON.stringify(movements[0]));
    console.log("  last :", JSON.stringify(movements[movements.length - 1]));
    const byType: Record<string, number> = {};
    for (const m of movements) byType[m.type] = (byType[m.type] ?? 0) + m.delta;
    console.log("  ledger net by type:", JSON.stringify(byType));
    const orders = await prisma.orderItem.count({ where: { productId: product.id } });
    console.log(`  order lines referencing this product: ${orders} (sales before the ledger existed cannot show as movements)`);
  }

  // 2) Credit: are the drifted customers test/probe customers with deleted ledger rows?
  const drifted = await prisma.storeCustomer.findMany({
    where: { creditBalanceMinor: { gt: 0 } },
    select: { id: true, storeId: true, creditBalanceMinor: true, customerId: true },
    take: 12,
  });
  console.log(`\nstore customers with a credit balance: ${drifted.length}`);
  const customerNames = new Map(
    (await prisma.customer.findMany({ where: { id: { in: drifted.map((c) => c.customerId) } }, select: { id: true, name: true } }))
      .map((c) => [c.id, c.name] as const),
  );
  const entryCounts = await prisma.creditEntry.groupBy({
    by: ["storeCustomerId"],
    _count: { _all: true },
    where: { storeCustomerId: { in: drifted.map((c) => c.id) } },
  });
  const countBySc = new Map(entryCounts.map((e) => [e.storeCustomerId, e._count._all]));
  for (const c of drifted) {
    console.log(`  ${customerNames.get(c.customerId) ?? "?"} · balance=${c.creditBalanceMinor} · creditEntries=${countBySc.get(c.id) ?? 0} · store=${c.storeId.slice(-6)}`);
  }
  const totalEntries = await prisma.creditEntry.count();
  console.log(`creditEntry rows in DB: ${totalEntries}`);
  await prisma.$disconnect();
}

void main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

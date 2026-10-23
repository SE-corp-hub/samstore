// Read-only: lists the shop's locations and the cost setting. Changes nothing.
//   npx tsx scripts/shop-locations.ts --store sam-store
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<number> {
  const i = process.argv.indexOf("--store");
  const slug = i >= 0 ? process.argv[i + 1] : undefined;
  if (!slug) { console.error("usage: npx tsx scripts/shop-locations.ts --store <slug>"); return 2; }
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!store) { console.error(`No store with slug "${slug}".`); return 2; }
  const settings = await prisma.storeSettings.findUnique({ where: { storeId: store.id }, select: { costMode: true } });
  console.log(`Store: ${store.name} (${slug})`);
  console.log(`Cost setting: ${settings?.costMode === "PER_LOCATION" ? "each location has its own cost" : "one cost for all locations"}${settings ? "" : " (no settings row yet: the default applies)"}`);
  const rows = await prisma.warehouse.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } });
  console.log(`\nLocations (${rows.length}):`);
  for (const w of rows) {
    const withStock = await prisma.stockLevel.count({ where: { storeId: store.id, warehouseId: w.id, quantityOnHand: { not: 0 } } });
    const moves = await prisma.stockMovement.count({ where: { storeId: store.id, warehouseId: w.id } });
    const sales = await prisma.order.count({ where: { storeId: store.id, sellingLocationId: w.id } });
    const flags = [w.isDefault ? "main store" : "", w.consignment ? "consignment" : "", w.isActive ? "" : "switched off", w.needsReview ? "needs review" : ""].filter(Boolean).join(", ");
    console.log(`  ${(w.code ?? "-").padEnd(4)} ${w.name.padEnd(18)} ${String(w.type).padEnd(10)} address: ${w.address ? "yes" : "none"}  items with stock: ${withStock}, stock movements: ${moves}, sales: ${sales}${flags ? `  [${flags}]` : ""}`);
  }
  return 0;
}

main()
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });

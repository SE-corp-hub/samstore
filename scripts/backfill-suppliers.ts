// M6 backfill: create Supplier rows from existing Purchase.vendor strings per store.
//
//   npx tsx scripts/backfill-suppliers.ts              # dry-run report
//   npx tsx scripts/backfill-suppliers.ts --apply      # execute
//   npx tsx scripts/backfill-suppliers.ts --store <id> # one tenant
//
// Idempotent: skips vendors that already have a matching Supplier name in the store.
// Sets Purchase.vendorId to the Supplier id for all matched rows.

import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

const apply = process.argv.includes("--apply");
const storeIdx = process.argv.indexOf("--store");
const storeId = storeIdx > -1 ? process.argv[storeIdx + 1] : undefined;

async function main() {
  const stores = await prisma.store.findMany({
    where: storeId ? { id: storeId } : {},
    select: { id: true, slug: true },
  });

  let totalCreated = 0;
  let totalLinked = 0;
  let totalSkipped = 0;

  for (const store of stores) {
    const vendors = await prisma.purchase.findMany({
      where: { storeId: store.id, vendor: { not: null, not: "" } },
      select: { vendor: true },
      distinct: ["vendor"],
    });
    const vendorNames = vendors.map((v) => v.vendor!).filter(Boolean) as string[];

    if (vendorNames.length === 0) continue;

    const existing = await prisma.supplier.findMany({
      where: { storeId: store.id, name: { in: vendorNames } },
      select: { id: true, name: true },
    });
    const existingMap = new Map(existing.map((s) => [s.name, s.id]));

    const toCreate = vendorNames.filter((n) => !existingMap.has(n));
    const created: { name: string; id: string }[] = [];

    if (apply && toCreate.length > 0) {
      for (const name of toCreate) {
        const s = await prisma.supplier.create({ data: { storeId: store.id, name } });
        created.push({ name, id: s.id });
        totalCreated++;
      }
    } else if (!apply && toCreate.length > 0) {
      for (const name of toCreate) {
        created.push({ name, id: "(dry-run)" });
        totalCreated++;
      }
    }

    const allSuppliers = [...existing, ...created];
    const nameToId = new Map(allSuppliers.map((s) => [s.name, s.id]));

    const purchases = await prisma.purchase.findMany({
      where: { storeId: store.id, vendor: { not: null, not: "" }, vendorId: null },
      select: { id: true, vendor: true },
    });

    let linked = 0;
    for (const p of purchases) {
      const sid = p.vendor ? nameToId.get(p.vendor) : null;
      if (sid) {
        if (apply) {
          await prisma.purchase.update({ where: { id: p.id }, data: { vendorId: sid } });
        }
        linked++;
      }
    }

    totalLinked += linked;
    totalSkipped += purchases.length - linked;

    console.log(`Store ${store.slug} (${store.id}): ${vendorNames.length} vendor(s) found, ${created.length} new supplier(s) ${apply ? "created" : "would be created"}, ${linked} purchase(s) ${apply ? "linked" : "would be linked"}, ${purchases.length - linked} purchase(s) skipped (no matching supplier)`);
  }

  console.log(`\nTotal: ${totalCreated} supplier(s) ${apply ? "created" : "would be created"}, ${totalLinked} purchase(s) ${apply ? "linked" : "would be linked"}`);
  if (!apply) console.log("Run with --apply to execute.");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
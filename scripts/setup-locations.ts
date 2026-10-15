// Rice Ops M1 — set up the business's four stock locations: S1, S2, S3 and WH.
//
//   npx tsx scripts/setup-locations.ts --store <slug>            (dry run: prints the plan)
//   npx tsx scripts/setup-locations.ts --store <slug> --apply    (makes the changes)
//   Options: --default-name "Store 1"   rename the current default location
//            --off "<name>"             switch off a location (repeatable; e.g. demo data).
//                                       Its history stays; it takes no new stock.
// More stores and warehouses (S4, WH2, …) are added any time in Admin → Locations.
//
// Idempotent: run it again and it reports "nothing to change".
//   * The store's current default location becomes S1 "Store 1" (keeps its stock;
//     a custom name is kept — only an empty code is filled in).
//   * S2 "Store 2", S3 "Store 3" (STORE) and WH "Warehouse" (WAREHOUSE) are created
//     if no location already uses that code.
//   * Any legacy location-less stock rows and their ledger rows move to S1 together
//     (same rule as the M1 migration), so reconciliation stays at zero drift.
// Names, codes and addresses can be changed afterwards in Locations.

import { PrismaClient, LocationType } from "@prisma/client";

const prisma = new PrismaClient();

const TARGETS: { code: string; name: string; type: LocationType }[] = [
  { code: "S1", name: "Store 1", type: LocationType.STORE },
  { code: "S2", name: "Store 2", type: LocationType.STORE },
  { code: "S3", name: "Store 3", type: LocationType.STORE },
  { code: "WH", name: "Warehouse", type: LocationType.WAREHOUSE },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]!); });
  return out;
}

async function main(): Promise<number> {
  const slug = arg("--store");
  const apply = process.argv.includes("--apply");
  const defaultName = arg("--default-name")?.trim();
  const offNames = args("--off").map((n) => n.trim().toLowerCase());
  if (!slug) {
    console.error("usage: npx tsx scripts/setup-locations.ts --store <slug> [--apply]");
    return 2;
  }
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!store) {
    console.error(`No store with slug "${slug}".`);
    return 2;
  }
  const storeId = store.id;
  const plan: string[] = [];
  const existing = await prisma.warehouse.findMany({ where: { storeId }, orderBy: { createdAt: "asc" } });
  let def = existing.find((w) => w.isDefault) ?? existing[0] ?? null;

  if (!def) plan.push(`create S1 "Store 1" as the default location`);
  else {
    if (!def.isDefault) plan.push(`make "${def.name}" the default location`);
    if (!def.code && !existing.some((w) => w.code === "S1")) plan.push(`give "${def.name}" code S1 (type STORE)`);
    if (defaultName && defaultName !== def.name) plan.push(`rename "${def.name}" → "${defaultName}"`);
  }
  const toSwitchOff = existing.filter((w) => offNames.includes(w.name.toLowerCase()));
  for (const n of offNames) {
    const w = existing.find((x) => x.name.toLowerCase() === n);
    if (!w) { console.error(`No location named "${n}".`); return 2; }
    if (w.id === def?.id) { console.error(`"${w.name}" is the default location and cannot be switched off.`); return 2; }
  }
  for (const w of toSwitchOff) if (w.isActive) plan.push(`switch off "${w.name}" (history kept, no new stock)`);
  for (const t of TARGETS.slice(1)) {
    if (!existing.some((w) => w.code === t.code || w.name === t.name) && !(t.code === "S1")) plan.push(`create ${t.code} "${t.name}" (${t.type})`);
  }
  const nullLevels = await prisma.stockLevel.count({ where: { storeId, warehouseId: null } });
  const nullMoves = await prisma.stockMovement.count({ where: { storeId, warehouseId: null, variantId: null } });
  if (nullLevels || nullMoves) plan.push(`move ${nullLevels} location-less stock row(s) and ${nullMoves} ledger row(s) to the default location`);

  console.log(`Store: ${store.name} (${slug})`);
  if (plan.length === 0) {
    console.log("Nothing to change — S1, S2, S3 and WH are in place.");
    return 0;
  }
  for (const p of plan) console.log(`  • ${p}`);
  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to make these changes.");
    return 0;
  }

  await prisma.$transaction(async (tx) => {
    if (!def) {
      def = await tx.warehouse.create({ data: { storeId, name: "Store 1", code: "S1", type: LocationType.STORE, isDefault: true } });
    } else {
      await tx.warehouse.update({
        where: { id: def.id },
        data: {
          isDefault: true,
          ...(!def.code && !existing.some((w) => w.code === "S1") ? { code: "S1", type: LocationType.STORE } : {}),
          ...(defaultName && defaultName !== def.name ? { name: defaultName } : {}),
        },
      });
    }
    for (const t of TARGETS.slice(1)) {
      if (existing.some((w) => w.code === t.code || w.name === t.name)) continue;
      await tx.warehouse.create({ data: { storeId, name: t.name, code: t.code, type: t.type } });
    }
    for (const w of toSwitchOff) if (w.isActive) await tx.warehouse.update({ where: { id: w.id }, data: { isActive: false } });
    const defaultId = def.id;
    // A location-less row for a product that ALREADY has a row at the default
    // location is merged into it (quantities summed — the ledger counts both);
    // the rest simply move. Same rule as the M1 migration.
    const orphans = await tx.stockLevel.findMany({ where: { storeId, warehouseId: null } });
    for (const o of orphans) {
      const target = await tx.stockLevel.findFirst({ where: { storeId, productId: o.productId, warehouseId: defaultId } });
      if (target) {
        await tx.stockLevel.update({
          where: { id: target.id },
          data: {
            quantityOnHand: { increment: o.quantityOnHand },
            quantityReserved: { increment: o.quantityReserved },
            reorderThreshold: Math.max(target.reorderThreshold, o.reorderThreshold),
          },
        });
        await tx.product.updateMany({ where: { stockLevelId: o.id }, data: { stockLevelId: target.id } });
        await tx.stockLevel.delete({ where: { id: o.id } });
      } else {
        await tx.stockLevel.update({ where: { id: o.id }, data: { warehouseId: defaultId } });
      }
    }
    await tx.stockMovement.updateMany({ where: { storeId, warehouseId: null, variantId: null }, data: { warehouseId: defaultId } });
  });
  console.log("\nApplied. Run `npm run reconcile` to confirm zero drift.");
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });

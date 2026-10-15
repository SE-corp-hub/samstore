// Stock trace — READ-ONLY. Shows one product's stock rows and its full on-hand ledger
// per location, with running totals, so a reconcile drift can be explained before
// anything is corrected.
//
//   npm run stock:trace -- --store sam-store --sku KAPE-001

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RESERVED_ONLY = new Set(["RESERVE", "RELEASE_RESERVATION"]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const slug = arg("--store");
  const sku = arg("--sku");
  if (!slug || !sku) {
    console.error("usage: npm run stock:trace -- --store <slug> --sku <SKU>");
    return 2;
  }
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!store) { console.error(`No store "${slug}"`); return 2; }
  const product = await prisma.product.findFirst({ where: { storeId: store.id, sku }, select: { id: true, name: true, stockLevelId: true } });
  if (!product) { console.error(`No product ${sku} in ${slug}`); return 2; }

  const locations = await prisma.warehouse.findMany({ where: { storeId: store.id }, select: { id: true, name: true, code: true, isDefault: true } });
  const locName = (id: string | null) => {
    if (!id) return "(no location)";
    const l = locations.find((x) => x.id === id);
    return l ? `${l.code ?? ""} ${l.name}${l.isDefault ? " [default]" : ""}`.trim() : id;
  };

  console.log(`${store.name} · ${sku} ${product.name}`);
  const levels = await prisma.stockLevel.findMany({ where: { storeId: store.id, productId: product.id } });
  console.log("\nStock rows:");
  for (const l of levels) {
    console.log(`  ${locName(l.warehouseId)}: onHand ${l.quantityOnHand}, reserved ${l.quantityReserved}${product.stockLevelId === l.id ? "  (product's main row)" : ""}`);
  }

  const moves = await prisma.stockMovement.findMany({
    where: { storeId: store.id, productId: product.id, variantId: null },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, warehouseId: true, type: true, delta: true, balanceAfter: true, documentType: true, note: true },
  });
  const byLoc = new Map<string, typeof moves>();
  for (const m of moves) {
    const k = m.warehouseId ?? "";
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k)!.push(m);
  }
  for (const [k, list] of byLoc) {
    console.log(`\nLedger at ${locName(k || null)} (${list.length} rows):`);
    let running: number | null = null;
    for (const m of list) {
      const counts = !RESERVED_ONLY.has(m.type);
      if (running === null && counts && m.balanceAfter !== null) running = m.balanceAfter - m.delta;
      if (counts && running !== null) running += m.delta;
      const gap = counts && m.balanceAfter !== null && running !== null && m.balanceAfter !== running ? `  ← recorded balance ${m.balanceAfter} ≠ running ${running}` : "";
      console.log(
        `  ${m.createdAt.toISOString().slice(0, 16).replace("T", " ")}  ${m.type.padEnd(20)} ${String(m.delta).padStart(6)}  bal ${String(m.balanceAfter ?? "-").padStart(5)}  ${m.documentType ?? ""} ${(m.note ?? "").slice(0, 50)}${gap}`,
      );
    }
    console.log(`  → ledger implies ${running ?? "?"}`);
  }
  return 0;
}

main()
  .then(async (c) => { await prisma.$disconnect(); process.exit(c); })
  .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });

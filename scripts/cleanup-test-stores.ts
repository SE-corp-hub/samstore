// Test-store sweeper — DRY-RUN BY DEFAULT.
//
// Every E2E/unit run creates throwaway stores. A run that ABORTS leaves them behind
// (no `after()` hook runs), so the platform store list — which a PLATFORM_ADMIN browses
// via GET /admin/stores — fills with fixture tenants.
//
//   npx tsx scripts/cleanup-test-stores.ts           # list what would be deleted
//   npx tsx scripts/cleanup-test-stores.ts --apply   # delete it
//
// Safety: stores in KEEP_SLUGS are never touched, whatever else matches. The table set
// is discovered from the live foreign-key graph rather than hand-listed, so a schema
// change can never silently leave a child table behind. Deletion is per-table and
// resumable: re-running after a failure simply continues.

import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

/** Real tenants. Never deleted, regardless of anything else. */
const KEEP_SLUGS = ["sam-store"];

type Row = { n: number };

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Store-owned tables, ordered so a child is always deleted before its parent. */
async function deleteOrder(): Promise<string[]> {
  const storeIdTables = new Set(
    (await prisma.$queryRawUnsafe<Array<{ table: string }>>(
      `SELECT table_name AS table FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'storeId'`,
    )).map((r) => r.table),
  );
  const edges = await prisma.$queryRawUnsafe<Array<{ child: string; parent: string }>>(
    `SELECT replace(c.conrelid::regclass::text, '"', '') AS child,
            replace(c.confrelid::regclass::text, '"', '') AS parent
     FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  );
  // Product.stockLevelId is a NULLABLE back-reference to StockLevel while StockLevel
  // references Product — a genuine foreign-key cycle that no delete order can satisfy.
  // `breakCycles` clears the nullable side first, so this edge no longer constrains order.
  const BROKEN_BY_NULLING = new Set(["Product->StockLevel"]);
  const childEdges = edges.filter(
    (e) => storeIdTables.has(e.child) && storeIdTables.has(e.parent) && !BROKEN_BY_NULLING.has(`${e.child}->${e.parent}`),
  );

  const ordered: string[] = [];
  const remaining = new Set(storeIdTables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => !childEdges.some((e) => e.parent === t && remaining.has(e.child)));
    if (ready.length === 0) {
      const stuck = [...remaining];
      console.error(`FK cycle among: ${stuck.join(", ")} — aborting.`);
      for (const e of childEdges) {
        if (stuck.includes(e.child) && stuck.includes(e.parent)) console.error(`  ${e.child} -> ${e.parent}`);
      }
      throw new Error("unresolvable FK cycle");
    }
    for (const t of ready) {
      ordered.push(t);
      remaining.delete(t);
    }
  }
  return ordered;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const ordered = await deleteOrder();

  const stores = await prisma.store.findMany({ select: { id: true, slug: true, name: true } });
  const keep = stores.filter((s) => KEEP_SLUGS.includes(s.slug));
  const junk = stores.filter((s) => !KEEP_SLUGS.includes(s.slug));

  console.log(`Stores: ${stores.length} total, ${keep.length} protected, ${junk.length} test fixtures.`);
  for (const s of keep) console.log(`  KEEP  ${s.slug}  (${s.name})`);

  if (junk.length > 0 && !apply) {
    console.log("\nDry-run: nothing deleted. Re-run with --apply to remove the test stores.");
    await prisma.$disconnect();
    return;
  }

  if (junk.length > 0 && apply) {
    const ids = junk.map((s) => s.id);
    const nulled = await prisma.$executeRawUnsafe(
      `UPDATE "Product" SET "stockLevelId" = NULL
       WHERE "storeId" = ANY($1::text[]) AND "stockLevelId" IS NOT NULL`,
      ids,
    );
    if (nulled > 0) console.log(`Broke the Product↔StockLevel cycle on ${nulled} row(s).`);

    let removed = 0;
    for (const table of ordered) {
      const res = await prisma.$executeRawUnsafe(`DELETE FROM ${quote(table)} WHERE "storeId" = ANY($1::text[])`, ids);
      if (res > 0) {
        removed += res;
        console.log(`  ${table}: ${res}`);
      }
    }
    const deletedStores = await prisma.store.deleteMany({ where: { id: { in: ids } } });
    console.log(`\nDeleted ${deletedStores.count} test store(s) and ${removed} dependent row(s).`);
  } else if (junk.length === 0) {
    console.log("No test stores to remove.");
  }

  if (apply) {
    // Rows whose store is already gone — junk left by earlier hand-listed sweeps that
    // missed a table. They reference nothing, so there is nothing to preserve.
    for (const table of ordered) {
      const res = await prisma.$executeRawUnsafe(
        `DELETE FROM ${quote(table)} x WHERE NOT EXISTS (SELECT 1 FROM "Store" s WHERE s.id = x."storeId")`,
      );
      if (res > 0) console.log(`  orphan ${table}: ${res}`);
    }
  }

  // Nothing may survive pointing at a store that no longer exists.
  const orphans: string[] = [];
  for (const table of ordered) {
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT count(*)::int AS n FROM ${quote(table)} x
       WHERE NOT EXISTS (SELECT 1 FROM "Store" s WHERE s.id = x."storeId")`,
    );
    if ((rows[0]?.n ?? 0) > 0) orphans.push(`${table}=${rows[0]?.n}`);
  }
  console.log(orphans.length === 0 ? "Orphan check: clean (no row points at a deleted store)." : `ORPHANS ${orphans.join(", ")}`);
  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
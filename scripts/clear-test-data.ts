// Soft launch, step "clear the test data": removes a store's test sales, orders, money and stock,
// and keeps its locations, products, prices, customers, people and settings.
//
//   npx tsx scripts/clear-test-data.ts --store test-bigasan            # only shows what it would remove
//   npx tsx scripts/clear-test-data.ts --store test-bigasan --apply    # asks for CLEAR, saves a copy, removes
//
// On the PC: double-click clear-test-data.bat (it reads go-live\beta-database-url.txt).
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";
import { clearStoreActivity, exportStoreActivity } from "../apps/api/src/admin/clear-store-activity.js";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

/** Plain names for the tables the owner will recognise; the rest are counted as "other records". */
const PLAIN: Record<string, string> = {
  Order: "orders and sales", Payment: "payments", StockMovement: "stock changes", StockLevel: "stock amounts",
  StockIn: "stock-ins", StockTransfer: "stock moves", StockCount: "stock counts", StockWriteOff: "damaged or lost stock",
  ResackJob: "resacks", Expense: "expenses", CashMovement: "cash drawer records", CreditEntry: "utang records",
  DailyClose: "closings", StorePayableEntry: "store payable records",
};

async function main() {
  const slug = arg("--store");
  if (!slug) throw new Error("Say which store: --store test-bigasan");
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } });
  if (!store) throw new Error(`No store with the code ${slug} in this database.`);
  console.log(`Store: ${store.name} (${store.slug})\n`);

  const report = await clearStoreActivity(store.id);
  const other = Object.entries(report.rows).filter(([t]) => !PLAIN[t]).reduce((a, [, n]) => a + n, 0);
  for (const [t, label] of Object.entries(PLAIN)) console.log(`  ${String(report.rows[t] ?? 0).padStart(6)}  ${label}`);
  console.log(`  ${String(other).padStart(6)}  other records that belong to these (order lines, history, receipts...)`);
  console.log(`  ${String(report.total).padStart(6)}  TOTAL test records\n`);
  console.log("Kept as they are: locations, rice and prices, customers, logins and staff, settings.");

  if (!process.argv.includes("--apply")) { console.log("\nNothing was removed (preview only)."); return; }
  if (report.total === 0) { console.log("\nThere is nothing to remove."); return; }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\nType CLEAR and press Enter to remove these test records (or just press Enter to stop): ")).trim();
  rl.close();
  if (answer !== "CLEAR") { console.log("Stopped. Nothing was removed."); return; }

  // A safety copy of everything that is about to go, on this PC only.
  mkdirSync("go-live", { recursive: true });
  const file = `go-live/cleared-test-data-${store.slug}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`;
  const copy = await exportStoreActivity(store.id);
  writeFileSync(file, JSON.stringify({ store, savedAt: new Date().toISOString(), rows: copy }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  console.log(`Safety copy saved: ${file}`);

  const done = await clearStoreActivity(store.id, { apply: true });
  const after = await clearStoreActivity(store.id);
  console.log(`Removed ${done.total} test records. Left now: ${after.total}.`);
  console.log("Next: count your real stock in on the tablet (Stock, Count).");
}

main()
  .catch((e) => { console.error("\n" + (e?.message ?? e)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

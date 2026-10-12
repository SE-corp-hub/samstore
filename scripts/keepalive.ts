// Supabase keep-alive — ONE real Postgres query.
//
// Supabase pauses a Free Plan project after 7 days with too little *database*
// activity. Their docs say "a few user requests to the database each day" clears
// the threshold, and the pause scanner measures Postgres — not HTTP. Pinging
// /auth/v1/health or any non-DB endpoint does NOT count, so this deliberately
// runs SQL instead.
//
//   npx tsx scripts/keepalive.ts          # locally, reads .env
//   DATABASE_URL=… npx tsx scripts/keepalive.ts
//
// Exits non-zero on failure so a scheduled run shows red rather than pretending.

import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("KEEPALIVE DATABASE_URL is not set — cannot generate database activity.");
  process.exit(1);
}

// A single connection: this runs once a day and must not hold pooler sessions.
const prisma = new PrismaClient({
  datasources: { db: { url: `${url}${url.includes("?") ? "&" : "?"}connection_limit=1&connect_timeout=30` } },
});

async function main() {
  const started = Date.now();
  const [ping] = await prisma.$queryRawUnsafe<Array<{ n: number }>>("SELECT 1 AS n");
  // A read of a real table, so the activity is indistinguishable from a user's.
  const [rows] = await prisma.$queryRawUnsafe<Array<{ n: number }>>('SELECT count(*)::int AS n FROM "Store"');
  console.log(`KEEPALIVE ok in ${Date.now() - started}ms — ping=${ping?.n} stores=${rows?.n}`);
}

main()
  .catch((e) => {
    const msg = e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 200) : String(e);
    console.error(`KEEPALIVE failed :: ${msg}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
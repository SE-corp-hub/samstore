// Database doctor — shows what is holding the database up before a migration, and
// the state of the Rice Ops migrations. Read-only unless --stop-stuck is given.
//
//   npm run db:doctor                 (look only)
//   npm run db:doctor -- --stop-stuck (also end leftover pg_dump sessions and
//                                      sessions stuck "idle in transaction" > 5 min)
//
// Never prints the connection string. Only this database's sessions are shown.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const stopStuck = process.argv.includes("--stop-stuck");

type Session = { pid: number; app: string | null; state: string | null; xact_age_s: number | null; wait: string | null; query: string | null };
type Mig = { migration_name: string; started_at: Date; finished_at: Date | null; rolled_back_at: Date | null };

async function main(): Promise<number> {
  const timeout = await prisma.$queryRaw<{ statement_timeout: string; lock_timeout: string }[]>`
    SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`;
  console.log(`statement_timeout = ${timeout[0]?.statement_timeout} · lock_timeout = ${timeout[0]?.lock_timeout}\n`);

  const sessions = await prisma.$queryRaw<Session[]>`
    SELECT pid, application_name AS app, state,
           EXTRACT(EPOCH FROM now() - xact_start)::int AS xact_age_s,
           wait_event_type || ':' || wait_event AS wait,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 70) AS query
      FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
     ORDER BY xact_start NULLS LAST`;
  console.log(`Other sessions on this database: ${sessions.length}`);
  for (const s of sessions) {
    const age = s.xact_age_s === null ? "no open transaction" : `transaction open ${s.xact_age_s}s`;
    console.log(`  pid ${s.pid} · ${s.app || "(no name)"} · ${s.state} · ${age}${s.wait ? ` · waiting ${s.wait}` : ""}\n      ${s.query ?? ""}`);
  }

  const stuck = sessions.filter((s) => s.app === "pg_dump" || (s.state === "idle in transaction" && (s.xact_age_s ?? 0) > 300));
  if (stuck.length) {
    console.log(`\n${stuck.length} session(s) can block a migration: ${stuck.map((s) => `pid ${s.pid} (${s.app || s.state})`).join(", ")}`);
    if (stopStuck) {
      for (const s of stuck) {
        const r = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT pg_terminate_backend(${s.pid}::int) AS ok`;
        console.log(`  ended pid ${s.pid}: ${r[0]?.ok ? "yes" : "no (not allowed or already gone)"}`);
      }
    } else {
      console.log("  Run `npm run db:doctor -- --stop-stuck` to end them.");
    }
  } else {
    console.log("\nNothing is blocking a migration.");
  }

  const migs = await prisma.$queryRaw<Mig[]>`
    SELECT migration_name, started_at, finished_at, rolled_back_at
      FROM _prisma_migrations WHERE migration_name LIKE '%rice_ops%' ORDER BY started_at`;
  console.log("\nRice Ops migrations recorded:");
  for (const m of migs) {
    const st = m.finished_at ? "applied" : m.rolled_back_at ? "marked rolled back" : "FAILED (needs resolve)";
    console.log(`  ${m.migration_name}: ${st}`);
  }
  const m2Tables = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('Kargador', 'Signature', 'ApprovalRequest', 'FlowDraft')`;
  const m2Cols = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'User' AND column_name IN ('pinHash', 'tokenVersion')`;
  console.log(`  M2 objects present in the database: ${m2Tables[0]?.n ?? 0}/4 tables, ${m2Cols[0]?.n ?? 0}/2 User columns`);
  const failedM2 = migs.find((m) => m.migration_name.endsWith("rice_ops_m2_people") && !m.finished_at && !m.rolled_back_at);
  if (failedM2 && (m2Tables[0]?.n ?? 0) === 0 && (m2Cols[0]?.n ?? 0) === 0) {
    console.log("\nThe failed M2 migration left nothing behind (it ran as one transaction). Safe next step:");
    console.log("  npx prisma migrate resolve --rolled-back 20261014090000_rice_ops_m2_people");
    console.log("  npx prisma migrate deploy");
  } else if (failedM2) {
    console.log("\nThe failed M2 migration left PART of its changes. Stop here and send this output.");
  }
  return 0;
}

main()
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<DATABASE_URL>") : e);
    await prisma.$disconnect();
    process.exit(1);
  });

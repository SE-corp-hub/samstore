#!/usr/bin/env node
// One-command verification for the Rice Ops modules — run it, then tell Claude "done".
//
//   npm run verify                (or double-click verify.bat)
//
// Steps, in the safe order, stopping at the first failure:
//   1. prisma migrate status — are there database changes waiting?
//   2. if yes: db:backup (must say BACKUP OK) → db:doctor --stop-stuck → migrate deploy
//   3. db:generate, typecheck
//   4. the Rice Ops tests (pure + live-DB), one file at a time
// (verify-beta.bat runs the same steps on the BETA database only: no backup, log in verify-logs/latest-beta.txt.)
// Everything is printed AND written to verify-logs/latest.txt (plus a dated copy), so
// Claude can read the result from this folder. The scripts it runs never print the
// database password (backup/doctor mask it; Prisma prints the host only).

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** verify-beta.bat: the same full check, but on the BETA database only (no backup, no stopping sessions). Only scripts/verify-beta.mjs may start this, because it proves the address is not the shop's. */
const BETA = process.argv.includes("--beta");
if (BETA && process.env.VERIFY_TARGET !== "beta") {
  console.error("Run verify-beta.bat for the beta database. This script will not take the beta database address from anywhere else.");
  process.exit(2);
}
if (BETA && !process.env.DATABASE_URL) {
  console.error("No beta database address was passed in. Run verify-beta.bat.");
  process.exit(2);
}
const TAG = BETA ? " (BETA DATABASE)" : "";
const logDir = join(root, "verify-logs");
mkdirSync(logDir, { recursive: true });
const latest = join(logDir, BETA ? "latest-beta.txt" : "latest.txt"); // the beta run never overwrites the shop's log
const log = createWriteStream(latest, { flags: "w" });
const started = new Date();

const out = (line) => {
  process.stdout.write(line);
  log.write(line);
};
const stamp = () => new Date().toISOString().slice(11, 19);
/** verify-quick.bat: typecheck + the tests that never touch the database (about 1 minute). Run the full verify before a push that changes stock, money or the database. */
const QUICK = process.argv.includes("--quick");

/** Rice Ops test files, in order. Missing files (later modules) are skipped. */
const TEST_FILES = [
  "apps/api/src/domain/weight.test.ts",
  "apps/api/src/domain/stock-location.test.ts",
  "apps/api/src/domain/people.test.ts",
  "apps/api/src/domain/transfer-flow.test.ts",
  "apps/api/src/domain/resack.test.ts",
  "apps/api/src/domain/selling.test.ts",
  "apps/api/src/domain/utang.test.ts",
  "apps/api/src/domain/agent-order.test.ts",
  "apps/api/src/domain/counting.test.ts",
  "apps/api/src/domain/count-reasons.test.ts",
  "apps/api/src/domain/count-resack.test.ts",
  "apps/api/src/domain/count-looks.test.ts",
  "apps/api/src/domain/reports.test.ts",
  "apps/api/src/domain/rice-import.test.ts",
  "apps/web/src/lib/riceTheme.test.ts",
  "apps/api/src/inventory/ledger-m1.test.ts",
  "apps/api/src/people/people-m2.test.ts",
  "apps/api/src/transfers/transfers-m3.test.ts",
  "apps/api/src/resack/resack-m4.test.ts",
  "apps/api/src/selling/benta-m5.test.ts",
  "apps/api/src/utang/utang-m6.test.ts",
  "apps/api/src/agent/agent-orders-m7.test.ts",
  "apps/api/src/counts/counts-m8.test.ts",
  "apps/api/src/reports/reports-m9.test.ts",
  "apps/api/src/security/idempotency-m10.test.ts",
  "apps/web/src/lib/toast.test.ts",
  "apps/web/src/lib/retryable.test.ts",
  "apps/web/src/lib/number-format.test.ts",
  "apps/web/src/lib/text-message.test.ts",
  "apps/web/src/lib/slip-print.test.ts",
  "apps/web/src/lib/printer-settings.test.ts",
  "apps/web/src/lib/bt-print.test.ts",
  "apps/web/src/lib/count-view.test.ts",
  "apps/api/src/domain/stock-book.test.ts",
  "apps/api/src/domain/price-history.test.ts",
  "apps/api/src/domain/shelf-cost.test.ts",
  "apps/api/src/domain/stock-tracking.test.ts",
  "apps/api/src/security/security-m11.test.ts",
  "apps/api/src/imports/imports-m12.test.ts",
  "apps/api/src/auth/auth.service.test.ts",
  "apps/api/src/auth/store-access-users.test.ts",
  "apps/api/src/admin/platform-users.test.ts",
  "apps/api/src/admin/team.service.test.ts",
  "apps/api/src/pos/pos.service.test.ts",
];

function run(label, cmd) {
  return new Promise((done) => {
    out(`\n[${stamp()}] ▶ ${label}\n$ ${cmd}\n`);
    const child = spawn(cmd, { cwd: root, shell: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", TX_TIMEOUT_MS: process.env.TX_TIMEOUT_MS ?? "120000" } /* slow link to the cloud DB: let long steps finish (see persistence/tx-options.ts) */ });
    let text = "";
    const take = (b) => {
      const s = b.toString();
      text += s;
      out(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => {
      out(`[${stamp()}] ◀ ${label}: exit ${code}\n`);
      done({ code: code ?? 1, text });
    });
  });
}

async function main() {
  out(`VERIFY started ${started.toISOString()} in ${root}${TAG}\n`);
  if (BETA) out("BETA MODE: every database step below runs on the BETA database. The shop's database is not touched, and no backup is taken.\n");
  const results = [];
  const fail = (step) => {
    out(`\nVERIFY RESULT: FAIL at "${step}"${TAG}\n`);
    results.push(`${step}: FAIL`);
    return 1;
  };

  if (QUICK) out("QUICK MODE: checks the types and the tests that do not use the database. The slow database tests are skipped.\n");
  const status = QUICK ? { text: "Database schema is up to date" } : await run("migration status", "npx prisma migrate status");
  const pending = !/Database schema is up to date/i.test(status.text);
  results.push(`migrations pending: ${pending ? "yes" : "no"}`);

  if (pending) {
    if (!BETA) {
      const backup = await run("backup (required before any database change)", "npm run db:backup");
      if (backup.code !== 0 || !/BACKUP OK/.test(backup.text)) return fail("backup");
      results.push("backup: OK");
      const doctor = await run("database doctor", "npm run db:doctor -- --stop-stuck");
      if (doctor.code !== 0) return fail("db:doctor");
    }
    const deploy = await run(BETA ? "apply migrations (beta database)" : "apply migrations", "npx prisma migrate deploy");
    if (deploy.code !== 0) return fail("migrate deploy");
    results.push("migrate deploy: OK");
  }

  const gen = await run("generate Prisma client", "npm run db:generate");
  if (gen.code !== 0) {
    if (QUICK) out("NOTE: Prisma client not refreshed (the running app locks it). Quick mode goes on with the existing one.\n");
    else return fail("db:generate");
  }
  const tc = await run("typecheck", "npm run typecheck");
  if (tc.code !== 0) return fail("typecheck");
  results.push("typecheck: OK");

  let failed = 0;
  for (const f of TEST_FILES) {
    if (!existsSync(join(root, f))) continue;
    if (QUICK && !(f.includes("/domain/") || f.startsWith("apps/web/"))) continue;
    let r = await run(`test ${f}`, `npx tsx --test ${f}`);
    // A dropped connection to the database is retried once; a real failure is not hidden.
    if (r.code !== 0 && /closed the connection|Can't reach database|ECONNRESET|EOF detected/i.test(r.text)) {
      out("  (connection dropped — running this file once more)\n");
      r = await run(`test ${f} (retry)`, `npx tsx --test ${f}`);
    }
    const pass = r.text.match(/(?:ℹ|#) pass (\d+)/)?.[1] ?? "?";
    const fails = r.text.match(/(?:ℹ|#) fail (\d+)/)?.[1] ?? "?";
    results.push(`${f}: pass ${pass}, fail ${fails}${r.code === 0 ? "" : "  ← FAILED"}`);
    if (r.code !== 0) failed++;
  }

  out(`\n──────── SUMMARY (${Math.round((Date.now() - started.getTime()) / 1000)} s) ────────\n${results.join("\n")}\n`);
  out(failed ? `\nVERIFY RESULT: FAIL (${failed} test file(s))${TAG}\n` : QUICK ? "\nVERIFY RESULT: PASS (QUICK: types and database-free tests only; run verify.bat before pushing database or money changes)\n" : `\nVERIFY RESULT: PASS — ready to commit${TAG}\n`);
  return failed ? 1 : 0;
}

main().then((code) => {
  log.end(() => {
    const dated = join(logDir, `verify-${BETA ? "beta-" : ""}${started.toISOString().slice(0, 16).replace(/[-:T]/g, "")}.txt`);
    try { copyFileSync(latest, dated); } catch { /* the latest copy is enough */ }
    // keep the folder small: the 10 newest dated logs
    try {
      for (const re of [/^verify-\d+\.txt$/, /^verify-beta-\d+\.txt$/]) {
        const old = readdirSync(logDir).filter((n) => re.test(n)).sort().slice(0, -10);
        for (const n of old) unlinkSync(join(logDir, n));
      }
    } catch { /* ignore */ }
    process.exit(code);
  });
});

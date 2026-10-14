#!/usr/bin/env node
// M0 — one-command database backup (pg_dump custom format) + restore check.
//
//   npm run db:backup
//
// Reads DATABASE_URL from .env (or the environment), never prints it, writes
// backups/samstore-YYYYMMDD-HHMM.dump (gitignored), then proves the file is a
// readable archive with `pg_restore --list` and reports what it contains.
// Exit code 0 = backup written AND verified; anything else = no usable backup.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);

const root = resolve(dirname(here), "..");

function loadDotEnv() {
  if (process.env.DATABASE_URL) return;
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** Anything that might contain the connection string is masked before printing. */
function redact(text, url) {
  let out = String(text ?? "");
  if (url) out = out.split(url).join("<DATABASE_URL>");
  return out.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1****@");
}

/**
 * pg_dump needs a session-level connection. Supabase's transaction pooler
 * (port 6543, ?pgbouncer=true) can break it, so switch to the session pooler
 * on the same host (port 5432) and drop pooler-only parameters.
 */
export function dumpableUrl(raw) {
  const u = new URL(raw);
  const notes = [];
  if (u.port === "6543") {
    u.port = "5432";
    notes.push("switched the pooler port 6543 → 5432 (session mode) for pg_dump");
  }
  for (const p of ["pgbouncer", "connection_limit", "pool_timeout", "statement_cache_size"]) {
    if (u.searchParams.has(p)) {
      u.searchParams.delete(p);
      notes.push(`dropped the pooler-only parameter "${p}"`);
    }
  }
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  return { url: u.toString(), notes };
}

function tool(name) {
  const r = spawnSync(name, ["--version"], { encoding: "utf8", shell: false });
  return r.status === 0 ? r.stdout.trim() : null;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function main() {
  loadDotEnv();
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("BACKUP FAILED: DATABASE_URL is not set (looked in the environment and in .env).");
    return 2;
  }

  const pgDump = tool("pg_dump");
  const pgRestore = tool("pg_restore");
  if (!pgDump || !pgRestore) {
    console.error(
      [
        "BACKUP FAILED: pg_dump / pg_restore are not installed on this computer.",
        "Install the PostgreSQL command-line tools (version 17 or newer), then run this again:",
        "  winget install --id PostgreSQL.PostgreSQL.17 -e",
        "  (or the EDB installer from postgresql.org — tick only \"Command Line Tools\")",
        "Then open a NEW terminal so the tools are on PATH.",
      ].join("\n"),
    );
    return 3;
  }

  let target;
  try {
    target = dumpableUrl(raw);
  } catch {
    console.error("BACKUP FAILED: DATABASE_URL is not a valid postgres:// URL.");
    return 2;
  }
  for (const n of target.notes) console.log(`note: ${n}`);

  const dir = join(root, "backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `samstore-${stamp()}.dump`);

  console.log(`${pgDump} → ${file}`);
  const dump = spawnSync(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges", "--file", file, "--dbname", target.url],
    { encoding: "utf8", shell: false },
  );
  if (dump.status !== 0) {
    const msg = redact(dump.stderr || dump.stdout, target.url);
    console.error(`BACKUP FAILED: pg_dump exited with ${dump.status}.\n${msg}`);
    if (/server version/i.test(msg)) {
      console.error("Your pg_dump is older than the database server. Install a newer PostgreSQL client (see above).");
    }
    return 4;
  }

  const list = spawnSync("pg_restore", ["--list", file], { encoding: "utf8", shell: false });
  if (list.status !== 0) {
    console.error(`BACKUP FAILED: the file was written but pg_restore cannot read it.\n${redact(list.stderr, target.url)}`);
    return 5;
  }
  const entries = list.stdout.split(/\r?\n/).filter((l) => /^\d+;/.test(l));
  const tables = entries.filter((l) => / TABLE DATA /.test(l)).length;
  const sizeMb = (statSync(file).size / 1024 / 1024).toFixed(2);
  if (tables === 0) {
    console.error(`BACKUP FAILED: the archive has no table data (${entries.length} entries).`);
    return 6;
  }
  console.log(`BACKUP OK: ${file}`);
  console.log(`  size ${sizeMb} MB · ${entries.length} archive entries · ${tables} tables with data`);
  console.log("  Keep a copy off this computer (Google Drive / USB). The backups/ folder is gitignored.");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(here)) {
  process.exit(main());
}

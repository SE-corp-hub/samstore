#!/usr/bin/env node
// M0 — one-command database backup (pg_dump custom format) + restore check.
//
//   npm run db:backup
//
// Reads DATABASE_URL from .env (or the environment), never prints it, writes
// backups/samstore-YYYYMMDD-HHMM.dump (gitignored), then proves the file is a
// readable archive with `pg_restore --list` and reports what it contains.
// Exit code 0 = backup written AND verified; anything else = no usable backup.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
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
  // Fail in seconds instead of hanging when the host is unreachable (e.g. an IPv6-only host on IPv4).
  if (!u.searchParams.has("connect_timeout")) u.searchParams.set("connect_timeout", "20");
  // pg_dump's first catalog queries can run for minutes with no bytes on the wire; home
  // routers and mobile networks drop such "silent" connections ("SSL SYSCALL error: EOF
  // detected"). TCP keepalives every 10–30 s keep the connection open.
  const keep = { keepalives: "1", keepalives_idle: "30", keepalives_interval: "10", keepalives_count: "6" };
  for (const [k, v] of Object.entries(keep)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return { url: u.toString(), notes, where: `${u.hostname}:${u.port || "5432"}` };
}

/**
 * Find a PostgreSQL client tool: on PATH first, then (Windows) the installer's
 * default folders, newest version first — so a fresh install works without
 * editing PATH or opening a new terminal.
 */
function tool(name) {
  const candidates = [name];
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      const pg = join(base, "PostgreSQL");
      if (!existsSync(pg)) continue;
      const versions = readdirSync(pg).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
      for (const v of versions) candidates.push(join(pg, v, "bin", `${name}.exe`));
    }
  }
  for (const c of candidates) {
    if (c !== name && !existsSync(c)) continue;
    const r = spawnSync(c, ["--version"], { encoding: "utf8", shell: false });
    if (r.status === 0) return { path: c, version: r.stdout.trim() };
  }
  return null;
}

/**
 * Run a tool and show its progress (stderr) live, every line passed through
 * redact() so the connection string can never be printed. Returns the exit code
 * and the last lines for diagnosis.
 */
function runStreaming(cmd, args, url) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let buf = "";
    const tail = [];
    let tables = 0;
    const emit = (line) => {
      if (!line.trim()) return;
      const safe = redact(line, url);
      tail.push(safe);
      if (tail.length > 20) tail.shift();
      // Print errors in full; for routine progress, only table-data lines (one per table).
      if (/error|fatal|failed|could not|timeout/i.test(safe)) console.error(`  ${safe}`);
      else if (/dumping contents of table/i.test(safe)) console.log(`${tables === 0 ? "\n" : ""}  [${++tables}] ${safe.replace(/^pg_dump:\s*/, "")}`);
      else if (/reading|last built-in|saving|identifying/i.test(safe) && tables === 0) process.stdout.write(".");
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      lines.forEach(emit);
    });
    child.on("error", (e) => resolveRun({ status: 1, tail: String(e.message) }));
    child.on("close", (code) => {
      emit(buf);
      process.stdout.write("\n");
      resolveRun({ status: code ?? 1, tail: tail.join("\n") });
    });
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
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
        "  Windows: https://www.enterprisedb.com/downloads/postgres-postgresql-downloads",
        "           → PostgreSQL 17, Windows x86-64 → in the installer tick ONLY \"Command Line Tools\".",
        "           (or, where available: winget install --id PostgreSQL.PostgreSQL.17 -e)",
        "  This script finds C:\\Program Files\\PostgreSQL\\<version>\\bin by itself.",
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

  console.log(`${pgDump.version} → ${file}`);
  console.log(`connecting to ${target.where} (password hidden) — progress is shown below; a few minutes is normal.`);
  const started = Date.now();
  const MAX_TRIES = 3;
  let dump;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    if (attempt > 1) console.log(`\nThe connection dropped. Trying again (${attempt} of ${MAX_TRIES})…`);
    dump = await runStreaming(
      pgDump.path,
      ["--format=custom", "--no-owner", "--no-privileges", "--verbose", "--lock-wait-timeout=120s", "--file", file, "--dbname", target.url],
      target.url,
    );
    if (dump.status === 0) break;
    if (!/SSL SYSCALL|EOF detected|server closed the connection|connection.*(reset|lost)|could not receive data/i.test(dump.tail)) break;
  }
  if (dump.status !== 0) {
    const msg = dump.tail;
    try { if (existsSync(file) && statSync(file).size === 0) unlinkSync(file); } catch { /* leave it */ }
    console.error(`BACKUP FAILED: pg_dump exited with ${dump.status} after ${Math.round((Date.now() - started) / 1000)} s.`);
    if (/server version/i.test(msg)) {
      console.error("Your pg_dump is older than the database server. Install a newer PostgreSQL client (see above).");
    }
    if (/timeout expired|could not connect|Network is unreachable|could not translate host/i.test(msg)) {
      console.error(`Could not reach ${target.where}. If this is Supabase's direct host (db.<ref>.supabase.co), it is IPv6-only:`);
      console.error("use the Session pooler connection string from Supabase → Connect (host …pooler.supabase.com, port 5432).");
    }
    if (/SSL SYSCALL|EOF detected|server closed the connection/i.test(msg)) {
      console.error("The connection kept dropping. Try a steadier internet connection (wired/Wi-Fi instead of mobile data), then run again.");
    }
    if (/lock/i.test(msg)) console.error("Another session is holding a table lock. Stop the dev server and try again.");
    return 4;
  }
  console.log(`pg_dump finished in ${Math.round((Date.now() - started) / 1000)} s.`);

  const list = spawnSync(pgRestore.path, ["--list", file], { encoding: "utf8", shell: false });
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
  main().then((code) => process.exit(code), (e) => {
    console.error(`BACKUP FAILED: ${redact(e?.message ?? e)}`);
    process.exit(1);
  });
}

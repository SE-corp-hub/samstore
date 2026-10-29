#!/usr/bin/env node
// Nightly backup job (free): runs the normal backup, keeps a short history, writes a plain log,
// copies the file to a second place if one is set, and warns if it failed.
//
//   node scripts/backup-nightly.mjs           run a backup now (this is what Task Scheduler runs)
//   node scripts/backup-nightly.mjs --status  show the last backups and say if one is overdue
//
// Never prints or logs the database address: the real work is done by scripts/backup-db.mjs,
// which hides it. Files: backups/backup-log.txt (history), backups/BACKUP-FAILED.txt (only while
// the last run failed). Second place: go-live/backup-copy-folder.txt (one line, a folder path;
// git ignores it) or the BACKUP_COPY_DIR setting.

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_NAME, backupTime, pickToDelete } from "./backup-keep.mjs";

const here = fileURLToPath(import.meta.url);
const root = resolve(dirname(here), "..");
const dir = join(root, "backups");
const logFile = join(dir, "backup-log.txt");
const failedFile = join(dir, "BACKUP-FAILED.txt");
const OVERDUE_HOURS = 36;
const RETRY_AFTER_MS = 5 * 60 * 1000;

const p2 = (n) => String(n).padStart(2, "0");
const nowText = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

function log(line) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(logFile, `${nowText()}  ${line}\n`);
  // keep the log short: last 300 lines
  try {
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > 300) writeFileSync(logFile, `${lines.slice(-300).join("\n")}\n`);
  } catch { /* the log is a convenience */ }
}

function copyFolder() {
  const fromEnv = process.env.BACKUP_COPY_DIR?.trim();
  if (fromEnv) return fromEnv;
  const f = join(root, "go-live", "backup-copy-folder.txt");
  if (!existsSync(f)) return null;
  const line = readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return line ? line.replace(/^["']|["']$/g, "") : null;
}

function prune(folder) {
  const names = readdirSync(folder);
  const gone = pickToDelete(names);
  for (const n of gone) {
    try { unlinkSync(join(folder, n)); } catch { /* in use or already gone: leave it */ }
  }
  return gone.length;
}

function warn(message) {
  // A small message box on Windows so someone sees it; nothing else is interrupted. --quiet turns it off.
  if (process.platform !== "win32" || process.argv.includes("--quiet")) return;
  const text = message.replace(/'/g, "");
  spawnSync("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('${text}','Samstore backup')`], { stdio: "ignore" });
}

function sizeMb(file) {
  return (statSync(file).size / 1024 / 1024).toFixed(1);
}

function runBackupOnce() {
  const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const r = spawnSync(process.execPath, [join(root, "scripts", "backup-db.mjs")], { encoding: "utf8", cwd: root });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const file = out.match(/^BACKUP OK: (.+)$/m)?.[1]?.trim() ?? null;
  const ok = r.status === 0 && file && existsSync(file);
  if (!ok) {
    // a half-written or unreadable file must never be mistaken for a good backup later
    for (const n of existsSync(dir) ? readdirSync(dir) : []) {
      if (BACKUP_NAME.test(n) && !before.has(n)) { try { unlinkSync(join(dir, n)); } catch { /* leave it */ } }
    }
  }
  return { code: r.status ?? 1, out, file: ok ? file : null };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function status() {
  if (!existsSync(dir)) {
    console.log("No backups yet. Run setup-nightly-backup.bat (or backup-now.bat) first.");
    return 1;
  }
  const files = readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort().reverse();
  console.log(`Backups kept here (${dir}): ${files.length}`);
  for (const n of files.slice(0, 5)) console.log(`  ${backupTime(n)}   ${sizeMb(join(dir, n))} MB   ${n}`);
  const target = copyFolder();
  console.log(target ? `Second copy goes to: ${target}` : "Second copy: not set (add a folder in go-live\\backup-copy-folder.txt; Google Drive or a USB stick).");
  if (existsSync(logFile)) {
    console.log("\nLast log lines:");
    for (const l of readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean).slice(-8)) console.log(`  ${l}`);
  }
  if (existsSync(failedFile)) console.log("\nThe LAST RUN FAILED. See backups\\BACKUP-FAILED.txt.");
  const newest = files[0];
  if (!newest) { console.log("\nNo backup file yet."); return 1; }
  const age = (Date.now() - statSync(join(dir, newest)).mtimeMs) / 3_600_000;
  if (age > OVERDUE_HOURS) {
    console.log(`\nWARNING: the newest backup is ${Math.round(age)} hours old. The job may not be running (is the PC on at the set time?).`);
    return 1;
  }
  console.log(`\nOK: the newest backup is ${Math.round(age)} hour(s) old.`);
  return existsSync(failedFile) ? 1 : 0;
}

// The shop database may differ from the one in .env (e.g. the shop on Neon while .env is the dev
// database): go-live/backup-database-url.txt (one line, git ignores it) then wins over .env.
function useBackupDatabase() {
  const f = join(root, "go-live", "backup-database-url.txt");
  if (!existsSync(f)) return;
  const line = readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!line) return;
  let url = line.replace(/^["']|["']$/g, "");
  if (!/sslmode=/i.test(url)) url += (url.includes("?") ? "&" : "?") + "sslmode=require";
  process.env.DATABASE_URL = url;
}

function main() {
  if (process.argv.includes("--status")) return status();
  mkdirSync(dir, { recursive: true });
  useBackupDatabase();

  let run = runBackupOnce();
  if (!run.file) {
    log(`first try failed (exit ${run.code}); trying again in 5 minutes`);
    sleep(RETRY_AFTER_MS);
    run = runBackupOnce();
  }

  if (!run.file) {
    const tail = run.out.split(/\r?\n/).filter(Boolean).slice(-12).join("\n"); // backup-db.mjs already hides the address
    writeFileSync(failedFile, `The nightly backup failed at ${nowText()}.\n\n${tail}\n\nFix the problem, then run backup-now.bat. No backup was made this time.\n`);
    log(`FAILED (exit ${run.code}) - see BACKUP-FAILED.txt`);
    warn("The nightly backup FAILED. No new backup was made. Open the extraricestore folder, backups, BACKUP-FAILED.txt.");
    console.error(tail);
    return run.code || 1;
  }

  if (existsSync(failedFile)) unlinkSync(failedFile);
  let copyNote = "second copy: not set";
  const target = copyFolder();
  if (target) {
    try {
      mkdirSync(target, { recursive: true });
      const name = run.file.split(/[\\/]/).pop();
      copyFileSync(run.file, join(target, name));
      const removed = prune(target);
      copyNote = `second copy OK (${target})${removed ? `, ${removed} old removed there` : ""}`;
    } catch (e) {
      copyNote = `second copy FAILED (${e?.code ?? "error"}) at ${target}`;
      warn("The backup was made, but the SECOND COPY failed (Google Drive folder or USB not available). The backup is still on this PC.");
    }
  }
  const removedHere = prune(dir);
  log(`OK ${run.file.split(/[\\/]/).pop()} ${sizeMb(run.file)} MB; ${copyNote}${removedHere ? `; ${removedHere} old removed here` : ""}`);
  console.log(`Nightly backup done: ${run.file}\n${copyNote}`);
  return 0;
}

process.exit(main());

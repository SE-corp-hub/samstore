// Runs scripts/clear-test-data.ts against the beta database. Reads the address from
// go-live/beta-database-url.txt (or asks for it), never saves it anywhere else, and deletes the file after.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const FILE = "go-live/beta-database-url.txt";
const STORE = "test-bigasan";
const clean = (s) => (s ?? "").trim().replace(/^psql\s+/i, "").replace(/^["']|["']$/g, "").trim();

async function main() {
  let url = "";
  if (existsSync(FILE)) {
    url = clean(readFileSync(FILE, "utf8").replace(/^﻿/, "").split(/\r?\n/)[0]);
    console.log(`Using the address saved in ${FILE}`);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    url = clean(await rl.question("Paste the beta database address and press Enter: "));
    rl.close();
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error("That does not look like a database address. It should start with postgresql://");
  if (!/sslmode=/i.test(url)) url += (url.includes("?") ? "&" : "?") + "sslmode=require";
  const env = { ...process.env, DATABASE_URL: url };
  try {
    const r = spawnSync(`npx tsx scripts/clear-test-data.ts --store ${STORE} --apply`, { shell: true, stdio: "inherit", env });
    if (r.status !== 0) throw new Error("It stopped with a problem. Tell Claude what it says above.");
  } finally {
    if (existsSync(FILE)) { unlinkSync(FILE); console.log("\nThe saved address file was deleted."); }
  }
}

main().catch((e) => { console.error("\n" + (e?.message ?? e)); process.exitCode = 1; });

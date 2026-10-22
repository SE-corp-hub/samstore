#!/usr/bin/env node
// Runs the full check (migrations, types, every database test) on the BETA database ONLY,
// so the shop's own database is never touched.  Start it with verify-beta.bat.
//
// The beta address comes from go-live/beta-verify-url.txt (one line), or you paste it when
// asked. It is only ever handed to the check in memory: it is never printed, never copied
// into .env, and never saved anywhere else.  The shop's .env is not changed.
//
// Guards, before anything runs:
//   - the address must look like a database address and must not still say [YOUR-PASSWORD]
//   - it must not point at the same database as the shop's .env (same project, host, user or database name)
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const FILE = "go-live/beta-verify-url.txt";
const clean = (s) => (s ?? "").trim().replace(/^["']|["']$/g, "").trim();

function parts(url) {
  try {
    const u = new URL(url.replace(/^postgres(ql)?:/i, "http:"));
    const user = decodeURIComponent(u.username);
    const ref = user.includes(".") ? user.split(".").pop() : ""; // Supabase pooler user is postgres.<project ref>
    const direct = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(u.hostname)?.[1] ?? ""; // direct host carries the ref too
    return { user, host: u.hostname.toLowerCase(), db: u.pathname.replace(/^\//, ""), ref: (ref || direct).toLowerCase() };
  } catch {
    return null;
  }
}

async function main() {
  let url = "";
  if (existsSync(FILE)) {
    url = clean(readFileSync(FILE, "utf8").split(/\r?\n/)[0]);
    console.log(`Using the beta address saved in ${FILE}`);
  } else {
    console.log("This check runs on the BETA database only. The shop's database is not touched.");
    console.log(`Cannot paste here? Right-click inside this window. Or save the address as one line in ${FILE} and run this again.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    url = clean(await rl.question("Paste the BETA database address and press Enter: "));
    rl.close();
  }
  if (!url) throw new Error("No address given.");
  if (/YOUR-PASSWORD/i.test(url)) throw new Error("The address still says [YOUR-PASSWORD]. Put the beta database password there (no brackets).");
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error("That does not look like a database address. It should start with postgresql://");
  const beta = parts(url);
  if (!beta || !beta.host) throw new Error("Could not read that address. Copy it again from Supabase (Connect, Session pooler, port 5432).");

  // Refuse the shop's database, however it is spelled.
  if (existsSync(".env")) {
    const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    const shopUrl = clean(line?.slice(line.indexOf("=") + 1));
    const shop = shopUrl ? parts(shopUrl) : null;
    if (shopUrl && (shopUrl === url || (shop && ((shop.ref && shop.ref === beta.ref) || (shop.host === beta.host && shop.db === beta.db && shop.user === beta.user))))) {
      throw new Error("STOP: that is the same database as the shop's .env. This check must use the BETA project's address. Nothing was run.");
    }
  } else {
    console.log("(No .env found here, so the address could not be compared with the shop's. Make sure this is the BETA project.)");
  }
  if (!/sslmode=/i.test(url)) url += (url.includes("?") ? "&" : "?") + "sslmode=require";

  console.log(`\nBeta database host: ${beta.host}  (database: ${beta.db || "?"})`);
  console.log("Starting the full check on the beta database. This takes a while.\n");
  const r = spawnSync(process.execPath, ["scripts/verify.mjs", "--beta"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, VERIFY_TARGET: "beta", TEST_LOGINS_FILE: "beta-test-logins.txt" },
  });
  process.exitCode = r.status ?? 1;
}

main().catch((e) => { console.error("\n" + (e?.message ?? e)); process.exitCode = 1; });

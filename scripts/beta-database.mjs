// Sets up the SEPARATE beta database: creates the tables, then the TEST Bigasan sample store.
// Reads the address from go-live/beta-database-url.txt, or asks for it. Never saves it anywhere else.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const FILE = "go-live/beta-database-url.txt";
const clean = (s) => (s ?? "").trim().replace(/^["']|["']$/g, "").trim();

function refOf(url) {
  const m = /^postgres(?:ql)?:\/\/([^:@/]+)/i.exec(url);
  return m ? m[1] : "";
}

async function main() {
  let url = "";
  if (existsSync(FILE)) {
    url = clean(readFileSync(FILE, "utf8").split(/\r?\n/)[0]);
    console.log(`Using the address saved in ${FILE}`);
  } else {
    console.log(`Cannot paste here? Right-click inside this window. Or save the address as one line in ${FILE} and run this again.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    url = clean(await rl.question("Paste the beta database address and press Enter: "));
    rl.close();
  }
  if (!url) throw new Error("No address given.");
  if (url.includes("[YOUR-PASSWORD]") || url.includes("YOUR-PASSWORD")) throw new Error("The address still says [YOUR-PASSWORD]. Put your real database password there (no brackets).");
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error("That does not look like a database address. It should start with postgresql://");

  // Never touch the database the test app already uses.
  if (existsSync(".env")) {
    const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
    const current = clean(line?.slice("DATABASE_URL=".length));
    if (current && (current === url || (refOf(current) && refOf(current) === refOf(url)))) {
      throw new Error("STOP: that is the same Supabase project your test app uses now. Use the NEW beta project's address.");
    }
  }
  if (!/sslmode=/i.test(url)) url += (url.includes("?") ? "&" : "?") + "sslmode=require";

  const env = { ...process.env, DATABASE_URL: url, TEST_LOGINS_FILE: "beta-test-logins.txt" };
  const step = (label, cmd) => {
    console.log(`\n${label}`);
    const r = spawnSync(cmd, { shell: true, stdio: "inherit", env });
    if (r.status !== 0) throw new Error(`Failed at: ${label}. Tell Claude what it says above.`);
  };
  step("Step 1 of 2: creating the tables...", "npx prisma migrate deploy");
  step("Step 2 of 2: adding the TEST Bigasan sample store...", "npx tsx scripts/test-setup.ts");
  if (existsSync(FILE)) unlinkSync(FILE);
  console.log("\nBeta database is ready. Sample-store logins: go-live\\beta-test-logins.txt (keep it private).");
  console.log("The saved address file was deleted. Tell Claude: beta database ready");
}

main().catch((e) => { console.error("\n" + (e?.message ?? e)); process.exitCode = 1; });

// Rice Ops M12 — go-live import for one store.
//
//   npm run rice:import -- --store <slug>                 dry run: checks every row, shows what would change
//   npm run rice:import -- --store <slug> --apply         writes it, then makes the sign-off sheet
//   npm run rice:import -- --store <slug> --signoff       only (re)makes the sign-off sheet
//   Options: --dir <folder>   where the CSV files are (default: go-live)
//
// The folder holds any of products.csv, customers.csv, staff.csv, kargadors.csv —
// copy the examples from docs/rice-ops/import-templates/ and fill them in. go-live/
// is ignored by git: it holds customers' numbers, utang and staff PINs.
//
// Nothing is written when any row has a problem (each one is listed with its row
// number). Safe to run again: unchanged rows are left alone; opening utang is written once.
// New staff get a one-time password, saved to go-live/staff-logins-<date>.txt — hand
// them out, then delete that file.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";
import { RiceImportService, type ImportFiles, type ImportPlan } from "../apps/api/src/imports/rice-import.service.js";
import { peso, signoffHtml } from "../apps/api/src/domain/rice-import.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const manilaNow = () => new Date(Date.now() + 8 * 3600_000).toISOString();
const today = () => manilaNow().slice(0, 10);

function show(plan: ImportPlan) {
  const c = (label: string, x: { create: number; update: number; same: number }) =>
    console.log(`  ${label.padEnd(10)} new ${x.create}, changed ${x.update}, same ${x.same}`);
  c("products", plan.products);
  console.log(`  ${"".padEnd(10)} ${plan.locationPrices} per-location price(s)`);
  c("customers", plan.customers);
  console.log(`  ${"".padEnd(10)} opening credit to add: ${peso(plan.openingUtangMinor)}`);
  c("staff", plan.staff);
  c("kargadors", plan.kargadors);
  for (const n of plan.notes) console.log(`  note: ${n}`);
  if (plan.errors.length) {
    console.log(`\n${plan.errors.length} problem(s) — nothing will be written until they are fixed:`);
    for (const e of plan.errors) console.log(`  ${e.file}${e.row ? ` row ${e.row}` : ""}: ${e.message}`);
  }
}

async function main(): Promise<number> {
  const slug = arg("--store");
  const dir = resolve(arg("--dir") ?? "go-live");
  const apply = process.argv.includes("--apply");
  const signoffOnly = process.argv.includes("--signoff");
  if (!slug) {
    console.error("usage: npm run rice:import -- --store <slug> [--dir go-live] [--apply | --signoff]");
    return 2;
  }
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!store) {
    console.error(`No store with slug "${slug}".`);
    return 2;
  }
  const owner = await prisma.userStore.findFirst({ where: { storeId: store.id, role: "OWNER", status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { userId: true } });
  if (!owner) {
    console.error("This store has no active owner — the import is recorded under the owner's name.");
    return 2;
  }
  const svc = new RiceImportService();
  const sheet = async () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `pirmahan-${today()}.html`);
    writeFileSync(file, signoffHtml(await svc.signoff(store.id, manilaNow().slice(0, 16).replace("T", " "))));
    console.log(`\nSign-off sheet: ${file}\nPrint it, check every line, and sign. Fix any mistake in the CSV and run the import again.`);
  };
  if (signoffOnly) {
    await sheet();
    return 0;
  }

  const files: ImportFiles = {};
  for (const name of ["products", "customers", "staff", "kargadors"] as const) {
    const f = join(dir, `${name}.csv`);
    if (existsSync(f)) files[name] = readFileSync(f, "utf8");
  }
  const found = Object.keys(files);
  if (!found.length) {
    console.error(`No CSV files in ${dir}. Copy the examples from docs/rice-ops/import-templates/.`);
    return 2;
  }
  console.log(`Store: ${store.name} (${slug})\nFiles: ${found.map((f) => `${f}.csv`).join(", ")}\n`);

  if (!apply) {
    const plan = await svc.plan(store.id, files, today());
    show(plan);
    console.log(plan.errors.length ? "" : "\nDry run only. Add --apply to write it.");
    return plan.errors.length ? 1 : 0;
  }

  const res = await svc.apply(store.id, owner.userId, files, today());
  show(res.plan);
  if (!res.ok) return 1;
  console.log("\nImported.");
  if (res.logins.length) {
    const f = join(dir, `staff-logins-${today()}.txt`);
    writeFileSync(f, [
      "One-time logins for new staff. Give each person theirs privately; they choose a new",
      "password on first login. DELETE THIS FILE when done.", "",
      ...res.logins.map((l) => `${l.name}\t${l.phone}\t${l.tempPassword}`), "",
    ].join("\n"), { mode: 0o600 });
    console.log(`${res.logins.length} new staff login(s) saved to ${f} — hand them out, then delete the file.`);
  }
  await sheet();
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

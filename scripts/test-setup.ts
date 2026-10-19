// A separate TEST store for hands-on testing (never touches a real store).
//
//   npx tsx scripts/test-setup.ts          (or double-click test-setup.bat)
//
// Creates — or refreshes — the store "TEST Bigasan" (slug test-bigasan) with S1, S2, S3
// and WH, rice products, a staff member, a sales agent and a kargador, using the M12
// import so that path is exercised too. Test logins (new random passwords every run)
// are written to go-live/test-logins.txt, which git ignores. Delete the store's data
// any time with: npx tsx scripts/cleanup-test-stores.ts (or ask Claude).

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import bcrypt from "bcryptjs";
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";
import { StoreAdminService } from "../apps/api/src/admin/store-admin.service.js";
import { RiceImportService } from "../apps/api/src/imports/rice-import.service.js";
import { pinProblem } from "../apps/api/src/domain/people.js";

const SLUG = "test-bigasan";
const OWNER_EMAIL = "test-owner@bigasan.test";
const OWNER_PHONE = "09990001000";
const STAFF_PHONE = "09990001001";
const AGENT_PHONE = "09990001002";

async function main() {
  let store = await prisma.store.findUnique({ where: { slug: SLUG }, select: { id: true } });
  if (!store) {
    const r = await new StoreAdminService().create({ name: "TEST Bigasan", slug: SLUG, ownerEmail: OWNER_EMAIL, ownerPhone: OWNER_PHONE });
    if (!r.ok) throw new Error(`Could not create the test store: ${JSON.stringify(r.error)}`);
    store = { id: r.value.id };
    console.log("Created store TEST Bigasan");
  } else console.log("TEST Bigasan already exists — refreshing it");
  const storeId = store.id;

  const owner = await prisma.userStore.findFirstOrThrow({ where: { storeId, role: "OWNER" }, select: { userId: true } });
  const ownerPassword = `Test-${randomBytes(6).toString("base64url")}`;
  await prisma.user.update({
    where: { id: owner.userId },
    data: { passwordHash: await bcrypt.hash(ownerPassword, 12), mustChangePassword: false, loginFailedCount: 0, loginLockedUntil: null, name: "Test Owner" },
  });

  for (const [code, name, type] of [["S2", "Store 2", "STORE"], ["S3", "Store 3", "STORE"], ["WH", "Warehouse", "WAREHOUSE"]] as const) {
    const has = await prisma.warehouse.findFirst({ where: { storeId, code } });
    if (!has) await prisma.warehouse.create({ data: { storeId, code, name, type } });
  }

  const newPin = (not?: string) => {
    for (;;) {
      const p = String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0");
      if (!pinProblem(p) && p !== not) return p;
    }
  };
  const staffPin = newPin();
  const agentPin = newPin(staffPin);

  const files = {
    products: [
      "sku,name,variety,sold_as,kg_per_sack,cost,price,price_S2,price_WH",
      'TEST-SIN25,Sinandomeng 25 kg,Sinandomeng,SACK,25,"1,180","1,300","1,320","1,250"',
      "TEST-SIN5,Sinandomeng 5 kg,Sinandomeng,SACK,5,240,275,,",
      "TEST-SINK,Sinandomeng (tingi),Sinandomeng,KILO,,48,54,55,",
      'TEST-DIN25,Dinorado 25 kg,Dinorado,SACK,25,"1,450","1,600",,',
    ].join("\n"),
    staff: [
      "name,phone,role,home,pin",
      `Test Staff Lorna,${STAFF_PHONE},STAFF,S2,${staffPin}`,
      `Test Agent Mike,${AGENT_PHONE},SALES_AGENT,S1,${agentPin}`,
    ].join("\n"),
    kargadors: "name,phone,home,photo_url\nTest Kargador Boy,,WH,",
  };
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const res = await new RiceImportService().apply(storeId, owner.userId, files, today);
  if (!res.ok) throw new Error(`Import refused:\n${res.plan.errors.map((e) => `  ${e.file} row ${e.row}: ${e.message}`).join("\n")}`);

  // PINs are the staff's daily login; their one-time passwords are not needed for testing.
  for (const [phone, p] of [[STAFF_PHONE, staffPin], [AGENT_PHONE, agentPin]] as const) {
    await prisma.user.update({ where: { phone: `+63${phone.slice(1)}` }, data: { pinHash: await bcrypt.hash(p, 10), pinFailedCount: 0, pinLockedUntil: null, mustChangePassword: false } });
  }

  const dir = resolve("go-live");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, process.env.TEST_LOGINS_FILE ?? "test-logins.txt");
  writeFileSync(file, [
    "TEST store logins (test only — not real accounts). New passwords on every run of test-setup.",
    `Store: TEST Bigasan (${SLUG})`,
    `Owner:  ${OWNER_EMAIL}  password ${ownerPassword}`,
    `Staff (S2) PIN login: ${STAFF_PHONE}  PIN ${staffPin}`,
    `Sales agent PIN login: ${AGENT_PHONE}  PIN ${agentPin}`,
    "",
  ].join("\n"), { mode: 0o600 });
  console.log(`\nDone. Logins saved to ${file}`);
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

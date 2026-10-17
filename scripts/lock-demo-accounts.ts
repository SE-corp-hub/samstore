// Locks the demo accounts that prisma/seed.ts created (…@samstore.test) on THIS database.
// Their passwords were printed in the seed and shown on the old login page, so anyone could
// sign in as a store owner or platform admin. This gives each one a new random password,
// removes any PIN, clears login locks and signs it out everywhere (tokenVersion + 1).
// Nothing is deleted; the new passwords go to go-live/demo-logins.txt (git ignores it).
//
//   npx tsx scripts/lock-demo-accounts.ts          (or double-click lock-demo-accounts.bat)

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import bcrypt from "bcryptjs";
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

async function main() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: "@samstore.test" } },
    select: { id: true, email: true, role: true, memberships: { select: { role: true, store: { select: { slug: true } } } } },
    orderBy: { email: "asc" },
  });
  if (users.length === 0) {
    console.log("No @samstore.test accounts on this database — nothing to lock.");
    return;
  }
  const lines = [
    "Demo accounts (…@samstore.test) — locked by scripts/lock-demo-accounts.ts.",
    "These are the ONLY copies of the new passwords. Keep this file private; delete it when not needed.",
    "",
  ];
  for (const u of users) {
    const password = `Demo-${randomBytes(9).toString("base64url")}`;
    await prisma.user.update({
      where: { id: u.id },
      data: {
        passwordHash: await bcrypt.hash(password, 12), pinHash: null, mustChangePassword: false,
        loginFailedCount: 0, loginLockedUntil: null, pinFailedCount: 0, pinLockedUntil: null,
        tokenVersion: { increment: 1 },
      },
    });
    const where = u.memberships.map((m) => `${m.role} @ ${m.store.slug}`).join(", ") || u.role;
    lines.push(`${u.email}  password ${password}   (${where})`);
    console.log(`Locked ${u.email} (${where})`);
  }
  const dir = resolve("go-live");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "demo-logins.txt");
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`\nDone: ${users.length} account(s). Old passwords no longer work. New ones saved to ${file}`);
}

main()
  .then(() => { process.exitCode = 0; })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

// The owner renames themselves and chooses their own sign-in email in Settings → My account.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { AuthService } from "./auth.service.js";
import { PrismaAuthRepository } from "./auth.repository.js";

const CONFIG = { jwtSecret: "test-secret-0123456789", jwtExpiresIn: "1h" };
const svc = new AuthService(new PrismaAuthRepository(), CONFIG);
const run = `prof${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ids: string[] = [];
after(async () => { await prisma.user.deleteMany({ where: { id: { in: ids } } }); await prisma.$disconnect(); });

const aUser = async (tag: string) => {
  const u = await prisma.user.create({ data: { email: `${run}-${tag}@x.test`, passwordHash: "x", name: "Old name", role: "STORE_OWNER" } });
  ids.push(u.id);
  return u;
};

test("the owner changes only the name, and the sign-in email stays", async () => {
  const u = await aUser("a");
  const r = await svc.updateProfile({ userId: u.id, email: null, name: "  Bogs and   Lucy " });
  assert.ok(r.ok);
  const now = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
  assert.deepEqual([now.name, now.email], ["Bogs and Lucy", u.email]);
});

test("a sign-in email with no dot is fine, a taken one is refused, a broken one is refused", async () => {
  const u = await aUser("b");
  const other = await aUser("c");
  const ok = await svc.updateProfile({ userId: u.id, email: `${run}-Owner@Store`, name: "Bogs and Lucy" });
  assert.ok(ok.ok);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email, `${run}-owner@store`);
  const taken = await svc.updateProfile({ userId: u.id, email: other.email!.toUpperCase(), name: "Bogs and Lucy" });
  assert.equal(taken.ok, false);
  const broken = await svc.updateProfile({ userId: u.id, email: "two words@store", name: "Bogs and Lucy" });
  assert.equal(broken.ok, false);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email, `${run}-owner@store`, "nothing changed on a refusal");
});

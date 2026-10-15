// Rice Ops M11 — the security bundle. Each fix has a test here (the toast one is in
// apps/web/src/lib/toast.test.ts):
//  1. no committed JWT / claim-link secret: production refuses a missing or placeholder
//     secret; development makes a random one per run;
//  2. CORS: only listed web addresses may call the API from a browser;
//  3. login lockout: 5 wrong passwords lock password login for 15 minutes, held in the DB;
//  4. invites: store A cannot rewrite, reset or take over an account another store uses;
//  5. public owner sign-up is closed;
//  6. order numbers are unique per store, not across all stores.
import "reflect-metadata";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import { prisma } from "../persistence/prisma-repositories.js";
import { claimSecret, corsOriginCheck, corsOrigins, jwtSecret, SecretConfigError, secretFrom, weakSecretReason } from "./secrets.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertOwnerSignupOpen, ownerSignupOpen } from "../auth/signup-gate.js";
import { AuthService } from "../auth/auth.service.js";
import { PrismaAuthRepository, LOGIN_MAX_FAILS } from "../auth/auth.repository.js";
import { hashPassword } from "../auth/auth.domain.js";
import { storeOwnsAccount } from "../auth/account-scope.js";
import { TeamService } from "../admin/team.service.js";
import { PeopleService } from "../people/people.service.js";

const CONFIG = { jwtSecret: "m11-test-secret-not-real-0123456789abcdef", jwtExpiresIn: "1h" };
const run = `M11R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.passwordResetHistory.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

let phoneSeq = Math.floor(Math.random() * 9_000);
function nextPhone() {
  phoneSeq += 1;
  return `+63918${String(Date.now() % 10_000).padStart(4, "0")}${String(phoneSeq % 1_000).padStart(3, "0")}`;
}

async function store(label: string) {
  seq += 1;
  const s = await prisma.store.create({ data: { slug: `${run}-${label}-${seq}`.toLowerCase(), name: `M11 ${label}` } });
  storeIds.push(s.id);
  return s;
}

async function person(name: string, role: string, password = "x") {
  const u = await prisma.user.create({
    data: { phone: nextPhone(), email: `${run}-${++seq}@m11.test`.toLowerCase(), passwordHash: password === "x" ? "x" : await hashPassword(password), name, role },
  });
  userIds.push(u.id);
  return u;
}

async function member(userId: string, storeId: string, role: "OWNER" | "MANAGER" | "STAFF") {
  await prisma.userStore.create({ data: { userId, storeId, role } });
}

// ── 1. secrets ───────────────────────────────────────────────────────────────

test("M11 secrets: production refuses a missing, short or placeholder secret", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  assert.throws(() => secretFrom("JWT_SECRET", prod), SecretConfigError);
  assert.throws(() => secretFrom("JWT_SECRET", { ...prod, JWT_SECRET: "short" }), /32 characters/);
  assert.throws(() => secretFrom("JWT_SECRET", { ...prod, JWT_SECRET: "dev-jwt-secret-change-me-0123456789" }), /placeholder/);
  assert.throws(() => secretFrom("CLAIM_SIGNING_SECRET", { ...prod, CLAIM_SIGNING_SECRET: "replace-with-32-plus-random-chars" }), /placeholder/);
  const good = "k9Qz2mX7vR4pL8sT1wY6bN3cF5hJ0aDe";
  assert.equal(weakSecretReason(good), null);
  assert.equal(secretFrom("JWT_SECRET", { ...prod, JWT_SECRET: good }), good);
});

test("M11 secrets: development without a secret gets a random one — never the old committed value", () => {
  const dev = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
  const a = jwtSecret(dev);
  assert.equal(a, jwtSecret(dev), "stable for the whole run");
  assert.ok(a.length >= 64);
  assert.ok(!a.includes("dev-"), "not the committed placeholder");
  assert.notEqual(claimSecret(dev), a, "each secret is its own");
  assert.equal(jwtSecret({ ...dev, JWT_SECRET: "my-own-dev-value" }), "my-own-dev-value", "a configured secret is used as is");
});

// ── 2. CORS ──────────────────────────────────────────────────────────────────

function allowed(list: string[], origin: string | undefined): boolean {
  let result = false;
  corsOriginCheck(list)(origin, (_e, ok) => { result = !!ok; });
  return result;
}

test("M11 CORS: only listed web addresses are answered; production needs https", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  assert.throws(() => corsOrigins(prod), /CORS_ORIGINS is required/);
  assert.throws(() => corsOrigins({ ...prod, CORS_ORIGINS: "http://tindahan.example.com" }), /https/);
  assert.throws(() => corsOrigins({ ...prod, CORS_ORIGINS: "https://ok.example.com, not a url" }), /invalid origin/);
  const list = corsOrigins({ ...prod, CORS_ORIGINS: "https://tindahan.example.com/, https://admin.example.com" });
  assert.deepEqual(list, ["https://tindahan.example.com", "https://admin.example.com"]);
  assert.equal(allowed(list, "https://tindahan.example.com"), true);
  assert.equal(allowed(list, "https://evil.example.com"), false, "an unlisted site gets no CORS answer");
  assert.equal(allowed(list, "https://tindahan.example.com.evil.com"), false);
  assert.equal(allowed(list, undefined), true, "no Origin (server-to-server, curl) is not a browser request");
  const dev = corsOrigins({ NODE_ENV: "development", CORS_ORIGINS: "http://192.168.1.10:3000" } as NodeJS.ProcessEnv);
  assert.ok(dev.includes("http://localhost:3000") && dev.includes("http://192.168.1.10:3000"));
  assert.equal(allowed(dev, "http://evil.localhost:3000"), false);
});

// ── 3. login lockout ─────────────────────────────────────────────────────────

test("M11 lockout: 5 wrong passwords lock password login — even the right one — until it lifts", async () => {
  const svc = new AuthService(new PrismaAuthRepository(), CONFIG);
  const u = await person("Locked Lito", "STAFF", "tamang-password-123");
  const login = (password: string) => svc.login({ identifier: u.email!, password });
  for (let i = 1; i < LOGIN_MAX_FAILS; i++) {
    const r = await login("mali-mali-mali");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.type, "unauthorized", `try ${i}`);
  }
  const fifth = await login("mali-mali-mali");
  assert.equal(!fifth.ok && fifth.error.type, "rate_limited", "the 5th wrong password locks");
  const right = await login("tamang-password-123");
  assert.equal(!right.ok && right.error.type, "rate_limited", "the right password is refused while locked");
  const viaChange = await svc.changePassword({ identifier: u.email!, currentPassword: "tamang-password-123", newPassword: "bagong-password-456", newPasswordConfirm: "bagong-password-456" });
  assert.equal(!viaChange.ok && viaChange.error.type, "rate_limited", "change-password is not a way around the lock");
  const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { loginLockedUntil: true } });
  assert.ok(row.loginLockedUntil && row.loginLockedUntil.getTime() > Date.now() + 14 * 60_000, "locked about 15 minutes, kept in the database");

  await prisma.user.update({ where: { id: u.id }, data: { loginLockedUntil: new Date(Date.now() - 1000) } });
  const later = await login("tamang-password-123");
  assert.equal(later.ok, true, "after the lock lifts the right password works");
  const cleared = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { loginFailedCount: true } });
  assert.equal(cleared.loginFailedCount, 0, "a good login clears the count");
});

test("M11 lockout: a burst of parallel wrong guesses still gets only 5 tries", async () => {
  const svc = new AuthService(new PrismaAuthRepository(), CONFIG);
  const u = await person("Burst Bert", "STAFF", "tamang-password-123");
  const results = await Promise.all(Array.from({ length: 12 }, () => svc.login({ identifier: u.email!, password: "hula-hula-hula" })));
  const counted = results.filter((r) => !r.ok && r.error.type === "unauthorized").length;
  assert.ok(counted <= LOGIN_MAX_FAILS - 1, `at most ${LOGIN_MAX_FAILS - 1} plain refusals before the lock (got ${counted})`);
  const right = await svc.login({ identifier: u.email!, password: "tamang-password-123" });
  assert.equal(!right.ok && right.error.type, "rate_limited");
});

// ── 4. invites across stores ─────────────────────────────────────────────────

test("M11 invites: store A inviting store B's owner cannot rewrite, reset, re-PIN or sign out that account", async () => {
  const a = await store("a");
  const b = await store("b");
  const ownerA = await person("Owner A", "STORE_OWNER");
  const ownerB = await person("Owner B", "STORE_OWNER");
  await member(ownerA.id, a.id, "OWNER");
  await member(ownerB.id, b.id, "OWNER");

  const team = new TeamService();
  const inv = await team.invite(a.id, ownerB.email!, null, "STAFF");
  assert.equal(inv.ok, true, "store A may still add the person as its staff");
  assert.equal(inv.ok && inv.value.tempPassword, undefined, "no new password for an existing account");
  const afterInvite = await prisma.user.findUniqueOrThrow({ where: { id: ownerB.id }, select: { role: true, tokenVersion: true } });
  assert.equal(afterInvite.role, "STORE_OWNER", "the account-wide role is untouched");

  const changed = await team.changeRole(a.id, ownerB.id, "MANAGER");
  assert.equal(changed.ok, true);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ownerB.id }, select: { role: true } })).role, "STORE_OWNER");

  const auth = new AuthService(new PrismaAuthRepository(), CONFIG);
  const reset = await auth.resetPassword({ userId: ownerB.id, storeId: a.id, resetBy: ownerA.id });
  assert.equal(!reset.ok && reset.error.type, "forbidden", "store A cannot reset store B's owner's password");
  const pin = await new PeopleService().updateMember(a.id, ownerB.id, { pin: "4821" }, ownerA.id);
  assert.equal(pin.ok, false, "nor set their PIN");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ownerB.id }, select: { pinHash: true } })).pinHash, null);

  const off = await team.deactivate(a.id, ownerB.id);
  assert.equal(off.ok, true);
  const afterOff = await prisma.user.findUniqueOrThrow({ where: { id: ownerB.id }, select: { tokenVersion: true } });
  assert.equal(afterOff.tokenVersion, afterInvite.tokenVersion, "removing them from A does not sign them out of B");
});

test("M11 invites: a platform admin's account role is never changed by a store; single-store staff still follow their store role", async () => {
  const a = await store("p");
  const admin = await person("Platform Pat", "PLATFORM_ADMIN");
  const team = new TeamService();
  const r = await team.invite(a.id, admin.email!, null, "STAFF");
  assert.equal(r.ok, true);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: admin.id }, select: { role: true } })).role, "PLATFORM_ADMIN");

  const fresh = await team.invite(a.id, `${run}-fresh@m11.test`.toLowerCase(), "Bagong Staff", "STAFF");
  assert.equal(fresh.ok, true);
  if (fresh.ok) userIds.push(fresh.value.userId);
  const promoted = fresh.ok ? await team.changeRole(a.id, fresh.value.userId, "MANAGER") : null;
  assert.equal(promoted?.ok, true);
  assert.equal(fresh.ok && (await prisma.user.findUniqueOrThrow({ where: { id: fresh.value.userId }, select: { role: true } })).role, "MANAGER", "own-store staff: role follows");
  const owner = await person("Owner P", "STORE_OWNER");
  await member(owner.id, a.id, "OWNER");
  const auth = new AuthService(new PrismaAuthRepository(), CONFIG);
  const reset = fresh.ok ? await auth.resetPassword({ userId: fresh.value.userId, storeId: a.id, resetBy: owner.id }) : null;
  assert.equal(reset?.ok, true, "the owner still resets their own staff's password");

  assert.equal(storeOwnsAccount("PLATFORM_ADMIN", 0), false);
  assert.equal(storeOwnsAccount("STAFF", 1), false);
  assert.equal(storeOwnsAccount("STAFF", 0), true);
});

// ── 5. sign-up closed ────────────────────────────────────────────────────────

test("M11 sign-up: /auth/register is closed unless the operator reopens it", () => {
  assert.equal(ownerSignupOpen({} as NodeJS.ProcessEnv), false);
  assert.equal(ownerSignupOpen({ ALLOW_OWNER_SIGNUP: "false" } as NodeJS.ProcessEnv), false);
  assert.equal(ownerSignupOpen({ ALLOW_OWNER_SIGNUP: "TRUE " } as NodeJS.ProcessEnv), true);
  assert.throws(() => assertOwnerSignupOpen({} as NodeJS.ProcessEnv), (e: unknown) => e instanceof HttpException && e.getStatus() === 403);
  assert.doesNotThrow(() => assertOwnerSignupOpen({ ALLOW_OWNER_SIGNUP: "true" } as NodeJS.ProcessEnv));
  // The route checks the gate before it reads the body or creates anything.
  const src = readFileSync(fileURLToPath(new URL("../auth/auth.controller.ts", import.meta.url)), "utf8");
  const route = src.slice(src.indexOf('@Post("register")'), src.indexOf('@Post("login")'));
  assert.ok(route.indexOf("assertOwnerSignupOpen()") > 0, "register calls the gate");
  assert.ok(route.indexOf("assertOwnerSignupOpen()") < route.indexOf("this.auth.register("), "before the account is created");
});

// ── 6. order numbers per store ───────────────────────────────────────────────

test("M11 order numbers: two stores may use the same number; one store never twice", async () => {
  const a = await store("o1");
  const b = await store("o2");
  const order = (storeId: string, n: string) => prisma.order.create({
    data: {
      storeId, orderNumber: n, currencyCode: "PHP", subtotalMinor: 100, totalMinor: 100, snapshot: {}, cartToken: `${run}-${Math.random()}`,
      customerName: "Walk-in", customerPhone: "", deliveryAddressLine1: "",
    },
  });
  const n = `RICE-2026-${String(seq).padStart(6, "0")}`;
  await order(a.id, n);
  await order(b.id, n);
  await assert.rejects(() => order(a.id, n), (e: unknown) => (e as { code?: string }).code === "P2002");
});

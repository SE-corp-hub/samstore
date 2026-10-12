import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthService } from "./auth.service.js";
import type { AuthUserRecord, AuthRepository } from "./auth.repository.js";
import { hashPassword } from "./auth.domain.js";

class InMemoryAuthRepo implements AuthRepository {
  users = new Map<string, AuthUserRecord>();
  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    return this.users.get(email.toLowerCase()) ?? null;
  }
  async findByIdentifier(identifier: string): Promise<AuthUserRecord | null> {
    const id = (identifier ?? "").trim().toLowerCase();
    if (!id) return null;
    for (const u of this.users.values()) {
      if (u.phone === id) return u;
    }
    return this.users.get(id) ?? null;
  }
  async createUser(email: string | null, phone: string | null, passwordHash: string, name: string | null, role: string): Promise<AuthUserRecord> {
    const key = (email ?? phone ?? "").toLowerCase();
    const user: AuthUserRecord = {
      id: randomUUID(),
      email,
      phone,
      phoneVerified: false,
      passwordHash,
      name,
      role,
      memberships: [],
    };
    this.users.set(key, user);
    return user;
  }
  seed(user: AuthUserRecord) {
    this.users.set(user.email?.toLowerCase() ?? user.phone ?? "", user);
  }
}

const CONFIG = { jwtSecret: "test-secret-0123456789", jwtExpiresIn: "1h" };

function makeService() {
  const repo = new InMemoryAuthRepo();
  return { svc: new AuthService(repo, CONFIG), repo };
}

test("register creates a user and returns a JWT", async () => {
  const { svc } = makeService();
  const r = await svc.register({ email: "Owner@Store.com", password: "password123", name: "Sam Owner" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.user.email, "owner@store.com"); // lowercased
  assert.match(r.value.token, /^eyJ/); // JWT header
});

test("register rejects invalid email and short password", async () => {
  const { svc } = makeService();
  assert.equal((await svc.register({ email: "not-an-email", password: "password123" })).ok, false);
  assert.equal((await svc.register({ email: "a@b.com", password: "short" })).ok, false);
});

test("register rejects a mismatched password confirmation and accepts a matching one", async () => {
  // A mistyped password is unrecoverable for the owner — the confirmation must be
  // checked server-side, mirroring what change-password already enforces.
  const { svc } = makeService();
  const mismatch = await svc.register({
    email: "typo@store.com",
    password: "password123",
    passwordConfirm: "password124",
  });
  assert.equal(mismatch.ok, false);
  if (mismatch.ok) return;
  assert.equal(mismatch.error.type, "validation");
  assert.ok(
    JSON.stringify(mismatch.error).toLowerCase().includes("match"),
    "the error must say the two entries do not match",
  );

  const match = await svc.register({
    email: "typed@store.com",
    password: "password123",
    passwordConfirm: "password123",
  });
  assert.equal(match.ok, true);
});

test("register rejects duplicate email", async () => {
  const { svc } = makeService();
  await svc.register({ email: "dup@store.com", password: "password123" });
  const r = await svc.register({ email: "DUP@store.com", password: "password456" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "conflict");
});

test("register ignores any client-supplied storeId/role — no store binding, never platform admin", async () => {
  const { svc, repo } = makeService();
  // Defense-in-depth: even if a caller smuggles these keys (the controller no
  // longer accepts them), the service must not bind a store or elevate the role.
  const r = await svc.register({
    email: "sneaky@store.com",
    password: "password123",
    storeId: "someone-elses-store",
    role: "PLATFORM_ADMIN",
  } as unknown as { email: string; password: string });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const created = repo.users.get("sneaky@store.com");
  assert.ok(created, "user was created");
  assert.equal(created.role, "STORE_OWNER", "role is always STORE_OWNER");
  assert.equal(created.memberships.length, 0, "no store membership is created");

  // The JWT must not carry a storeId claim either.
  const { verifyToken } = await import("./auth.domain.js");
  const decoded = verifyToken(r.value.token, CONFIG);
  assert.equal(decoded.storeId, undefined, "no storeId claim in the token");
  assert.equal(decoded.role, "STORE_OWNER", "token role is STORE_OWNER");
});

test("login succeeds with correct password and fails with wrong", async () => {
  const { svc, repo } = makeService();
  const hash = await hashPassword("correct-horse");
  repo.seed({ id: "u1", email: "staff@store.com", phone: null, phoneVerified: false, passwordHash: hash, name: "Staff", role: "STAFF", memberships: [{ storeId: "s1", role: "STAFF" }] });
  const ok = await svc.login({ email: "staff@store.com", password: "correct-horse" });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.match(ok.value.token, /^eyJ/);
  assert.equal(ok.value.user.name, "Staff");

  const bad = await svc.login({ email: "staff@store.com", password: "wrong" });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.type, "unauthorized");
});

test("login with unknown email is unauthorized", async () => {
  const { svc } = makeService();
  const r = await svc.login({ email: "ghost@store.com", password: "whatever" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "unauthorized");
});

test("jwt signing and verification round-trips claims", async () => {
  const { signToken, verifyToken } = await import("./auth.domain.js");
  const token = signToken({ sub: "u1", role: "STORE_OWNER", email: "a@b.com", storeId: "s1" }, CONFIG);
  const decoded = verifyToken(token, CONFIG);
  assert.equal(decoded.sub, "u1");
  assert.equal(decoded.storeId, "s1");
});

// ─────────────────────────────── A1: phone-first identity ───────────────────────────────

/** A1 runs against the phone-required registration mode (D7 flag on). */
function withPhoneMode<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.IDENTITY_REQUIRE_PHONE;
  process.env.IDENTITY_REQUIRE_PHONE = "true";
  try {
    return fn().finally(() => {
      if (prev === undefined) delete process.env.IDENTITY_REQUIRE_PHONE;
      else process.env.IDENTITY_REQUIRE_PHONE = prev;
    });
  } catch (e) {
    if (prev === undefined) delete process.env.IDENTITY_REQUIRE_PHONE;
    else process.env.IDENTITY_REQUIRE_PHONE = prev;
    throw e;
  }
}

test("A1: register with phone only (no email) succeeds and normalizes E.164", async () => {
  const { svc } = makeService();
  const r = await withPhoneMode(() => svc.register({ phone: "0917 123-4567", password: "password123", name: "Phone Owner" }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.user.email, null);
  assert.equal(r.value.user.phone, "+639171234567");
  assert.match(r.value.token, /^eyJ/);
});

test("A1: login with the phone, and with the email, both succeed for one account", async () => {
  const { svc } = makeService();
  const reg = await withPhoneMode(() => svc.register({ phone: "09181234567", email: "both@store.com", password: "password123" }));
  assert.equal(reg.ok, true);

  const byPhone = await svc.login({ identifier: "+639181234567", password: "password123" });
  assert.equal(byPhone.ok, true);
  const byEmail = await svc.login({ email: "BOTH@store.com", password: "password123" });
  assert.equal(byEmail.ok, true);
  if (!byPhone.ok || !byEmail.ok) return;
  assert.equal(byPhone.value.user.id, byEmail.value.user.id);
});

test("A1: two accounts on one normalized phone are a conflict", async () => {
  const { svc } = makeService();
  await withPhoneMode(() => svc.register({ phone: "0917 123 4567", password: "password123" }));
  const r = await withPhoneMode(() => svc.register({ phone: "+639171234567", password: "password456" }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "conflict");
  assert.match(r.error.message ?? "", /mobile number/i);
});

test("A1: login with an unknown identifier is unauthorized and reveals nothing", async () => {
  const { svc } = makeService();
  const r = await svc.login({ identifier: "+639999999999", password: "whatever" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "unauthorized");
  assert.match(r.error.message ?? "", /Invalid phone\/email or password/);
});

test("A1: register rejects an invalid phone spellings (landline / garbage)", async () => {
  const { svc } = makeService();
  assert.equal((await withPhoneMode(() => svc.register({ phone: "02 8123 4567", password: "password123" }))).ok, false);
  assert.equal((await withPhoneMode(() => svc.register({ phone: "abc123", password: "password123" }))).ok, false);
});

test("A1: register still rejects smuggled storeId/role (Module-1 invariant)", async () => {
  const { svc, repo } = makeService();
  const r = await withPhoneMode(() => svc.register({
    phone: "09171234567",
    password: "password123",
    storeId: "someone-elses-store",
    role: "PLATFORM_ADMIN",
  } as unknown as { phone: string; password: string }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const created = repo.users.get("+639171234567");
  assert.ok(created, "user was created");
  assert.equal(created.role, "STORE_OWNER");
  assert.equal(created.memberships.length, 0);
});
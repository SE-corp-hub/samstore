// Per-store build, step 8 — a step saved offline goes up only under the login that made it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { flushQueue, heldSteps, queuedSteps, sendStep } from "./offlineQueue";

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), key: () => null, length: 0 };
Object.assign(globalThis, { window: { localStorage: storage, sessionStorage: storage, dispatchEvent: () => true, addEventListener: () => {}, location: { pathname: "/admin/dashboard", assign: () => {} } }, localStorage: storage, sessionStorage: storage });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
const nav = globalThis.navigator as { onLine: boolean };

const tokenOf = (sub: string) => `x.${Buffer.from(JSON.stringify({ sub, role: "STAFF" })).toString("base64url")}.y`;
const signIn = (sub: string, name: string) => { mem.set("samstore.admin.token", tokenOf(sub)); mem.set("samstore.admin.email", name); };
const sentAs: { path: string; auth: string }[] = [];
const server = (async (url: string | URL | Request, init?: RequestInit) => {
  sentAs.push({ path: String(url), auth: (init?.headers as Record<string, string>).Authorization ?? "" });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-request-id": "r1" } });
}) as typeof fetch;

beforeEach(() => { mem.clear(); sentAs.length = 0; nav.onLine = true; });

test("a sale saved offline by one login is not sent under the next login", async () => {
  signIn("lorna", "Lorna");
  nav.onLine = false;
  globalThis.fetch = (async () => { throw new Error("no signal"); }) as typeof fetch;
  assert.deepEqual(await sendStep("/admin/benta/sell", { total: 1 }, "Sale ₱1,350"), { status: "queued" });
  assert.equal(queuedSteps().length, 1);
  assert.equal(queuedSteps()[0]!.by, "lorna");
  assert.equal(queuedSteps()[0]!.byName, "Lorna");

  // Ben signs in on the same tablet and the signal returns.
  signIn("ben", "Ben");
  nav.onLine = true;
  globalThis.fetch = server;
  assert.equal(queuedSteps().length, 0, "Ben has nothing waiting");
  assert.equal(heldSteps().length, 1, "Lorna's sale is held");
  assert.deepEqual(await flushQueue(), { sent: 0, failed: 0 });
  assert.equal(sentAs.length, 0, "nothing was sent under Ben's login");

  // Ben's own sale goes straight up, past Lorna's held one.
  const r = await sendStep("/admin/benta/sell", { total: 2 }, "Sale ₱56");
  assert.equal(r.status, "sent");
  assert.equal(sentAs.length, 1);
  assert.equal(sentAs[0]!.auth, `Bearer ${tokenOf("ben")}`);
  assert.equal(heldSteps().length, 1);

  // Lorna signs in again: her sale goes up under her own login.
  signIn("lorna", "Lorna");
  assert.deepEqual(await flushQueue(), { sent: 1, failed: 0 });
  assert.equal(sentAs[1]!.auth, `Bearer ${tokenOf("lorna")}`);
  assert.equal(heldSteps().length + queuedSteps().length, 0);
});

test("a step saved before makers were recorded is still sent", async () => {
  signIn("ben", "Ben");
  mem.set("rice-offline-queue-v1", JSON.stringify([{ id: "old-1", path: "/admin/benta/sell", body: {}, label: "Old sale", createdAt: 1, attempts: 0 }]));
  globalThis.fetch = server;
  assert.equal(queuedSteps().length, 1);
  assert.deepEqual(await flushQueue(), { sent: 1, failed: 0 });
});

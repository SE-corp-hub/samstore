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

test("a sale the server refuses stays on the tablet with everything in it, and can be sent again", async () => {
  const { failedSteps, retryFailed, removeFailed, clearFailed } = await import("./offlineQueue");
  signIn("lorna", "Lorna");
  nav.onLine = false;
  globalThis.fetch = (async () => { throw new Error("no signal"); }) as typeof fetch;
  await sendStep("/admin/benta/sell", { lines: [{ productId: "p1", quantity: 2 }] }, "Sale ₱2,700");
  const id = queuedSteps()[0]!.id;

  // The signal returns; the server says no (the books show too little stock).
  nav.onLine = true;
  const keys: string[] = [];
  let refuse = true;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    keys.push((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    return refuse
      ? new Response(JSON.stringify({ message: "Only 1 of Dinorado 25 kg here" }), { status: 409, headers: { "x-request-id": "r1" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-request-id": "r1" } });
  }) as typeof fetch;
  assert.deepEqual(await flushQueue(), { sent: 0, failed: 1 });
  assert.equal(queuedSteps().length, 0);
  const kept = failedSteps();
  assert.equal(kept.length, 1);
  assert.deepEqual([kept[0]!.id, kept[0]!.label, kept[0]!.message, kept[0]!.path, kept[0]!.by, kept[0]!.byName], [id, "Sale ₱2,700", "Only 1 of Dinorado 25 kg here", "/admin/benta/sell", "lorna", "Lorna"]);
  assert.deepEqual(kept[0]!.body, { lines: [{ productId: "p1", quantity: 2 }] }, "the whole sale is kept, not only its label");

  // "Clear the list" never throws a kept sale away.
  clearFailed();
  assert.equal(failedSteps().length, 1);

  // The owner adds the stock; "Send again" sends the same sale with the same key (the server saves it once).
  refuse = false;
  assert.equal(retryFailed(id), true);
  await new Promise((r) => setTimeout(r, 20));
  await flushQueue();
  assert.equal(failedSteps().length, 0);
  assert.equal(queuedSteps().length, 0);
  assert.deepEqual(keys, [id, id]);

  // Removing is one sale at a time.
  mem.set("rice-offline-failed-v1", JSON.stringify([{ id: "a", label: "A", message: "no", at: 1, path: "/x", body: {} }, { id: "b", label: "B", message: "no", at: 2, path: "/x", body: {} }]));
  removeFailed("a");
  assert.deepEqual(failedSteps().map((f) => f.id), ["b"]);
});

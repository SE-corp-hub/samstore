// Offline in the store — screens open from the last good answer when the server can't be reached.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cachedGet, checkConnection, connectionState, INTERNET_PROBE, isOffline, offlineRef, saveCopy, savedCopy, savedThenFresh } from "./offlineCache";
import { registeredStoreName } from "./slip-print";

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
Object.assign(globalThis, { window: { localStorage: storage, sessionStorage: storage, dispatchEvent: () => true, location: { pathname: "/admin/dashboard", assign: () => {} } }, localStorage: storage, sessionStorage: storage });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

const answer = (status: number, body: unknown, headers: Record<string, string> = { "x-request-id": "r1" }) => async () => new Response(JSON.stringify(body), { status, headers });
const nav = globalThis.navigator as { onLine: boolean };

beforeEach(() => { mem.clear(); mem.set("samstore.admin.storeId", "s1"); nav.onLine = true; });

test("a good answer is saved and returned", async () => {
  globalThis.fetch = answer(200, { products: [1, 2] }) as typeof fetch;
  assert.deepEqual(await cachedGet("/admin/benta/catalog"), { products: [1, 2] });
  assert.deepEqual(savedCopy("/admin/benta/catalog"), { products: [1, 2] });
  assert.equal(isOffline(), false);
});

test("no internet: the saved copy, without asking the server", async () => {
  globalThis.fetch = answer(200, { products: [1] }) as typeof fetch;
  await cachedGet("/admin/benta/catalog");
  nav.onLine = false;
  globalThis.fetch = (async () => { throw new Error("must not be called"); }) as typeof fetch;
  assert.deepEqual(await cachedGet("/admin/benta/catalog"), { products: [1] });
  assert.equal(isOffline(), true);
});

test("server asleep (proxy 500 without X-Request-Id) or unreachable: the saved copy", async () => {
  globalThis.fetch = answer(200, { a: 1 }) as typeof fetch;
  await cachedGet("/admin/settings");
  globalThis.fetch = answer(500, "Internal Server Error", {}) as typeof fetch;
  assert.deepEqual(await cachedGet("/admin/settings"), { a: 1 });
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  assert.deepEqual(await cachedGet("/admin/settings"), { a: 1 });
  assert.equal(isOffline(), true);
  globalThis.fetch = answer(200, { a: 2 }) as typeof fetch;
  assert.deepEqual(await cachedGet("/admin/settings"), { a: 2 });
  assert.equal(isOffline(), false, "a good answer ends offline mode");
});

test("too slow: the saved copy after the wait", async () => {
  globalThis.fetch = answer(200, { a: 1 }) as typeof fetch;
  await cachedGet("/admin/me/rice");
  globalThis.fetch = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch;
  assert.deepEqual(await cachedGet("/admin/me/rice", { waitMs: 20 }), { a: 1 });
});

test("a clear no (403) is not hidden behind an old copy; each store has its own copy", async () => {
  globalThis.fetch = answer(200, { a: 1 }) as typeof fetch;
  await cachedGet("/admin/customers");
  globalThis.fetch = answer(403, { message: "no" }) as typeof fetch;
  assert.equal(await cachedGet("/admin/customers"), null);
  mem.set("samstore.admin.storeId", "s2");
  nav.onLine = false;
  assert.equal(await cachedGet("/admin/customers"), null, "store 2 never sees store 1's copy");
});

test("offline receipt reference", () => {
  assert.equal(offlineRef("sale-1b2c3d4e-aaaa-bbbb-cccc-0123456789ab"), "OFFLINE-6789AB");
});

test("real check: Wi-Fi off while the browser still says online (GBox) shows Offline, and back", async () => {
  globalThis.fetch = answer(200, { a: 1 }) as typeof fetch;
  await cachedGet("/admin/settings");
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  assert.equal(await checkConnection(), false);
  assert.equal(nav.onLine, true);
  assert.equal(isOffline(), true);
  assert.deepEqual(await cachedGet("/admin/settings"), { a: 1 }, "no wait: the saved copy at once");
  globalThis.fetch = answer(200, {}) as typeof fetch;
  assert.equal(await checkConnection(), true);
  assert.equal(isOffline(), false);
});

test("receipts know the registered store name from the saved /admin/settings answer (name is at the top level)", () => {
  saveCopy("/admin/settings", { id: "s1", name: " Tindahan ni Sam ", settings: {} });
  assert.equal(registeredStoreName(), "Tindahan ni Sam");
});

test("Wi-Fi on but the free server asleep: 'Connecting to server', not a false 'Offline'; Online once it answers", async () => {
  // Own web server times out (asleep), the always-awake probe answers.
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith(INTERNET_PROBE)) return new Response(null, { status: 204 });
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch;
  assert.equal(await checkConnection(), true);
  assert.equal(connectionState(), "waking");
  assert.equal(isOffline(), true, "steps still wait on the tablet while the server sleeps");
  // Web and API awake again.
  globalThis.fetch = answer(200, { ok: true }) as typeof fetch;
  assert.equal(await checkConnection(), true);
  assert.equal(connectionState(), "online");
  // No internet at all: both fail.
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  assert.equal(await checkConnection(), false);
  assert.equal(connectionState(), "offline");
  globalThis.fetch = answer(200, {}) as typeof fetch;
  await checkConnection();
});

test("API asleep behind the proxy (Render 429 hibernate-rate-limited): the saved copy, not an empty screen", async () => {
  globalThis.fetch = answer(200, { a: 1 }) as typeof fetch;
  await cachedGet("/admin/settings");
  globalThis.fetch = answer(429, "Too Many Requests", { "x-render-routing": "hibernate-rate-limited" }) as typeof fetch;
  assert.deepEqual(await cachedGet("/admin/settings"), { a: 1 });
  assert.equal(connectionState(), "waking");
  globalThis.fetch = answer(200, {}) as typeof fetch;
  await checkConnection();
  assert.equal(connectionState(), "online");
});

test("savedThenFresh: the saved copy at once, then the server's answer", async () => {
  globalThis.fetch = answer(200, { products: ["old"] }) as typeof fetch;
  await cachedGet("/admin/benta/catalog");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  globalThis.fetch = (async () => { await gate; return new Response(JSON.stringify({ products: ["new"] }), { status: 200, headers: { "x-request-id": "r2" } }); }) as typeof fetch;
  const shown: unknown[] = [];
  const done = savedThenFresh("/admin/benta/catalog", (d) => shown.push(d));
  assert.deepEqual(shown, [{ products: ["old"] }], "on screen before the server answers");
  release();
  assert.deepEqual(await done, { products: ["new"] });
  assert.deepEqual(shown, [{ products: ["old"] }, { products: ["new"] }]);
  assert.deepEqual(savedCopy("/admin/benta/catalog"), { products: ["new"] }, "the new answer is saved for next time");
});

test("savedThenFresh: nothing saved yet waits for the server; offline shows the copy once", async () => {
  globalThis.fetch = answer(200, { a: 1 }) as typeof fetch;
  const shown: unknown[] = [];
  assert.deepEqual(await savedThenFresh("/admin/customers", (d) => shown.push(d)), { a: 1 });
  assert.deepEqual(shown, [{ a: 1 }]);
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  const again: unknown[] = [];
  assert.deepEqual(await savedThenFresh("/admin/customers", (d) => again.push(d)), { a: 1 });
  assert.deepEqual(again, [{ a: 1 }], "not shown twice");
  globalThis.fetch = answer(403, { message: "no" }) as typeof fetch;
  assert.equal(await savedThenFresh("/admin/customers", () => {}), null, "a clear no still comes back as null");
});

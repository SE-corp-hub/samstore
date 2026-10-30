// Overview on the free beta server: a sleeping server or no internet is "waking", not "Failed to load overview".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getWidget, MAX_RETRIES, overviewNotice, type Widget } from "./overview-load";

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
Object.assign(globalThis, { window: { localStorage: storage, sessionStorage: storage, dispatchEvent: () => true, location: { pathname: "/admin/dashboard", assign: () => {} } }, localStorage: storage, sessionStorage: storage });

const answer = (status: number, body: unknown, headers: Record<string, string> = { "x-request-id": "r1" }) => async () => new Response(JSON.stringify(body), { status, headers });

beforeEach(() => { mem.clear(); mem.set("samstore.admin.storeId", "s1"); });

test("a good answer is live and saved for next time", async () => {
  globalThis.fetch = answer(200, { rows: [1] }) as typeof fetch;
  assert.deepEqual(await getWidget("/admin/analytics/status"), { kind: "live", data: { rows: [1] } });
  globalThis.fetch = answer(502, "Bad Gateway", {}) as typeof fetch;
  assert.deepEqual(await getWidget("/admin/analytics/status"), { kind: "saved", data: { rows: [1] } });
});

test("server asleep with nothing saved yet: waiting, not refused", async () => {
  globalThis.fetch = answer(500, "Internal Server Error", {}) as typeof fetch;
  assert.deepEqual(await getWidget("/admin/analytics/daily?days=7"), { kind: "waiting" });
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  assert.deepEqual(await getWidget("/admin/analytics/daily?days=7"), { kind: "waiting" });
});

test("too slow to answer: waiting", async () => {
  globalThis.fetch = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  assert.deepEqual(await getWidget("/admin/inventory?status=low", 10), { kind: "waiting" });
});

test("a real no from the API is refused, never an old copy", async () => {
  globalThis.fetch = answer(200, { rows: [1] }) as typeof fetch;
  await getWidget("/admin/analytics/status");
  globalThis.fetch = answer(403, { message: "no" }) as typeof fetch;
  assert.deepEqual(await getWidget("/admin/analytics/status"), { kind: "refused", status: 403 });
  globalThis.fetch = answer(500, { message: "boom" }) as typeof fetch;
  assert.deepEqual(await getWidget("/admin/analytics/status"), { kind: "refused", status: 500 });
});

const live: Widget = { kind: "live", data: {} };
const saved: Widget = { kind: "saved", data: {} };
const waiting: Widget = { kind: "waiting" };
const refused = (status: number): Widget => ({ kind: "refused", status });
const on = { offline: false, tries: 0 };

test("notice: all live is quiet", () => {
  assert.equal(overviewNotice([live, live, live], on), null);
});

test("notice: server waking says so and keeps asking, never 'Failed'", () => {
  const n = overviewNotice([waiting, waiting, waiting], on)!;
  assert.equal(n.tone, "info");
  assert.equal(n.askAgain, true);
  assert.match(n.text, /Connecting to the server/);
  assert.match(overviewNotice([saved, saved, live], on)!.text, /saved on this tablet/);
  assert.match(overviewNotice([saved, waiting, waiting], { offline: true, tries: 0 })!.text, /^No internet/);
});

test("notice: after ~5 minutes of waking, stop and offer Retry", () => {
  const n = overviewNotice([waiting, waiting, waiting], { offline: false, tries: MAX_RETRIES })!;
  assert.equal(n.askAgain, false);
  assert.equal(n.tone, "danger");
});

test("notice: real refusals keep the old messages", () => {
  assert.match(overviewNotice([refused(403), refused(403), refused(403)], on)!.text, /Select a store/);
  assert.equal(overviewNotice([refused(500), refused(404), refused(500)], on)!.text, "Failed to load overview");
  assert.equal(overviewNotice([live, refused(500), live], on)!.tone, "warning");
});

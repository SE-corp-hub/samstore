import { test } from "node:test";
import assert from "node:assert/strict";
import { notFromApi, WAKE_EVERY_MS, wakeApi, wakeFetch } from "./wake-fetch";

// A number is an answer from the API (it carries X-Request-Id); "proxy500" is the web
// proxy giving up on a sleeping API (plain text, no X-Request-Id).
const answers = (list: (number | "down" | "proxy500")[]) => {
  let i = 0;
  globalThis.fetch = (async () => {
    const a = list[Math.min(i++, list.length - 1)];
    if (a === "down") throw new TypeError("Failed to fetch");
    if (a === "proxy500") return new Response("Internal Server Error", { status: 500 });
    return new Response("{}", { status: a, headers: { "X-Request-Id": "r1" } });
  }) as typeof fetch;
  return () => i;
};
const noWait = { sleep: async () => {} };

test("keeps asking while the server wakes, then returns its answer", async () => {
  const calls = answers([502, "down", "proxy500", 503, 200]);
  const seen: boolean[] = [];
  const res = await wakeFetch("/x", undefined, (w) => seen.push(w), noWait);
  assert.equal(res.status, 200);
  assert.equal(calls(), 5);
  assert.deepEqual(seen, [true, true, true, true, false]);
});

test("a real answer (even an error like 401) comes back at once", async () => {
  const calls = answers([401]);
  const res = await wakeFetch("/x", undefined, () => {}, noWait);
  assert.equal(res.status, 401);
  assert.equal(calls(), 1);
});

test("a 500 from the API itself is a real answer, not a sleeping server", async () => {
  const calls = answers([500]);
  const res = await wakeFetch("/x", undefined, () => {}, noWait);
  assert.equal(res.status, 500);
  assert.equal(calls(), 1);
});

test("gives up after the last try", async () => {
  answers([502]);
  const res = await wakeFetch("/x", undefined, () => {}, { ...noWait, tries: 3 });
  assert.equal(res.status, 502);
  answers(["down"]);
  await assert.rejects(wakeFetch("/x", undefined, () => {}, { ...noWait, tries: 2 }));
});

test("Render's 429 for a sleeping API (no X-Request-Id) is waking; the API's own 429 is a real answer", () => {
  assert.equal(notFromApi(new Response("Too Many Requests", { status: 429, headers: { "x-render-routing": "hibernate-rate-limited" } })), true);
  assert.equal(notFromApi(new Response("{}", { status: 429, headers: { "X-Request-Id": "r1" } })), false);
});

test("wakes the API at its own address, at most every 20 s, and never without one", () => {
  const urls: string[] = [];
  globalThis.fetch = (async (u: string, init?: RequestInit) => { urls.push(`${String(u).split("?")[0]} ${init?.mode}`); return new Response(null); }) as typeof fetch;
  wakeApi(1_000_000, "");
  wakeApi(1_000_000, "https://api.example");
  wakeApi(1_000_000 + WAKE_EVERY_MS - 1, "https://api.example");
  wakeApi(1_000_000 + WAKE_EVERY_MS, "https://api.example");
  assert.deepEqual(urls, ["https://api.example/health no-cors", "https://api.example/health no-cors"]);
});

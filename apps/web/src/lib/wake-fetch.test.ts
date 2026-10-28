import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeFetch } from "./wake-fetch";

const answers = (list: (number | "down")[]) => {
  let i = 0;
  globalThis.fetch = (async () => {
    const a = list[Math.min(i++, list.length - 1)];
    if (a === "down") throw new TypeError("Failed to fetch");
    return new Response("{}", { status: a });
  }) as typeof fetch;
  return () => i;
};
const noWait = { sleep: async () => {} };

test("keeps asking while the server wakes, then returns its answer", async () => {
  const calls = answers([502, "down", 503, 200]);
  const seen: boolean[] = [];
  const res = await wakeFetch("/x", undefined, (w) => seen.push(w), noWait);
  assert.equal(res.status, 200);
  assert.equal(calls(), 4);
  assert.deepEqual(seen, [true, true, true, false]);
});

test("a real answer (even an error like 401) comes back at once", async () => {
  const calls = answers([401]);
  const res = await wakeFetch("/x", undefined, () => {}, noWait);
  assert.equal(res.status, 401);
  assert.equal(calls(), 1);
});

test("gives up after the last try", async () => {
  answers([502]);
  const res = await wakeFetch("/x", undefined, () => {}, { ...noWait, tries: 3 });
  assert.equal(res.status, 502);
  answers(["down"]);
  await assert.rejects(wakeFetch("/x", undefined, () => {}, { ...noWait, tries: 2 }));
});

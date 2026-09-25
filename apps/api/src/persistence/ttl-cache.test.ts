import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cacheBust, cacheGet, cacheKey, cacheSet, resetRedisForTest } from "./ttl-cache.js";

const originalRedisUrl = process.env.REDIS_URL;
delete process.env.REDIS_URL;
resetRedisForTest();

after(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
  resetRedisForTest();
});

test("cacheBust accepts a namespaced cache key and clears every entry in that namespace", async () => {
  const storeAKey = cacheKey("products", "store-a", "list");
  const storeBKey = cacheKey("products", "store-b", "list");
  await cacheSet(storeAKey, { id: "A" });
  await cacheSet(storeBKey, { id: "B" });

  await cacheBust(cacheKey("products", "store-a"));

  assert.equal(await cacheGet(storeAKey), undefined);
  assert.equal(await cacheGet(storeBKey), undefined);
});

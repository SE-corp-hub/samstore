// 2026-11-22 ("resack dont add on inventory"): a request that moves stock clears the saved
// Inventory / Products answers before its answer goes back; a request that does not, keeps them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstValueFrom, from } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { StockCacheInterceptor } from "./stock-cache.js";
import { markStockChanged } from "../domain/stock-changed.js";
import { cacheGet, cacheSet, cacheKey } from "./ttl-cache.js";

const ctx = (method: string) => ({ getType: () => "http", switchToHttp: () => ({ getRequest: () => ({ method }) }) }) as unknown as ExecutionContext;
const handler = (moves: boolean): CallHandler => ({ handle: () => from((async () => { await Promise.resolve(); if (moves) markStockChanged(); return { ok: true }; })()) });
const fill = async () => { await cacheSet(cacheKey("inventory", "s1", ""), { items: [1] }, 15_000); await cacheSet(cacheKey("products", "s1"), [1], 30_000); };
const saved = async () => [await cacheGet(cacheKey("inventory", "s1", "")), await cacheGet(cacheKey("products", "s1"))];

test("a request that moved stock clears Inventory and Products before it answers", async () => {
  await fill();
  const out = await firstValueFrom(new StockCacheInterceptor().intercept(ctx("POST"), handler(true)));
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(await saved(), [undefined, undefined]);
});

test("a request that moved no stock, or only read, keeps them", async () => {
  await fill();
  await firstValueFrom(new StockCacheInterceptor().intercept(ctx("POST"), handler(false)));
  await firstValueFrom(new StockCacheInterceptor().intercept(ctx("GET"), handler(true)));
  assert.notDeepEqual(await saved(), [undefined, undefined]);
  assert.ok((await saved()).every((v) => v !== undefined));
});

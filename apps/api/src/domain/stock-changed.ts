// Did this request move stock? Set by recordMovement (movements.ts), read by StockCacheInterceptor
// (persistence/stock-cache.ts), which then clears the saved Inventory / Products answers.

import { AsyncLocalStorage } from "node:async_hooks";

export interface StockMark { changed: boolean }

const als = new AsyncLocalStorage<StockMark>();

/** A stock row moved in this request. Outside a request (jobs, tests) it does nothing. */
export function markStockChanged(): void {
  const s = als.getStore();
  if (s) s.changed = true;
}

/** Run `fn` with `mark`: it turns true when `fn` moves stock. */
export const runMarkingStock = <T>(mark: StockMark, fn: () => T): T => als.run(mark, fn);

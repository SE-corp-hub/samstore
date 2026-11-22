// 2026-11-22 ("resack dont add on inventory"): Inventory (15 s) and Products (30 s) answers are
// cached, but only a few writers cleared them. After a resack, Stock in, Move stock, a sale, an
// open sack, a count… Inventory kept showing the old numbers. Now every stock movement marks the
// request (recordMovement in domain/movements.ts), and once the request is done (its transaction
// committed) StockCacheInterceptor clears both caches before the answer goes back, whoever wrote it.

import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { Observable, concatMap } from "rxjs";
import { cacheBust, cacheKey } from "./ttl-cache.js";
import { runMarkingStock, type StockMark } from "../domain/stock-changed.js";

/** Clears every saved Inventory and Products answer (they show stock). */
export async function bustStockCaches(storeId = ""): Promise<void> {
  await cacheBust(cacheKey("inventory", storeId));
  await cacheBust(cacheKey("products", storeId));
}

@Injectable()
export class StockCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? "GET";
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next.handle();
    const mark: StockMark = { changed: false };
    const bust = async () => { if (mark.changed) { mark.changed = false; await bustStockCaches().catch(() => undefined); } };
    return new Observable((subscriber) => runMarkingStock(mark, () =>
      next.handle().pipe(concatMap(async (value: unknown) => { await bust(); return value; })).subscribe({
        next: (v) => subscriber.next(v),
        // A step that failed after stock moved (rare): still clear, then pass the error on.
        error: (e: unknown) => { void bust().finally(() => subscriber.error(e)); },
        complete: () => subscriber.complete(),
      }),
    ));
  }
}

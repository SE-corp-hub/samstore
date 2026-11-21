# Each store's stock is its own (2026-11-21)

One business, four places: Bogs and Lucy (main, S1), Bahay Tindahan (S2), Lipa (S3), Bodega (WH).
Every place has its own shelf row per rice (`StockLevel`, one per `warehouseId`).

## Rules

1. **Every stock change names its store.** Inventory → Adjust, Stock in, Count, Move stock, Resack,
   Open a sack and the opening stock of a new rice all send the location. Adjust with no store is refused
   (`inventory.service.ts adjust`, `domain/movements.ts adjustStock`).
2. **A counter login changes only its own store** (`locationRefusal` in `people/people.service.ts`). It may
   move rice out of its store or into it, never between two other places. The owner and managers may act anywhere.
3. **The main store is only a fallback** for a request that names no store (an old copy of the app, the
   offline queue, a job). There is one look-up for it: `domain/main-store.ts` (`mainLocationId`, `mainLocation`).
   Do not write `warehouse.findFirst({ isDefault: true })` anywhere else.
4. **Reorder levels are per store.** Products → "Reorder at" is the main store's; each store's own level is
   set in Inventory → Adjust (`POST /admin/stock/reorder`).
5. **Low stock is per store** (`domain/low-stock.ts`): free stock at a store ≤ that store's level. Never the total of
   all stores. Supplier orders "To reorder" is the one whole-business view, on purpose (rice is bought for the business).
6. Seeing: a counter login sees other places' sack counts (decision 9), never money. Inventory opens on its own store.

## Retired

- `POST /admin/purchases` (Purchases screen): it added stock to the main store only, beside Stock in. Refused now.
- `/admin/pos/sell` and `/admin/pos/hold` sold from the main store whatever the login; they now follow rule 1-3.

Tests: `apps/api/src/inventory/store-separate.test.ts` (owner, Lipa counter, Bahay Tindahan counter at all four places),
`apps/api/src/domain/low-stock.test.ts`.

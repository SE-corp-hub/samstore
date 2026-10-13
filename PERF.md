# PERF.md — performance baseline and attempt ledger

Measured 2026-10-13 on this dev machine (Windows, API on localhost:4100, web on localhost:3000),
remote Supabase Postgres via the session pooler (`aws-0-ap-southeast-2`), `REDIS_URL` blank so all
caches are in-process.

## Baseline measurements (evidence)

### Frontend bundle (production build, parsed sizes as reported by Next 15)

| Route | Route size | First Load JS |
|---|---|---|
| `/` (storefront) | 3.44 kB | 106 kB |
| `/[slug]` (storefront) | 12.7 kB | 115 kB |
| `/admin/login` | 2.2 kB | 105 kB |
| **`/admin/dashboard`** | **95.4 kB** | **198 kB** |
| `/admin/delivery` | 3.76 kB | 106 kB |
| shared by all | — | 103 kB |

The dashboard's 95.4 kB route chunk is **all 22 panels plus jsbarcode and qrcode**, eagerly imported
(`AdminDashboard.tsx`, 22 static `import … Panel from`), for a screen that displays one panel at a time.

### API wall time per admin request (warm, 2nd+ call)

| Endpoint | warm call |
|---|---|
| `/admin/settings` | 1.2 s |
| `/admin/orders` | 3.5 s |
| `/admin/orders/counts` | 1.0 s |
| `/admin/analytics/status` | 1.1 s |
| `/admin/analytics/daily?days=7` | 1.1 s |
| `/admin/inventory?status=low` | 1.5 s |
| `/admin/pos/preorders` | 8.5 s |
| `/admin/credit/utang` | 3.5 s |
| `/admin/maintenance/stats` | 3.6 s |

Follow-up instrumented run (same day, different session): orders 2.7 s, preorders 3.2 s, settings 2.3 s,
utang 2.8 s — **nearly identical across endpoints**, i.e. dominated by fixed per-request overhead, not by
each endpoint's own work.

### Database floor

- Direct Prisma probe: first query **2.8 s** (cold handshake); warm `SELECT 1` **280–412 ms**, of which
  execution is ~6 ms → **~350 ms is network/pooler round-trip**.
- `pg_stat_statements` (cumulative, since reset): `DISCARD ALL` 8,484 (pgbouncer session resets);
  `UserStore` lookups 11,7xx and `Store.status` lookups 13,1xx (≈ one pair per admin request — the guard
  plus `resolveTenant`); **`OutboxEvent` SELECT 68,7xx** (a background drain polling far more often than
  user traffic).
- `SELECT name FROM pg_timezone_names` — 75 calls at **544 ms mean** — Prisma's per-connection init.

### Code-level facts

- Every admin request pays: `JwtAuthGuard` membership+store-status query → `resolveTenant` membership
  lookup → (for capability-set routes) `effectiveRoleSets` lookup → the endpoint's own query.
- Panel JS is eager (see bundle above).
- Switching tabs unmounts the previous panel and remounts the next (`renderTab()` switch) → **every tab
  switch refetches everything**, no client cache.
- Server side there is a 5 s TTL cache on some endpoints (`ttl-cache.ts`), in-process only (`REDIS_URL` blank).

## Identified bottlenecks (ranked by measured impact)

1. **Per-request authorization overhead** — ~2–3 extra DB round-trips × ~350 ms on *every* admin call.
2. **Eager panel JS** — 95.4 kB route chunk (22 panels + jsbarcode + qrcode) on the dashboard's first load.
3. **Refetch on every tab switch** — no client-side cache/dedupe; the same data is re-fetched per visit.
4. **Chatty background outbox poller** — 68.7k queries; holds/steals pooled connections that have only
   4 slots (`connection_limit=4`).
5. **Pooler/region round-trip floor (~350 ms/query)** — infra; caps what any code fix can achieve.

## Attempt ledger

| Idea | Baseline → Result | Verdict | Why |
|---|---|---|---|
| (baseline recorded, no optimizations attempted yet) | — | — | — |

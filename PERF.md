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

## Operator decisions (2026-10-13)

1. Client-side cache: **always-fresh** — no client TTL cache; each view re-fetches.
2. Server membership cache staleness: **accepted** (short TTL).
3. Infra: **apply pgbouncer mode** to the Prisma URL.
4. Scope: **include the public storefront and checkout**.

## Open items (next, in measured-impact order)

1. `/admin/pos/preorders` (2.4–5.8 s) and `/admin/maintenance/stats` (2.8–5.5 s) — no caching, budget of round-trips dominated by the pooler floor; needs an index/`EXPLAIN` look and a deliberate cache decision (they are not money-mutating reads).
2. Storefront server component fetches `/public/stores/:slug?token=` with `cache: "no-store"` on every view; the store payload is a candidate for a short server-side cache. Not yet measured (needs the public link token).
3. `REDIS_URL` is blank → every cache above is per-process and dies on restart. A real Redis removes that and shares the caches across instances.
4. The ~300 ms/query floor is the environment: Supabase session pooler in `ap-southeast-2` (Sydney) from the PH. Moving region, or the Pro plan with a nearer pooler, is the single largest remaining lever and is an operator/billing decision.

## Attempt ledger

| Idea | Baseline → Result | Verdict | Why |
|---|---|---|---|
| One shared, 10 s-cached membership lookup replacing the guard + resolveTenant pair | deterministic: `/admin/orders` 3 statements with **0** membership lookups (was 1 per request alongside the guard's own); `/admin/settings` shows 1 on a cache miss; wall-clock settings 805 ms → 11 ms on repeat calls | **kept** | Removes ~1–2 DB round-trips (~300 ms each) from every authenticated request. Verified with `scripts/perf-queries.mjs` (statement counts, not wall-clock — the pooler swings 2–3× run to run). Suites `tenant-context` 8/8 and `store-access` 11/11 still green. |

| Code-split the 22 admin panels (`next/dynamic`, `ssr:false`); keep the landing panel eager | `/admin/dashboard` route chunk **95.4 kB → 7.7 kB**; First Load JS **198 kB → 111 kB** (−44%); login untouched at 105 kB | **kept** | Deterministic build metric. jsbarcode/qrcode now ride inside the two panels that use them. E2E 10/10 across the panel-driven specs (pre-orders tab, user access, onboarding, login). |

| Idle backoff + enqueue wake for the outbox drain (was a fixed 5 s poll forever) | idle DB polls in 60 s: **12 → 2** (measured over a quiet 60 s window, cumulative `OutboxEvent` calls 74,175 → delta 12 then 2); new test proves an enqueue still drains within seconds with a 60 s backoff configured | **kept** | ~17k idle queries/day/process removed from a pooler with 4 slots, while real events now drain *immediately* instead of waiting up to 5 s. `outbox.service.test.ts` 4/4. |

| Cache PH address reference data + collapse each parent/child list into one relation-filtered query + `Promise.all` the four checkout lookups | regions **748–1840 ms → 1–10 ms**; provinces/cities 0–1 ms warm (first cities call 532 ms = one query, was two); `resolve()` 4 sequential round-trips → 1 | **kept** | This is the checkout address cascade the operator flagged: ~2–5 s of dropdown latency removed. Seeded reference data, 10 min TTL. `address.service.test.ts` 2/2. |
| `?pgbouncer=true` on the Prisma URL (operator-approved) | warm 5-run totals **2.7 s (before) → 16.3 s and 44.9 s (after)**, with `/health/ready` at 1.3–1.8 s (was 0.27 s) | **REVERTED** | This URL is the *session*-mode pooler (port 5432), where prepared statements work fine; disabling them cost 6–16×. Reverting restored 2.5 s / 8.0 s. Do not re-try on this connection string; it would only help on the transaction-mode pooler (port 6543). |

### Wall-clock probe results (noisy — see caveat)

`node scripts/perf-probe.mjs`, median of 3, before → after (typical run):

| Endpoint | before | after |
|---|---|---|
| `/health/ready` (raw query floor) | 304 ms | 272 ms |
| `/admin/settings` | 805 ms | 11 ms ¹ |
| `/admin/orders` | 1164 ms | 828 ms |
| `/admin/orders/counts` | 1025 ms | 16 ms ¹ |
| `/admin/analytics/status` | 1128 ms | 286 ms |
| `/admin/inventory?status=low` | 893 ms | 12 ms ¹ |
| `/admin/credit/utang` | 1668 ms | 547 ms |
| `/admin/maintenance/stats` | 2769 ms | 568 ms |
| `/admin/pos/preorders` | 2367 ms | 4269–5761 ms ² |

¹ In-process TTL cache hits (these endpoints already had a 5 s TTL); the run-to-run total varied 7.7–16.5 s, so treat sub-20 ms rows as cache, not as a measured speed-up of the endpoint itself.
² **Not attributable to this change** — pre-orders has no TTL cache and its runs swung 3.0–6.7 s across all measurements including the baseline. Tracked as an open item (find its query cost, then cache or index).
Caveat: the pooler's run-to-run variance (2–3×) exceeds the effect being measured for uncached endpoints, so the statement-count probe is the metric that decides keep/revert.

## 2026-10-31 — beta on Render + Neon: one round trip per wave, not per query

Probe from a GitHub runner against the beta: `/health` 95 ms, `/health/ready` (one `SELECT 1`) 270 ms,
`/health/metrics` (two queries in a row) 450 ms → **each query from the Render API to Neon
(Singapore) costs ~177 ms**; the API and the database are in different regions. So the number of
queries asked *one after another* decides every screen's speed.

Local reproduction: a TCP proxy adding 88 ms each way in front of Postgres, data sized like a busy
store (150 rice items, 4 locations, 400 customers, 14,400 sales / 28,800 lines). "Cold" = the first
call after 11 s (the 10 s auth caches expired), as when the tablet opens a screen between customers.

| Endpoint | before (cold) | after (cold) | sequential queries before → after |
|---|---|---|---|
| `/admin/benta/catalog` (the counter price list) | 2934 ms | 770 ms | 11–14 → 2 (+ Prisma's idle-connection `SELECT 1`) |
| `/admin/products` | 3173 ms | 745 ms | 10 → 2 |
| `/admin/customers` | 2073 ms | 923 ms | 6 → 2 |
| `/admin/settings` | 1789 ms | 546 ms | 6 → 2 |
| `/admin/utang/customers` | 1893 ms | 781 ms | 12 → 3 |
| `/admin/registers/current` | 903–1084 ms | 724–904 ms | 2 → 1 after the auth reads |
| `/admin/stores/mine` | 1078 ms | 719 ms | 5 → 2 |

| Idea | Verdict | Why |
|---|---|---|
| Prisma `relationJoins` (nested relations in the same SQL query) | **kept** | One query per relation level was the biggest multiplier (memberships 2, settings 3, products 6). Full suite identical before/after: 847 tests, 818 pass, the same 22 environment failures (RLS roles, customers-v4, zones, notifications, validate). |
| Guard asks token version, memberships and the store's role overrides together | **kept** | Three independent reads were sequential on every cold request. |
| `loadActor` reads the cached membership (home location added to it) | **kept** | One uncached query on every counter request; every membership write already busts the cache. |
| Counter catalog: one wave (locations, products, prices, stock + shelf cost, cost mode); most-sold counts cached 10 min | **kept** | Location, consignment main store and cost mode were asked one by one after the wave. The most-sold count only orders buttons. New test covers default/home/consignment/inactive/not-assigned. |
| `connection_limit` 4 → 10 (`DB_CONNECTION_LIMIT`) | **kept** | With ~177 ms per query, 4 connections made the 6-query catalog wait for a second wave. Neon direct allows ~100. |
| Orders list without `signatureData` | **kept** | Up to 200 signature pictures per list load; the screen reads the signature from `orders/:id`. |
| Indexes: `OrderItem(storeId, orderId)`, `OrderItem(storeId, productId)`, `Order(storeId, createdAt)`, `Order(storeId, storeCustomerId, createdAt)` | **kept** | `OrderItem` had no index: every receipt, order and the most-sold count read all of a store's sale lines (grows with every sale). |
| Calling the API directly instead of the web's `/backend` proxy (saves ~95 ms) | not tried | Needs CORS preflights per URL (more round trips) and Render refuses to wake a sleeping API through some paths; see connecting-stuck notes. |

Largest remaining lever is not code: put the database in the API's region (or both in Singapore).

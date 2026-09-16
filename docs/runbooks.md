# SAM STORE — Operations Runbook (Module 11)

All commands run from the repo root (`D:\opencode project`) in git-bash unless noted.

## Servers

| Server | Port | Start | Stop |
|---|---|---|---|
| API (NestJS) | 4100 | `cd apps/api && PORT=4100 npm run start` | kill the real listener (below) |
| Web (Next prod) | 3000 | `cd apps/web && npm run start` | kill the real listener (below) |

Killing an `npm run start` session only kills the npm wrapper — the child (tsx/next) survives and keeps the port. Always find + tree-kill the real listener:

```bash
PID=$(netstat -ano | grep LISTEN | grep ":4100 " | awk '{print $NF}' | sort -u | head -1)
MSYS_NO_PATHCONV=1 taskkill /F /T /PID $PID
```

Never rebuild `.next` while a `next start` is serving it (stale-chunk client errors). Order: kill → `rm -rf apps/web/.next` → `npx next build` → start → verify `dash=200` + BUILD_ID match.

## Gates

```bash
npm run typecheck     # contracts + api + web
npm test              # sequential runner (scripts/run-tests.mjs) — NEVER the raw node --test
                      # (it runs files concurrently and exhausts the Supabase pool: pool_size 15)
npm run test:cov      # same runner + node's built-in coverage (--experimental-test-coverage)
npm run test:e2e      # Playwright critical-path suite (needs both servers up on :3000/:4100)
npm run lint          # typecheck + secret/PII scan (filenames + categories only)
npm run check:secrets # secret scan alone (exit 1 on a HIGH finding)
npm run build
npm run db:validate
```

The runner globs `apps/api/src/**/*.test.ts` recursively — an earlier per-directory
pattern list silently skipped `persistence/`, `security/`, `orders/` and `public/`.

CI (`.github/workflows/ci.yml`): the `quality` job (schema validate, typecheck, secret
scan, build) runs on every push/PR with no database. The `db-tests` job runs the
sequential gate + `scripts/reconcile.ts` only when the `DATABASE_URL` repository secret
is configured; the Playwright job is manual (`workflow_dispatch`).

E2E suite (`apps/api/e2e/`): API health + public-link access control, admin login →
dashboard, and the full customer journey (storefront → cart → 3-step delivery COD
checkout → order placed → claim token single-use 200/409/409 + garbage 401). Single
worker only. Run order matters (01 → 03) but each spec is self-contained; 03 is
idempotent across re-runs (it claims the fresh order it just placed).

## Database (remote Supabase Postgres — no local Docker)

- Migrations are applied with `npx prisma migrate deploy` (non-interactive). `migrate dev` is interactive (needs a TTY) — prefer `migrate diff --from-schema-datasource … --to-schema-datamodel … --script` + a manual `prisma/migrations/<ts>_<name>/migration.sql` + `migrate deploy` when automating.
- After any schema change: **stop the API first**, then `npx prisma generate` (the query-engine DLL is locked by a running API → `EPERM`).
- P3015 (migration dir without migration.sql) = a failed interactive run left a stray dir → delete it and re-run.
- The pooler has a 5s interactive-transaction start timeout and `pool_size: 15`: don't open many concurrent interactive transactions (this is why `npm test` is sequential and why the checkout row-lock approach was replaced by guarded single-statement UPDATEs).

## Health

```bash
curl http://localhost:4100/health          # liveness (no DB)
curl http://localhost:4100/health/ready    # readiness (SELECT 1; 503 when degraded)
curl http://localhost:4100/health/metrics  # request counters + outbox backlog
```

`/health/metrics` reports request counts by status class, conflicts, 429s, and the
outbox backlog (`pending`, `processed`, `failed`, `oldestPendingSec`). A rising
`oldestPendingSec` means the worker is not draining — check the API process.

## Logging & request ids

Every request gets a `X-Request-Id` response header (a client-supplied id is accepted
only if it matches `[A-Za-z0-9._:-]{8,64}`) and one structured JSON line on stdout:
`{ts, level, msg:"request", requestId, method, path, status, durationMs}`.

Logs deliberately contain **no query string** — public links carry their access token
there — and never bodies, signatures, phone numbers or addresses. When chasing an
incident, grep by `requestId`.

## Cash drawer & shifts (N1)

One register per store; a **shift** is one cashier's session on it. Balances are derived
from the ledger — never stored as a mutable total.

```bash
# the open shift + live drawer totals
curl -H "Authorization: Bearer $TOKEN" -H "X-Store-Id: $STORE" http://localhost:4100/admin/registers/current

# open (opening float in minor units) / move cash / close
curl -X POST ... /admin/registers/open      -d '{"openingFloatMinor": 50000}'
curl -X POST ... /admin/registers/movements -d '{"type":"CASH_OUT","amountMinor":10000,"reason":"bank drop"}'
curl -X POST ... /admin/registers/close     -d '{"countedMinor": 69500,"notes":"short"}'

# reports (X = mid-shift, Z = closed shift)
curl ... "/admin/registers/report?kind=x"
curl ... "/admin/registers/report?kind=z&sessionId=<id>"
```

**Expected cash** = opening float + cash-in − cash-out + cash tenders − cash refunds.
FLOAT is the opening float (not double-counted); credit/e-wallet tenders are reported but
stay out of the drawer. A **close is a guarded single-statement write**, so two concurrent
closes cannot both succeed, and a closed shift rejects further movements.

**One open shift per store** is enforced by a partial unique index
(`RegisterSession_one_open_per_store`), so a concurrent double-open loses on the constraint
instead of creating two drawers.

`StoreSettings.requireOpenShift` (default **true** for stores created through the app)
blocks counter **cash** sales while the drawer is closed — credit sales never need a shift.
Stores with no settings row keep the previous behaviour (no gate). The POS panel shows the
shift bar; the payment step disables **Cash** when the drawer is closed.

Printing: the X/Z report prints on the **57 mm** roll (`@page { size: 57mm auto }`, body
hidden in print except `.register-report`).

## Split & partial payments + payment methods (N2)

Tenders are recorded through ONE command — `POST /admin/orders/:id/payments` with a
`tenders` array — so a single transaction writes every tender for an order:

```json
{ "idempotencyKey": "counter-2026-09-13-0007",
  "tenders": [ { "methodCode": "cash", "amountMinor": 30000, "tenderedMinor": 50000 },
               { "methodCode": "credit", "amountMinor": 30000 } ] }
```

Rules enforced server-side (422 validation / 409 conflict):

- Σ applied ≤ `outstanding` — overpayment is refused (`Tenders exceed the outstanding balance`);
- a **cash** tender may hand over more than it applies → the difference is `changeMinor`;
  non-cash tenders may not over-tender;
- methods flagged `requiresReference` (gcash/maya/bank transfer) must carry `reference`;
- a **credit** tender passes through `CreditService.sellOnCredit`, so the customer's limit
  guard applies to the credit portion only (and writes one `CreditEntry`);
- replaying the same `idempotencyKey` returns the ORIGINAL rows (no double charge);
- tenders taken during an open shift are attached to that shift — cash counts toward the
  drawer, the rest appears as non-cash takings on the X/Z report.

`GET /admin/orders/:id/payments` returns `{ payments, summary }` where the summary carries
`paidMinor / refundedMinor / outstandingMinor / changeMinor / settlement`
(`UNPAID | PARTIAL | PAID | OVERPAID`). **Settlement is derived from the payment rows on
every read — it is never stored**, so it cannot drift.

Payment-method registry: `GET /admin/payment-methods` (seeded on first use with
cash, credit, gcash, maya, bank_transfer) and `POST /admin/payment-methods` to add or
change one (manager+). Disabling a method immediately blocks its use; `code` is unique
per store.

Attribution of the other cash paths (refunds, admin-recorded payments, utang
settlements) uses `RegisterService.attachOpenSession` — a non-enforcing lookup that links
the row to the open shift when there is one and records `null` when the counter is closed.

## Reconciliation

Every stored BALANCE must equal its append-only LEDGER. One command checks all four identities and can repair them (dry-run by default, exit 1 on drift so it can gate a cron/deploy):

```bash
npx tsx scripts/reconcile.ts                     # report drift (all stores)
npx tsx scripts/reconcile.ts --apply             # correct drifted balances from the ledger
npx tsx scripts/reconcile.ts --store <storeId>
```

| Identity | Checked against |
|---|---|
| `Voucher.usedCount` | `count(VoucherRedemption)` |
| `StoreCustomer.loyaltyBalancePoints` | `sum(LoyaltyEntry.points)` |
| `StoreCustomer.creditBalanceMinor` | `sum(CreditEntry.amountMinor)` (+purchase / −payment) |
| `StockLevel.quantityOnHand` | ledger-implied balance (first movement's balanceAfter − delta, plus all deltas) |

Correction semantics: the ledger is authoritative, so the balance is rewritten TO the ledger and the correction is recorded as a **zero-delta `ADJUST` stock movement** (its note holds `onHand 7 → 5`). A non-zero delta would move the ledger sum and immediately break the identity again. Stock levels with no movements predate the ledger and are skipped.

## Order status / fulfillment

- Fulfillment is the explicit `Order.fulfillmentType` enum (PICKUP/DELIVERY, Module 3) — never trust `deliveryType` (Prisma defaults it to `delivery`).
- Delivery orders must reach COMPLETED only via courier DELIVERED; pickup/POS via `complete-now`/POS complete. A delivery order forced to COMPLETED is rejected server-side.
- Claims are single-use and consumed atomically (`updateMany WHERE usedAt IS NULL`).

## Tax / VAT (M4)

- **Operator decisions (locked 2026-09-14):** catalogue prices are **VAT-inclusive** (12% PH, `vatRateBp: 1200`); the store owner may **hide the VAT lines** on the printed slip (`vatShowOnReceipt` + the legacy `showVatLabel` — display only, totals never move); the **delivery fee is not VAT-able**; a voucher/loyalty **discount reduces the VATable base before tax**.
- **Where the numbers come from:** `apps/api/src/domain/tax.ts` (engine: per-line half-up rounding, exempt lines, discount allocation, delivery exclusion) and `domain/tax-store.ts` (the ONE reader of a store's VAT config + product exemptions used by every order writer).
- **Frozen columns:** every order carries `vatableMinor`, `vatMinor`, `vatExemptMinor`, `vatRateBp` (migration `20260914011029_module_m4_tax_engine`). Never recompute a receipt from the catalogue — print what the order froze.
- **The identity to check after any money change:** `vatableMinor + vatMinor + vatExemptMinor == subtotalMinor + deliveryFeeMinor − discountMinor` (inclusive mode) and `… == subtotal + vat + fee − discount` (exclusive). It holds in every mode, kill switch included — a break means a writer stopped freezing the breakdown.
- **Kill switch:** `vatEnabled = false` (or `vatRateBp = 0`) reproduces the pre-M4 totals exactly — the right first move when a tax figure is disputed.
- **Owner controls:** Settings → Tax / VAT (rate, inclusive flag, show-on-receipt, TIN); Products → "VAT-exempt product" switch + badge.
- **Proof on live data:** `node --import tsx scripts/probe-m4-vat.ts` → `PROBE GREEN` (inclusive extraction ₱112 → ₱100 + ₱12; ₱20 voucher → VAT ₱9.86 on the discounted base; ₱50 delivery fee untaxed and reported as non-VAT; hidden VAT keeps the total; kill switch identical totals; cross-tenant receipt 403). Unit contract: `apps/api/src/domain/tax.test.ts` (13 tests).
- **Regression trap:** a value spread into the in-memory `OrderRecord` is NOT persisted — patch `persistence/repositories.ts` AND both `prisma-repositories.ts` create mappings, then verify by reading the column back.


## Money invariants (do not regress)

- Integer minor units everywhere; server-authoritative totals; signatures required for credit/utang (validate `data:image/`, ≤2M chars).
- Void requires an unfulfilled, non-collected order; refunds are capped at the remaining captured amount; a CANCELLED order can never be voided/refunded again.
- Checkout is ONE transaction (order + stock reserve + cart + voucher + loyalty + credit) with guarded atomic UPDATEs for limits; the same idempotency key always returns the same order.

## Outbox (Module 9)

- Checkout enqueues `order.received`; the worker (started in `main.ts`, 5s poll) drains it to a `NotificationLog` row and marks PROCESSED (FAILED after 5 attempts with backoff).
- Check pending: `SELECT status, count(*) FROM "OutboxEvent" GROUP BY 1;` — a stuck PENDING with old `nextAttemptAt` means the worker isn't running (check the API process).

## Backup / restore / incident / rollback

- **Backup**: use the managed Postgres provider's snapshot/backup (Supabase dashboard / `pg_dump`). No local backups are configured — schedule a daily dump to an off-box location:
  `pg_dump "$DATABASE_URL" | gzip > backup-$(date +%F).sql.gz` (run from a machine with network access to the pooler; never log the connection string).
- **Restore**: create a fresh database, `pg_dump`-restore, point `DATABASE_URL` at it, `prisma migrate deploy` (all migrations replay), smoke-test `/health/ready`.
- **Migration rollback**: SAM STORE migrations are additive (expand → backfill → verify → contract). To roll back a bad forward migration: (1) keep the column/table but stop writing it, (2) backfill the old field from the new one, (3) drop the new constraint only after verification. Do NOT `migrate reset` against production.
- **Incident flow**: 1) `/health/ready` — if degraded, check the pool (connection limits → reduce concurrent work, e.g. stop background jobs), 2) check outbox backlog and failed events (`lastError`), 3) run `npx tsx scripts/reconcile.ts` (dry-run) to compare every balance against its ledger, 4) inspect `StockMovement` / `LoyaltyEntry` / `CreditEntry` / `VoucherRedemption` before deciding, 5) only after that evidence, `--apply`.
- **Rollback of a deploy**: `git revert <bad-commit>` or checkout the previous `main`, rebuild web (kill → rm .next → build → start), restart API.

## Verification checklist after any change

1. `npm run typecheck` && `npm test` (sequential) && `npm run build`
2. `npm run db:validate`; `prisma migrate status` when schema changed
3. Live probes: `/health/ready` 200; dashboard 200; a real POS sale writes a `StockMovement` row
4. Cross-tenant: a membershipless user gets 403; store A can't read store B (M1 tests)
5. `git diff --check` and a secret/PII scan before pushing

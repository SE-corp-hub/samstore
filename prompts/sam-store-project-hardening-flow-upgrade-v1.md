# SAM STORE — Project Hardening and Flow Upgrade Execution Prompt

You are a senior staff engineer auditing and upgrading **SAM STORE**, a multi-tenant Messenger commerce platform. Work inside the existing repository. This is not a greenfield rewrite.

## Mission

Analyze the current codebase from the live files, identify and rank correctness, security, commerce-flow, data-integrity, UX, accessibility, performance, testing, and operational gaps, then fix them in a safe sequence.

The priority order is:

1. Prevent cross-tenant access and privilege escalation.
2. Protect money, stock, credit, loyalty, vouchers, and idempotency under failure and concurrency.
3. Make order, payment, pickup, delivery, POS, hold, and preorder flows internally consistent.
4. Stabilize public/admin API contracts and validation.
5. Improve staff/customer UX and accessibility without replacing Bootstrap 5.3.
6. Add production gates, observability, and scalable query/cache behavior.

A passing legacy test suite is a baseline, not proof that concurrency or business invariants are correct.

---

## Mandatory operating rules

1. Read and obey `AGENTS.md` before doing anything else.
2. Inspect current files and trace each finding from controller/UI to service, database write, and test. Do not trust old prompts, comments, progress notes, or this prompt without re-verification.
3. **Phase 0 is analysis only. Do not edit application code during Phase 0.** Present the audit and the first proposed module, then wait for `CONTINUE`.
4. After approval, implement **one module per loop**:
   - write failing tests where practical;
   - implement the smallest coherent fix;
   - run format/lint/typecheck/tests/build/database checks;
   - run targeted live probes;
   - update `docs/progress.md`;
   - create a local git checkpoint if permitted;
   - report results and stop for `CONTINUE`.
5. Do not combine unrelated modules or perform optional refactors.
6. Preserve existing user changes. Do not commit unrelated or pre-existing working-tree files.
7. Do not push, deploy, rotate credentials, delete data, rewrite history, or run destructive migrations without explicit operator approval.
8. Never read, print, log, or commit secrets or customer data. Redact tokens, signatures, phone numbers, addresses, and connection strings.
9. Use managed PostgreSQL/Prisma and managed Redis. Do not introduce local Docker.
10. Bootstrap **5.3** remains mandatory. Do not add Tailwind, Material UI, Ant Design, or copied dashboard templates.
11. Messenger remains behind an adapter with a mock/suppressed provider. Do not make live Graph/Send API calls without explicit operator approval.
12. All money values remain integer minor units. Never trust client totals.
13. Operational multi-tenancy remains the model: shared database with mandatory `storeId` isolation, not one physical database per store.
14. Prefer incremental expand/backfill/verify/contract migrations. Every migration must include rollback or forward-recovery notes.
15. If a finding cannot be proved from current code or a test, label it a hypothesis and investigate before changing anything.

---

## Phase 0 — fresh no-edit audit

Run and record the real baseline:

```bash
git status --short
git branch --show-current
git log --oneline -5
npm run db:validate
npm run typecheck
npm test
npm run build
```

Also inspect:

- `AGENTS.md`, root/workspace `package.json` files, Prisma schema and migrations;
- app bootstrap/configuration and all auth/tenant guards;
- public storefront link resolution, cart, checkout, claim, customer auth;
- admin, POS, preorder, payments, refunds, credit, inventory, delivery, reports, notifications;
- shared contracts and runtime validation;
- Next.js storefront, dashboard navigation, high-risk forms/modals, mobile behavior;
- existing CI, lint, coverage, E2E, health checks, logging, metrics, cache, pagination, backup/migration runbooks.

For every confirmed problem, report:

- severity: `P0`, `P1`, `P2`, or `P3`;
- exact `path:line` evidence;
- affected flow and user/tenant;
- failure or abuse scenario;
- invariant that should hold;
- recommended module and tests;
- migration/compatibility risk.

Do not edit code until the operator approves the first module.

---

## Current audit leads — re-verify before acting

The following were observed in the repository when this prompt was created. They are investigation anchors, not permission to patch blindly.

### P0 — tenant and role authorization

1. **Unauthenticated owner registration can bind to a client-supplied store.**
   - `apps/api/src/auth/auth.controller.ts:37-42` accepts `storeId` on the public registration endpoint.
   - `apps/api/src/auth/auth.service.ts:41-70` creates a `STORE_OWNER` and an `OWNER` membership for that store.
   - Verify whether an attacker can submit another tenant's store ID and become its owner.

2. **Membershipless users fall back to a real demo tenant in multiple controllers.**
   - `apps/api/src/admin/admin.controller.ts:40` defines `DEMO_STORE_ID`; `:96-120` resolves users without an active membership to that tenant.
   - The same hard-coded tenant fallback appears in `apps/api/src/payments/payments.controller.ts:31-45`, `credit/credit.controller.ts:41-54`, `pos/pos.controller.ts:27-45`, `expenses/expenses.controller.ts:27-41`, `inventory/inventory.controller.ts:13-27`, `purchases/purchases.controller.ts:27-41`, and `reports/reports.controller.ts:21-34`.
   - Remove this as one shared authorization-class defect, not controller by controller. “No active membership” must deny access, not select a store.

3. **Global JWT role and per-store membership role are conflated across protected modules.**
   - `apps/api/src/admin/admin.controller.ts:53-71` authorizes privileged operations using the global token role.
   - `apps/api/src/admin/admin.controller.ts:103-120` then resolves only membership existence/status, not the role for the selected store.
   - `apps/api/src/auth/auth.service.ts:126-133` puts a global role and first membership into the JWT.
   - `apps/api/src/auth/auth.service.ts:263-271` changes the global user role when one store membership changes.
   - Payments, credit, POS, expenses, inventory, purchases, reports, and delivery repeat the same pattern: authorize with `user.role`, then separately resolve only an active membership. Examples: `apps/api/src/payments/payments.controller.ts:10-11`, `:31-58`; `apps/api/src/delivery/delivery.controller.ts:25-43`.
   - Verify a user who is OWNER in store A and STAFF or DELIVERY in store B cannot receive OWNER powers in store B, and that an old JWT cannot retain capabilities after membership deactivation or role reduction.

**Target invariant:** each protected request resolves one explicit tenant context and authorizes against that tenant's active membership role. Global platform administration is a separate explicit bypass. No demo/default tenant fallback is allowed.

### P0 — public links and production secrets

4. **The high-entropy public-link token appears unused.**
   - `prisma/schema.prisma:191-201` defines `PublicStoreLink` with slug, token, and status.
   - `apps/api/src/public/public-store.controller.ts:12-16` resolves only `:slug`.
   - `apps/web/src/app/[slug]/page.tsx:5-8` requests only the slug route.
   - Require the canonical public URL to validate both a human-readable slug and high-entropy token; support token rotation/revocation and avoid leaking whether a slug exists.

5. **Application secrets have development fallbacks.**
   - `apps/api/src/app.module.ts:46`, `:87-88`, `:101-117`, and `:157-163` include default signing/JWT secrets.
   - Production must fail to boot when required secrets are absent or weak. Development defaults must be explicitly gated to non-production environments.

6. **Public/auth endpoints appear to lack real rate limiting and comprehensive runtime validation.**
   - `apps/api/src/main.ts` should be checked for a global validation pipe, security headers, payload limits, and graceful shutdown.
   - `apps/api/src/checkout/checkout.controller.ts:5-6` states rate limiting is deferred to a future gateway.
   - Protect registration, login, password change, customer auth, cart mutation, checkout, public store lookup, and claim lookup.

7. **Single-use order claims may be raceable.**
   - `apps/api/src/orders/order-lookup.service.ts:30-45` reads `usedAt`, then updates in a separate operation.
   - Two simultaneous claims must not both succeed; consume with one conditional write/transaction.

### P0 — stock and checkout atomicity

8. **Online checkout does not visibly reserve or deduct stock.**
   - `apps/api/src/checkout/checkout.service.ts:146-168` revalidates catalog data but does not write stock.
   - `apps/api/src/persistence/prisma-repositories.ts:287-353` creates the order, items, history, and claim token, but no reservation/allocation.
   - Search current code for all `quantityReserved` writes; the earlier audit found reads but no checkout reservation write.

9. **One logical checkout spans many independent transactions.**
   - `apps/api/src/checkout/checkout.service.ts:239-315` allocates a sequence, creates the order, converts the cart, redeems the voucher, debits loyalty, and records credit in separate calls.
   - `apps/api/src/persistence/prisma-repositories.ts:287-353` only makes order persistence atomic internally.
   - A process/database failure between steps can leave an order without cart conversion, voucher redemption, loyalty debit, credit debt, or stock reservation.

10. **Idempotency is check-then-create rather than one concurrency-safe boundary.**
    - `apps/api/src/checkout/checkout.service.ts:77-99` checks first.
    - Creation occurs later at `:256-300`.
    - Parallel requests using the same key must return one order and the same claim token, not a unique-constraint error or duplicate side effects.

11. **Voucher, loyalty, and credit limits are raceable.**
    - Voucher count validation and redemption are separate: `apps/api/src/voucher/voucher-public.service.ts:11-55`.
    - Loyalty checks balance, then debits later: `apps/api/src/loyalty/loyalty.service.ts:83-127`.
    - Credit checks, then records later: `apps/api/src/credit/credit.service.ts:88-113`.
    - Parallel checkouts must never exceed stock, voucher usage, loyalty balance, or credit limit.

12. **Post-commit side effects can turn success into a client-visible error.**
    - Checkout awaits notification after writes: `apps/api/src/checkout/checkout.service.ts:317-320`.
    - Order transitions and delivery award loyalty/notify after the state transaction: `apps/api/src/admin/order-admin.service.ts:60-74`; `apps/api/src/delivery/delivery.service.ts:68-80`.
    - Use an outbox/job boundary with retries and idempotent consumers. Notification failure must not roll back or misreport a completed commerce command.

**Target invariant:** one accepted commerce command creates exactly one coherent result. On failure, all authoritative writes roll back; external side effects are queued transactionally. Concurrent requests cannot oversell or overdraw.

### P1 — payments, refunds, credit, and accounting

13. **Payment rows and order payment status can diverge.**
    - `apps/api/src/payments/payments.service.ts:15-43` creates a payment but does not reconcile/update order payment state.
    - `apps/api/src/admin/order-admin.service.ts:211-228` marks a pickup order `COLLECTED` without visibly creating a payment row.
    - `apps/api/src/delivery/delivery.service.ts:55-81` marks delivered COD as `COLLECTED` without visibly creating a collection payment.
    - Define one authoritative payment command/ledger and derive or transactionally maintain order payment status.

14. **Refund/void invariants are incomplete.**
    - `apps/api/src/payments/payments.service.ts:78-102` describes a same-day unfulfilled POS void but lacks explicit source/status/date checks in the service.
    - `apps/api/src/payments/payments.service.ts:105-124` does not visibly cap a refund at the remaining captured amount; partial refund behavior, repeated refunds, inventory return, and credit reversal need explicit rules.
    - Stock must never be restored twice or restored for a sale that never consumed it.

15. **Online credit recording is not idempotent or limit-safe under concurrency.**
    - `apps/api/src/credit/credit.service.ts:101-113` can create another debt entry and increment balance on repeated calls.
    - Add an order-linked uniqueness/idempotency invariant and perform the limit check plus increment atomically.

16. **Loyalty earning uses check-then-write without a database uniqueness guarantee.**
    - `apps/api/src/loyalty/loyalty.service.ts:49-80` checks for an existing EARN row before a later transaction.
    - Concurrent delivery completion paths must award once.

### P1 — fulfillment and workflow consistency

17. **`deliveryType` defaults to delivery and different flows infer fulfillment differently.**
    - `prisma/schema.prisma:513-554` defines the order fields; inspect the current default.
    - `apps/api/src/persistence/prisma-repositories.ts:296` also falls back to `"delivery"`.
    - `apps/api/src/admin/order-admin.service.ts:27-30`, `:185-208`, and `:211-228` use differing delivery predicates and shortcut paths.
    - Replace inference-by-address/default with a required, validated fulfillment enum after a safe data backfill.

18. **Store fulfillment settings are displayed but not fully enforced at checkout.**
    - `apps/api/src/checkout/checkout.service.ts:174-176` chooses delivery/pickup and fee.
    - Verify enforcement of `deliveryEnabled`, `pickupEnabled`, store timezone cutoff, minimum order, customer approval, and max open orders.
    - Settings such as `orderCutoff` and `maxOpenOrdersPerCustomer` are exposed in `apps/api/src/admin/store-settings.service.ts:8-20` but must be traced to runtime enforcement.

19. **Multiple services mutate order state independently.**
    - State changes exist in admin order service, POS completion, payments void/refund, and delivery service.
    - `apps/api/src/admin/order-admin.service.ts:185-208` synthesizes intermediate history while writing the final status directly.
    - Centralize commands/invariants so no endpoint bypasses transition, payment, stock, history, and notification rules.

20. **Closed-store public responses appear shape-inconsistent.**
    - `apps/api/src/public/public-store.controller.ts:19-35` returns a flat object when ordering is closed.
    - The normal response at `:37-72` is `{ store, products }`.
    - `apps/web/src/app/[slug]/page.tsx:17-18` expects the normal shape.
    - Keep one stable contract for active, paused, suspended, and closed states.

### P1 — data model integrity

21. **Duplicated `storeId` columns are not enough if cross-tenant foreign-key combinations remain possible.**
    - Review `ProductImage`, `StockLevel`, `CartItem`, `Payment`, `OrderItem`, `OrderStatusHistory`, `OrderClaimToken`, `CreditEntry`, and other store-owned child models in `prisma/schema.prisma`.
    - Add service validation and, where practical, composite database constraints/foreign keys so a child row cannot declare store A while referencing a parent from store B.

22. **Legacy and current stock/membership concepts overlap.**
    - `prisma/schema.prisma:231-258` includes both legacy single stock-level linkage and multi-warehouse stock levels.
    - Review `UserStore` and `StoreMembership` responsibilities and remove duplicated sources of truth only through a migration-compatible module.

23. **Customer identity uniqueness/ownership needs a policy.**
    - `prisma/schema.prisma:599-633` should be checked for individual normalized email/phone uniqueness and cross-store profile behavior.
    - A store administrator must not accidentally mutate a globally shared customer identity in a way that changes another store's view.

### P2 — frontend UX, accessibility, and maintainability

24. **Most modals are hand-rendered Bootstrap markup without complete dialog behavior.**
    - Examples: `apps/web/src/components/admin/OrdersPanel.tsx:680-984`, `CustomersPanel.tsx:347-539`, `PosPanel.tsx:358-409`, and `AdminDashboard.tsx:165-174`.
    - Verify `role="dialog"`, `aria-modal`, accessible title/description, close-button labels, initial focus, focus trap, Escape, backdrop behavior, scroll locking, and focus restoration.

25. **Large components mix API orchestration, state machines, validation, and presentation.**
    - Earlier measured anchors: `apps/api/src/admin/admin.controller.ts` ~1169 lines, `OrdersPanel.tsx` ~988, `PreOrdersPanel.tsx` ~813, `PosPanel.tsx` ~681, `StoresPanel.tsx` ~668.
    - Split only where it reduces correctness risk: shared typed API client, domain hooks, reusable accessible modal/form primitives, and focused views. Do not perform cosmetic rewrites.

26. **Client authentication tokens are stored in browser storage.**
    - Admin token: `apps/web/src/app/admin/login/AdminLogin.tsx:58-60` and `apps/web/src/lib/admin.ts:52-54`.
    - Customer token: `apps/web/src/components/CustomerAccount.tsx:13-18`.
    - Evaluate a secure HttpOnly cookie/session design with CSRF protection and a staged migration. At minimum, establish CSP/XSS defenses and session expiry/revocation.

27. **Errors/loading/empty states and form accessibility are inconsistent.**
    - Add actionable inline errors, `aria-live` announcements, `aria-invalid`/described-by links, disabled/pending submit states, retry paths, focus-to-error, and stable empty states.
    - Preserve mobile-first cards and Bootstrap responsiveness; test keyboard-only, screen-reader semantics, 320 px mobile, tablet, and desktop.

### P2 — testing, operations, performance

28. **The baseline has backend tests but little/no browser E2E or component coverage.**
    - Root `package.json:17-18` runs Node tests and TypeScript checks.
    - Establish critical Playwright E2E, accessibility checks, coverage thresholds, and deterministic test data on a dedicated managed test database/branch.

29. **No repository CI workflow or lint gate is present.**
    - `.github/workflows` is absent, and root `package.json:10-24` has build, test, typecheck, and Prisma scripts but no lint, format-check, coverage, or browser-E2E gate.
    - Add CI for install lockfile integrity, Prisma validation/migration safety, typecheck, lint/format, unit/integration tests, E2E smoke, and production build.

30. **Production health and observability are incomplete.**
    - `apps/api/src/main.ts:10-17` only creates the Nest app, enables permissive reflected-origin CORS, listens, and logs the URL; it has no separate liveness/readiness checks, config validation, global runtime validation, security headers, payload limits, graceful shutdown, structured/redacted logs, request IDs, metrics, or error reporting.
    - Add reconciliation alerts for negative stock, reservation drift, payment/order mismatch, voucher overuse, loyalty mismatch, and credit-limit breaches.

31. **The in-process TTL cache is not multi-instance safe.**
    - `apps/api/src/persistence/ttl-cache.ts:11-32` uses a process-local unbounded `Map` with lazy expiry and per-process invalidation.
    - Move suitable read caching to managed Redis with store-scoped keys/versioning and reliable invalidation. Never cache authoritative money/stock mutation decisions.

32. **List endpoints need consistent bounded pagination.**
    - `apps/api/src/admin/admin.controller.ts` includes a hard `take: 200` orders query; other customer/product lists should be checked for unbounded reads.
    - Standardize cursor pagination, filter validation, deterministic ordering, totals only when explicitly needed, and suitable composite indexes.

---

## Target architecture and invariants

Evolve incrementally toward these boundaries; do not rewrite the platform at once.

### Request boundary

Every request follows:

1. authenticate principal;
2. resolve explicit tenant context;
3. load active per-store membership and role;
4. authorize the named capability;
5. runtime-validate and normalize input;
6. execute one domain command;
7. commit authoritative writes in one database transaction;
8. enqueue external side effects through an outbox;
9. return a typed, stable response/error.

### Commerce command boundary

Create explicit idempotent commands for at least:

- checkout order;
- reserve/release/consume stock;
- change order status;
- capture/settle/refund/void payment;
- create/settle credit debt;
- redeem/earn loyalty;
- redeem voucher;
- dispatch/complete/fail delivery.

Do not let controllers or UI code encode business transitions.

### Stock invariants

- `available = onHand - active reservations` is never negative.
- The last unit can be committed by only one concurrent transaction.
- A hold/order reserves once; cancellation/expiry releases once; fulfillment consumes once.
- POS immediate sale consumes stock atomically with order/payment.
- Editing an order applies only the net allocation delta.
- Every stock mutation has a store-scoped, actor-attributed movement/audit record.

### Money and ledger invariants

- Sum of captures minus refunds/void reversals reconciles to order payment state.
- Collected status cannot exist without a corresponding authoritative ledger event.
- Refunds cannot exceed the remaining captured amount.
- Credit balance equals its ledger and never exceeds the approved limit.
- Loyalty balance equals its ledger and never becomes negative.
- A voucher never exceeds its redemption limit.
- Every retryable write has an idempotency key or database uniqueness invariant.

### Order and fulfillment invariants

- Fulfillment type is explicit (`PICKUP` or `DELIVERY`), never inferred from a defaulted string or address.
- Delivery requires enabled delivery, valid address, and the correct fee/routing.
- Pickup requires enabled pickup, no delivery fee, and no dispatch state.
- Every state change goes through one state machine and writes one honest history event per actual transition.
- Cancellation, void, refund, failed delivery, retry, and completion each have explicit stock/payment/credit effects.
- Store timezone, cutoff, ordering status, minimum amount, approval rules, and open-order limit are server enforced.

---

## Required implementation sequence

Do not begin a later module until the preceding module is verified and approved.

### Module 1 — tenant authorization and registration closure (`P0`)

- Remove public client-controlled store ownership binding and demo-tenant fallback.
- Before implementation, ask the operator to choose the intended owner onboarding model:
  1. **recommended initially:** invite/admin-created owner only; or
  2. public signup atomically creates a brand-new store owned by that user.
- Add a centralized tenant context/capability guard using the selected store's active membership role.
- Separate platform role from per-store role; handle multi-store users correctly.
- Add an endpoint-by-role-by-tenant authorization matrix and cross-tenant write/read tests.

### Module 2 — public access and API edge security (`P0`)

- Enforce slug + high-entropy public token, status, rotation, and revocation.
- Make claim-token consumption atomic.
- Add runtime DTO schemas at all boundaries, secure production config validation, security headers, body limits, rate limiting, and safe error responses.
- Plan a secure browser-session migration; do not break current clients without a compatibility path.

### Module 3 — database integrity foundation (`P0/P1`)

- Add the minimum schema support for tenant-consistent relations, explicit fulfillment, stock reservation/movement, idempotent ledger events, and transactional outbox.
- Use expand/backfill/verify/contract migrations; inspect live data before tightening constraints.
- Provide reconciliation queries before and after migration.

### Module 4 — stock reservation and movement engine (`P0`)

- Standardize online, POS, hold, preorder, edit, cancel, void, refund/return, and purchase replenishment semantics.
- Use conditional writes/locking at the database boundary, not read-then-update checks.
- Add concurrency and rollback tests.

### Module 5 — atomic checkout (`P0`)

- In one transaction: validate current store/fulfillment, reprice, enforce stock/settings, claim idempotency, allocate sequence, reserve stock, create immutable order/items/history/claim, convert cart, and create all required voucher/loyalty/credit/outbox records.
- Concurrent same-key requests return the same order; different-cart reuse is rejected.
- No external network call runs inside the transaction.

### Module 6 — voucher, loyalty, and credit concurrency (`P0/P1`)

- Enforce limits transactionally and add database uniqueness/idempotency guarantees.
- Add parallel-request tests for last voucher use, last loyalty points, and remaining credit.
- Add reconciliation and repair tooling with dry-run default.

### Module 7 — payments, utang, voids, and refunds (`P1`)

- Create one authoritative payment/credit ledger command layer.
- Specify full/partial capture, change, COD collection, credit purchase, credit settlement, partial/full refund, same-day void, return-to-stock, and reversal behavior.
- Preserve required customer signatures without logging/exposing signature blobs.
- Make all commands idempotent and actor-audited.

### Module 8 — unified order/fulfillment workflow (`P1`)

- Route admin, POS, preorder, delivery, void/refund, and “pay then send for delivery” through one domain state machine.
- Remove synthetic/skipped history and inconsistent delivery predicates.
- Enforce delivery/pickup settings, address/fee, cutoff, approval, and open-order limits.
- Define retry behavior after failed delivery and cancellation after dispatch.

### Module 9 — public/storefront contract and customer flow (`P1`)

- Stabilize active/paused/closed/suspended response shapes.
- Normalize customer identity/contact rules and cross-store privacy.
- Explain price/availability changes before final submit.
- Give retry-safe checkout confirmation and order tracking without exposing reusable credentials.

### Module 10 — admin/storefront UX and accessibility (`P2`)

- Build reusable accessible Bootstrap modal/form primitives.
- Add keyboard/focus behavior, labels, live errors, pending states, empty/retry states, and destructive-action clarity.
- Reduce risky component size only along tested domain boundaries.
- Test staff-critical flows at 320 px, tablet, desktop, keyboard-only, and automated accessibility checks.

### Module 11 — quality, observability, performance, and operations (`P2`)

- Add lint/format, coverage, CI, Playwright critical E2E, dedicated managed test data, and migration checks.
- Add health/readiness, graceful shutdown, structured redacted logging, request IDs, metrics, error reporting, outbox worker monitoring, and reconciliation alerts.
- Replace process-local shared cache assumptions with managed Redis where appropriate.
- Add cursor pagination and indexes backed by query evidence.
- Document backup/restore, migration recovery, incident, and rollback procedures.

---

## Required flow test matrix

Each relevant module must add tests at service/API level and, for critical user journeys, browser E2E.

1. Guest delivery COD: valid public link → cart → checkout → reserve → prepare → dispatch → deliver → collect COD → consume stock.
2. Guest pickup: checkout → ready → counter payment → complete, with no delivery fee/state.
3. Approved online utang: atomic order + debt, within limit; signature policy explicitly enforced where required.
4. POS cash: order + stock + payment atomic; correct tender/change.
5. POS utang: customer, limit, dates, signature, order, stock, and ledger atomic.
6. Hold/preorder: reserve once; edit net delta; expiry/void release once; finalize consumes/captures once.
7. Delivery-tagged staff payment: Complete asks for delivery; Yes captures and routes to `OUT_FOR_DELIVERY`; No follows the explicitly allowed pickup/counter behavior.
8. Cancellation before fulfillment releases reservation exactly once.
9. Same-day void versus later refund follows distinct, audited policies.
10. Partial and full refund cannot exceed remaining captured amount.
11. Failed delivery retains correct payment/stock state and supports the approved retry/cancel path.
12. Duplicate/retried request produces one business effect.
13. Two concurrent buyers for the last unit: one succeeds, one receives a conflict.
14. Concurrent last voucher use, loyalty redemption, and credit-limit use cannot overdraw.
15. Store A cannot read/write store B through any ID/header/path substitution.
16. A multi-store user gets only the role granted in each selected store.
17. Missing/wrong/revoked public token reveals no storefront.
18. Paused/suspended/closed store returns a stable UI-safe response and rejects checkout.
19. Notification/provider failure leaves the committed order correct and schedules a retry.
20. Reconciliation jobs report zero unexplained stock/payment/credit/loyalty drift after all flows.

Do not call an E2E test “passed” if it uses fabricated responses. Use real local services and a safe dedicated test tenant/database; clearly label mocks for external providers.

---

## Verification gate for every module

At minimum, run and paste summarized real output from:

```bash
npm run db:validate
npm run typecheck
npm test
npm run build
```

Also run:

- the module's focused tests, including concurrency and negative cases;
- cross-tenant tests when any query/auth code changes;
- Prisma migration status/diff checks when schema changes;
- targeted live API probes;
- browser E2E for affected UI flows;
- `git diff --check` and a final scoped diff review;
- a secret/PII check that reports only filenames/categories, never secret values.

If a gate fails, report and fix the root cause before claiming completion. Never replace unavailable execution with plausible output.

---

## Reporting format

### Phase 0 report

1. Baseline commands and exact pass/fail counts.
2. Architecture and flow map.
3. Prioritized risk register with `path:line` evidence.
4. Confirmed findings versus hypotheses.
5. Proposed scope and acceptance tests for **Module 1 only**.
6. Decisions/blockers requiring operator input.
7. End with: `Waiting for CONTINUE.`

### Module completion report

1. What changed and why.
2. Invariants now enforced.
3. Tests added and real gate output.
4. Live verification evidence using redacted identifiers.
5. Migration/data impact and rollback/recovery note.
6. Git checkpoint hash if authorized.
7. Remaining risks, without starting the next module.
8. End with: `Waiting for CONTINUE.`

The objective is not more features. It is a coherent, tenant-safe commerce system whose stock, money, credit, loyalty, order history, fulfillment, and user-facing state remain correct under retries, failures, concurrency, and multi-store authorization.

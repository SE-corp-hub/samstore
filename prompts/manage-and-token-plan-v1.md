# SAM STORE — Token-Efficiency + "Manage" Flow Plan (v1)

Status: **PLAN ONLY — nothing implemented.** Written 2026-09-13.
Owner: operator. Executor: agent. Read this file instead of re-reading the repo.

---

## 0. How to use this document (the point of it)

This file is the **context carrier**. Starting a fresh session with "read
`prompts/manage-and-token-plan-v1.md` then do M3" costs ~8K tokens and needs zero repo
exploration. Re-deriving the same knowledge from the repo costs 60–150K tokens per session.

Rules for every future session:
1. Open with this file, not with `find`/`grep` sweeps.
2. Do **one module per `CONTINUE`** — the module table (§5) names the exact files, so no
   discovery is needed.
3. Update §8 (TODO) and the module status table in §5 when a module lands, then commit both
   with the module commit. This is the only doc that must stay current.

---

## 1. Token economy — what actually burns tokens here (measured)

### 1.1 Measured drivers (real numbers, this repo)

| Driver | Measured | Cost per occurrence |
|---|---|---|
| Full test gate (`node scripts/run-tests.mjs`) | 42 files · 280 tests · **12–15 min** | ~15K tokens of output; the log is ~47KB |
| One test file in isolation | 30–60 s | ~1–3K tokens |
| Full E2E (`npx playwright test`) | 8 specs · **2.7–2.9 min** | ~2K tokens + 3 min wall time |
| `npm run typecheck` | ~60–90 s | 1 line when clean (`grep -c "error TS"`) |
| Web rebuild (`next build` + restart) | 1.5–3 min | ~2K tokens |
| Re-reading a big file in full | `OrdersPanel.tsx` 67KB · `admin.controller.ts` 56KB · `pos.service.ts` 35KB · `schema.prisma` 34KB | 15–25K tokens **each** |
| Repo-wide recon with `find`/`grep` sweeps | ~12 tool calls | 10–40K tokens |
| Compaction event | ~1M-token window | loses detail → forces re-reading |

Source inventory (for sizing): `apps/api/src` 115 files/684KB · `apps/web/src` 51 files/481KB ·
tests 42 files/230KB · `docs` 40KB · `prisma` 86KB. Biggest files are the web panels and
`admin.controller.ts` — those are the ones to never read whole.

### 1.2 The 12 rules (each one is enforced by a habit, not willpower)

| # | Rule | Saves |
|---|---|---|
| T1 | **Anchor-read, never full-read.** `grep -n "<symbol>" <file>` → `sed -n 'A,Bp'` for the exact block. Read whole files only if <300 lines. | 10–20K tokens/read |
| T2 | **Filter every long command in the same call.** Gates: `\| awk '/^# (files\|tests\|pass\|fail)/'` → one summary line. Typecheck: `\| grep -c "error TS"`. Never paste a raw log. | 10–15K/gate |
| T3 | **Targeted suite first, full gate once per module.** `node --import tsx --test <file>` while iterating; the full gate only at module end. | 2–5 runs × 10K |
| T4 | **Batch recon into one `execute_code` call** with several `terminal()` greps — one round-trip instead of 8–12. | 8–20K/session |
| T5 | **Probes over poking.** One tsx probe printing 10 labelled evidence lines replaces ~10 exploratory curl/tool calls. Probes are kept and re-run (they are the regression net). | 5–15K/module |
| T6 | **Restart servers once per module**, at the end. Source changes need no restart until verification (`tsx` from source, `next start` for a built artifact). | 2–4K/module |
| T7 | **Skip E2E for API-only modules** (the probe is the proof). Run E2E only when a `.tsx` file changed. | 2K + 3 min |
| T8 | **Don't run `prisma format`** (rewrites the whole schema = huge diff + review cost). Verify a hand edit with `prisma migrate diff … --script` → expect "This is an empty migration." | 5–10K + review |
| T9 | **Append to docs with `patch`, never read them whole.** `progress.md` is 25KB; patch by unique anchor. | 6–8K/doc |
| T10 | **One module per session.** Fresh session + this plan ≈ 8K tokens of startup vs ~100K of drift + compaction loss in a 1M-token session. | 50–100K/session |
| T11 | **Delegate only reads, never writes.** A subagent that returns ≤20 filtered lines (e.g. "list every place `deliveryType` is still read") beats a parent doing 10 greps. Never delegate a module. | 10–30K |
| T12 | **Money/tests stay real.** Never stub a gate; fake output costs a full re-verification cycle later (the most expensive token class there is). | prevents rework |

### 1.3 Per-module token budget (use these to spot a runaway module)

| Module size | Files touched | Expected tokens | Red flag |
|---|---|---|---|
| S — single service/UI fix + tests | 1–3 | 40–80K | >150K |
| M — service + API + tests + probe | 4–7 | 120–220K | >350K |
| L — schema + migration + API + web + tests + probe | 8–14 | 250–450K | >600K |

Measured baselines from this project: N1 (L) ≈ one full session ≈ ~400K incl. build/restart;
N2 + N1-risk-fixes (L) ≈ ~350K. Applying T1–T7 to N2 would have removed ~80K (repeated full
file reads, two redundant full gates, the `prisma format` churn).

### 1.4 Verification that "token saving" is real (don't take it on faith)

At the end of each module record in `docs/progress.md` one line:
`tokens≈<n>K · gate runs=<n> · probe=<yes/no> · E2E=<yes/no> · full-reads=<n>`.
Three modules in, the table shows the trend. If `full-reads` > 2 for an M module, T1 was broken.

---

## 2. Current build — grounded snapshot (2026-09-13)

### 2.1 What exists and is verified

- **Stack**: npm workspaces · `apps/web` (Next.js 15 + Bootstrap 5.3) · `apps/api` (NestJS +
  Prisma 6.19.3) · `packages/contracts` · `prisma` (remote Supabase Postgres, pool_size 15) ·
  `docs/` · `prompts/`.
- **Schema models (41)**: `PlatformUser User UserStore Store StoreSettings PublicStoreLink
  StoreCounter Category Product ProductImage Warehouse StockTransfer StockLevel Cart CartItem
  NotificationLog Payment PaymentMethod Register RegisterSession CashMovement Expense Purchase
  PurchaseItem LoyaltyEntry Voucher VoucherRedemption Order OrderItem OrderStatusHistory
  OrderClaimToken Customer StoreCustomer CreditEntry StoreStatusHistory PasswordResetHistory
  StoreMembership AuditLog StockMovement OutboxEvent`.
- **Hardening 1–11**: tenant authz (per-store role via `resolveTenant`, no fail-open demo
  store), public access (slug+token, atomic claim), DB integrity (composite `(storeId,id)` FKs,
  `StockMovement`, `OutboxEvent`), stock ledger, atomic checkout, concurrency guards, void/refund
  caps, unified fulfillment (`fulfillmentType`), transactional outbox, a11y modals, ops
  (`/health`, `/health/ready`, `/health/metrics`, reconcile, runbook, CI).
- **Audit remediation fixes 1–5**: guarded stock writes (`InsufficientStockError` → 409),
  outbox inside the checkout transaction, runtime DTO validation at 9 boundaries, ledger
  reconciliation incl. voucher/loyalty/credit, observability (request ids, redacted logs,
  counters, `check-secrets.mjs`, CI workflow).
- **E2E**: 8 Playwright specs (health, access control, admin login, delivery checkout+claim,
  pickup, 2× responsive, POS shift).
- **Gates today**: unit **42 files · 280 tests · 280 pass · 0 fail**; E2E **8/8**; typecheck 0
  errors; `/health` ok; migrations "up to date".
- **Counter upgrade so far**: **N1** cash drawer/shifts/Z-report (`0a5d2b4`) incl. risk fixes,
  **N2** split & partial payments + payment-method registry (`6307c3e`).

### 2.2 Known gaps / debt (verified by probing the schema and code, not assumed)

| Gap | Evidence |
|---|---|
| N2 has **no UI** | nothing in `apps/web` posts a `tenders` array; POS `sell` takes one method |
| **No tax model** | `grep Tax prisma/schema.prisma` → 0; no per-product exempt flag |
| **No product barcode / unit** | `Product` fields: id, storeId, categoryId, sku, name, description, priceMinor, costMinor, isActive (+relations) — no barcode, no unit |
| **No supplier master** | `Purchase.vendor` is a free-text `String?` |
| **No accounting accounts / rules** | `Expense.category` free text; no `Account` model |
| **No stock-adjustment history / stock-flow screen** | `InventoryPanel.tsx` = 134 lines; no adjustment-history UI |
| **Thin reports** | `ReportsPanel.tsx` = 170 lines, only Payment split / Utang aging / Top customers |
| **Single-page settings** | `SettingsPanel.tsx` = 320 lines (Store + POS/Receipt) vs NexoPOS's 7 sections |
| Dev DB fixture debris + drifted balances | `npm run fixtures:cleanup --apply` + `npm run reconcile --apply` still pending operator go-ahead |
| No ESLint config; cache/rate-limit are process-local (no managed Redis) | documented in the risk list |

---

## 3. "Manage" vs NexoPOS — can we copy their flow?

**Verdict: yes — copy the FLOW, never the code.** NexoPOS is GPL-3.0 (copyleft) and
Laravel/Vue/Tailwind; this repo is commercial SaaS on NestJS/Next + Bootstrap 5.3. So: read
their navigation + screen order, restate it in our words, implement natively. The screens below
were read from their real menu definition (`app/Services/MenuService.php` +
`app/Classes/AsideMenu.php`), not from marketing pages.

Our Manage group is exactly: **Orders · Credit Ledger · Products · Inventory · Expenses ·
Purchases · Team · Customers · Vouchers** (`NAV_GROUPS` in `apps/web/src/lib/admin.ts`).

### 3.1 Their menu (verbatim structure, condensed)

```
Dashboard | POS | Orders → [List, Payment Types, Assigned Orders] | Medias
Customers → [Create, Groups, Create Group, Reward Systems, Create Reward, Coupons, Create Coupon]
Providers → [Create] | Accounting → [Create Expense, Transaction History, Rules, Accounts, Create Account]
Inventory → [Create Product, Print Labels, Categories, Create Category, Units, Create Unit,
             Stock Adjustment, Adjustment History, Scale Range, Stock Flow Records]
Taxes → [Groups, Taxes, Create Tax] | Modules → [Upload, Marketplace]
Users → [List, Create, Roles, Create Role, Permissions Manager]
Procurements → [List, New Procurement, Products]
Reports → [Sales, Sales Progress, Customers Statement, Stock (low), Stock History, Sold Stock,
           Incomes & Losses, Transactions, Annual, Sales By Payments]
Settings → [General, Medias, POS, Customers, Orders, Accounting, Reports, Invoices, Reset, About]
```

### 3.2 Mapping + gap verdict per Manage tab

| Our Manage tab | Their equivalent | What their FLOW adds that we lack | Verdict |
|---|---|---|---|
| **Orders** | Orders (+ Payment Types, Assigned Orders) | payment-type registry (**we just built it in N2** ✓), rider assignment screen | keep ours; add rider assignment later (P2) |
| **Credit Ledger (utang)** | none (utang lives in Customers + Statements) | nothing — ours is **better** (explicit ledger + aging) | keep ours |
| **Products** | Inventory → products/categories | **Print Labels**, **Units / Unit groups**, barcode field | adopt barcode + units (P1), label printing lands with N6 |
| **Inventory** | Stock Adjustment + **Adjustment History** + **Stock Flow Records** | the whole adjustment workflow *as a screen* — we own the `StockMovement` ledger but never expose it | **adopt (P0)** — highest value per token |
| **Expenses** | Accounting → transactions + **Rules** + **Accounts** | accounts (cash/bank/ewallet) and auto-rules; expense → account link | adopt light version (P2): account enum + category master |
| **Purchases** | Procurements (+ **Providers master**) | supplier master record instead of free text | adopt Suppliers (P1) |
| **Team** | Users + Roles + **Permissions Manager** | a roles × permissions **matrix screen** | adopt (P1) — we already enforce roles server-side |
| **Customers** | Customers + **Groups** + Reward Systems + Coupons | customer groups/tiers; rewards (we have loyalty + vouchers already) | adopt groups (P2), skip rewards (covered) |
| **Vouchers** | Customers → Coupons | nothing material | keep ours |
| *(no tab)* | **Taxes** | tax groups + rates with inclusive/exclusive + BIR-style breakdown | **adopt (P0)** = module N4 in our own prompt |
| *(no tab)* | **Reports (10 screens)** | one screen per question, each with a date range; ours is 3 widgets | adopt 4–5 of them (P1) |
| *(no tab)* | **Settings (7 sections + own sidebar)** | sectioned settings with per-section save, not one long page | adopt (P1) |
| *(no tab)* | Medias / Modules / Scale Range | media library, module marketplace, weighted-goods ranges | **skip** (out of scope for a PH SaaS; revisit only if asked) |

### 3.3 Flow patterns worth copying verbatim (behaviour, not code)

1. **List + Create as sibling entries** — their sidebar pairs every list with its create action.
   Ours relies on in-panel buttons; add a "New …" entry point where mobile reach matters.
2. **Sidebar counters** (their `AsideMenu::menu(..., counter: …)`) — a count badge per group.
   We have tab badges already; extend them to the group header (pending orders, low stock).
3. **Adjustment workflow**: product → current stock shown → delta + reason → confirm → movement
   written → row visible in Adjustment History, and the same fact readable as a Stock Flow
   Record (ledger view). Copy this exact 5-step shape.
4. **Sectioned settings with per-section save** — `/dashboard/settings/<section>`; we can do
   `?section=` in `SettingsPanel` with one save bar per section (no schema change).
5. **Print Labels as a batch action from the product list** (select products → label sheet) —
   pairs with the 57×40 mm label design in N6.
6. **Permissions Manager as a grid** — roles down, permissions across, toggles that persist.
   We already have `TENANT_ROLES` + per-endpoint guards; the screen makes the policy visible.
7. **Reports as standalone screens with a date range** — not dashboard widgets.

---

## 4. Suggestions backlog — everything worth implementing (ranked)

Ranking = value ÷ (token cost + risk). Token cost uses §1.3 (S/M/L).

### P0 — do next (high value, low risk)

| # | Suggestion | Why now | Size | Tokens |
|---|---|---|---|---|
| P0.1 | **Split payments in the real money paths** — POS `sell` + hold-complete accept a tender list, Orders Pay modal gets tender rows (see M1, §5: the N2 endpoint has no UI caller) | N2 is API-only; the operator can't use split payments yet | L (4 steps) | 180–260K |
| P0.2 | **Stock Adjustment + Adjustment History + Stock Flow Records screens** (NexoPOS Inventory flow) | ledger exists (`StockMovement`), UI missing — closes the biggest Manage gap with zero schema risk | M | 150–200K |
| P0.3 | **N6 receipts & labels** (57 mm receipt CSS is already there from N1; add the label sheet) | pairs with P0.2, operator explicitly wants printing | M | 130–190K |
| P0.4 | **Finish the risk list**: reconcile + fixture cleanup apply, ESLint config, managed-Redis decision | small, removes recurring confusion (drifted dev DB already caused a false alarm) | S | 60–100K |

### P1 — next wave

| # | Suggestion | Notes | Size | Tokens |
|---|---|---|---|---|
| P1.1 | **N4 tax engine (PH VAT 12% incl./excl. + per-product exempt, BIR breakdown)** | schema + receipt + reports; unblocks BIR-correct receipts | L | 250–400K |
| P1.2 | **Product barcode + unit fields** (`barcode` unique per store, `unit` text, `soldByWeight`) | prerequisite for N8 scanning and for "per kilo" PH products | M | 130–200K |
| P1.3 | **Suppliers master** (replace `Purchase.vendor` free text; keep the string as a fallback) | purchases/receiving gets real reporting | M | 120–180K |
| P1.4 | **Roles × permissions matrix screen** (NexoPOS Permissions Manager flow) | server-side enforcement already exists; this is UI + an audit trail | M | 140–200K |
| P1.5 | **Reports expansion** (Stock/low-stock, Sold stock, Income & Loss, Sales by payment, Customer statement) with date ranges | pure read-only aggregation; low risk, high perceived value | M | 150–220K |
| P1.6 | **Sectioned Settings page** (`?section=pos|receipt|orders|taxes|invoices`) | reuses existing endpoints; pairs with P1.1 | S–M | 90–140K |

### P2 — later / optional

| # | Suggestion | Notes |
|---|---|---|
| P2.1 | Rider/assigned-orders screen (`/admin/delivery` exists; add assignment + proof-of-delivery) | needs a rider-master decision first |
| P2.2 | Customer groups/tiers (NexoPOS Groups) | loyalty + vouchers already cover most value |
| P2.3 | Expense accounts (cash/bank/ewallet) + category master | light accounting; feeds Income & Loss |
| P2.4 | N3 per-line refunds / partial returns (our own prompt, Module 3) | needed once line-level returns are requested |
| P2.5 | N5 barcode-first POS (focus-trapped scan input) | depends on P1.2 |
| P2.6 | N7 capability permissions + sensitive-action approval (void/refund/discount approval) | depends on P1.4 |
| P2.7 | N9 instalment schedules for utang, N10 counter reporting | after N4 + reports |

### Explicitly NOT doing

NexoPOS **Medias**, **Modules/Marketplace**, **Scale Range**, **Reward Systems** (covered by
loyalty/vouchers), **multi-register**. Also: no Tailwind, no GPL code, no local Docker, no
customer-facing self-registration.

---

## 4.5 Verified constraints (checked against the code — do not re-derive)

These were read out of the source on 2026-09-13 while planning. They change some of the
module designs below, so re-check only if you touch the same area.

**Money paths (decisive for M1).**
- The Pay button in `OrdersPanel.tsx` calls **`POST /admin/pos/holds/:id/complete`**
  (~line 362), *not* `/admin/orders/:id/payments`.
- **Nothing in `apps/web` calls `/admin/orders/:id/payments`** — that N2 endpoint is
  API-only (probes + tests). Grep confirms 0 UI callers.
- `apps/api/src/pos/pos.service.ts` writes exactly ONE payment row per sale:
  `sell()` at :167 (payment.create at :241) and `completeHold()` at :471 (payment.create at :540).
  Both set `method: "cash"`, `changeMinor`, `registerSessionId`.
- Request contracts: `PosSellRequest` (`packages/contracts/src/index.ts:150`) and
  `PosHoldCompleteRequest` (:179) both carry `paymentMethod: "cash" | "credit"` + `tenderedMinor?`.
- Delivery orders reach payment through the same `completeHold` (`OrdersPanel` line ~386
  opens a delivery-confirm modal for `isDelivery` orders).

**Stock ledger (decisive for M2).**
- `domain/movements.ts` exports only `recordMovement`, `deductStock`, `restoreStock`,
  `InsufficientStockError`. **There is no generic adjust helper** — M2 must add one.
- `MovementInput.type` is a free `String`; the canonical set is in its comment:
  `RESERVE | RELEASE | CONSUME | ADJUST | RECEIPT | TRANSFER_IN | TRANSFER_OUT | VOID_RESTORE`.
- `StockMovement` has **no `reason` field** — a reason goes in `note`; it does carry
  `balanceAfter` and `warehouseId`.
- `type: "ADJUST"` is already written in 4 places — `admin/product-admin.service.ts:161`
  ("product edit stock"), `admin/warehouse.service.ts:51` and `:59` ("manual stock set"),
  and `domain/reconcile.ts:229/:264` — all with `createdBy: null`. M2 reuses this mechanic
  (promote it to a first-class, actor-attributed adjustment) instead of inventing a new one.
- No stock/movement HTTP routes exist yet (`@Get|@Post` for stock/movements → none).
- `InventoryPanel.tsx` (134 lines) reads `GET /admin/inventory?…` (filters, sort, value).

**Tax (decisive for M4).**
- `Order` money columns are `subtotalMinor`, `deliveryFeeMinor`, `discountMinor`,
  `totalMinor` + `snapshot Json`. **No tax columns.**
- Checkout identity: `deliveryFee = pickup ? 0 : store.deliveryFeeMinor`
  (`checkout.service.ts:177`); voucher/loyalty discount at :201–:223;
  `finalTotal = totals.totalMinor − discountMinor` (:223).
- The order snapshot is written in **four** places — `pos.service.ts:145` (sell),
  `pos.service.ts:465` (hold), `checkout.service.ts:272`, `order-admin.service.ts:171`
  (item edit, which also recomputes `totalMinor`). Any tax field must be handled in all four.

**Web plumbing.**
- `apps/web/src/lib/admin.ts` exposes `adminHeaders()` and `fetchAdminOrders()` — there is
  **no generic POST helper**; new calls use `adminHeaders()` + `fetch`.
- E2E specs are numbered `01…06` in `apps/api/e2e/` → new UI spec = `07-*.spec.ts`.
- OrdersPanel anchors: Pay state at :106–:108 (`payHold/payMethod/tendered`),
  validation `payValidated()` at :349, submit at :359, Pay buttons at :405 and :436,
  Pay modal JSX at :799+.

---

## 5. Next-to-do plan — ordered modules (one per `CONTINUE`)

Order logic: **finish what is half-built → close the biggest Manage gap → do what the operator
asked for by name → then the heavy schema work**. Each module below is designed so a fresh
session needs zero discovery: the file list is the brief.

### M1 — Split payments in the REAL money paths · P0.1 · L (4 steps) · ~220K
**Why the scope changed:** the old plan said "add tender rows to the orders Pay modal" — but
that modal posts to `/admin/pos/holds/:id/complete`, and `/admin/orders/:id/payments` has **no
UI caller at all** (§4.5). Implementing the old plan would have built a UI nobody uses.

**Goal**: the operator can take a multi-tender payment from POS quick-sale and from the Orders
Pay modal, served by ONE writer for payment rows.

- **Step 1 — one writer (domain, no behaviour change).** Extract the tender application out of
  `SplitPaymentService.recordTenders` into `apps/api/src/payments/tenders.ts`:
  `applyTenders(tx, { storeId, orderId, actorId, tenders, idempotencyKey? })` returning the rows
  written + `changeMinor`. `SplitPaymentService` and both POS paths call it. Existing N2 tests
  must stay green untouched — that is the proof the refactor was behaviour-preserving.
- **Step 2 — POS accepts tenders.** `PosSellRequest` + `PosHoldCompleteRequest`
  (`packages/contracts/src/index.ts:150/:179`) gain an optional
  `tenders?: { methodCode; amountMinor; tenderedMinor?; reference? }[]`. When absent, build a
  one-row list from today's `paymentMethod` + `tenderedMinor` (backward compatible — old clients
  and the E2E specs keep passing). `pos.service.ts` `sell()` (:167, payment.create :241) and
  `completeHold()` (:471, :540) stop writing the payment row inline and delegate to
  `applyTenders`. Keep: shift attribution, `changeMinor` on the response, credit → `sellOnCredit`.
- **Step 3 — UI tender rows.** OrdersPanel Pay modal (:799+): rows of
  `method (from GET /admin/payment-methods) · amount · cash tendered · reference`, live
  `Remaining`/`Change`, plus the existing utang signature block when a `credit` row exists.
  Payment buttons at :405/:436 and the delivery-confirm branch (:386) stay as they are. New
  helpers in `lib/admin.ts`: `fetchPaymentMethods()`, using `adminHeaders()` (no generic POST
  helper exists).
- **Step 4 — proof.** E2E `apps/api/e2e/07-split-payment.spec.ts`: open shift → POS sell with
  cash+gcash → assert both tender rows and the drawer's `cashSalesMinor`; then a second save
  showing `PARTIAL → PAID`. Extend `scripts/probe-n2-split-payments.ts` with a
  `sell(…tenders)` leg so the API path is covered by a probe too.
- **Named acceptance tests**: `split.tenders.ts` (replay/idempotency, overpay, change, credit
  limit, shift attribution) + POS regressions `pos.service.test.ts` (17 existing must stay
  green) + `07-split-payment.spec.ts`.
- **Rollback**: Step 1+2 are additive (a `tenders` field nobody sends yet) — revert the commit
  and the old single-method path returns. No migration in this module.
- **Explicitly out of scope**: splitting a DELIVERY order's COD collection across tenders later
  in its lifecycle (that stays on the order-level endpoint until M2's screens land).

### M2 — Stock Adjustment + Adjustment History + Stock Flow Records · P0.2 · M · ~190K
- **Goal**: expose the `StockMovement` ledger as an operator workflow (NexoPOS Inventory flow).
- **Key de-risk (§4.5)**: the mechanic already exists — `warehouse.service.ts:51/:59` performs a
  guarded level upsert + an `ADJUST` movement with `balanceAfter`. M2 promotes that into a
  first-class, **actor-attributed, reason-carrying** adjustment instead of inventing a ledger path.
- **New server code**:
  - `domain/movements.ts` gains `adjustStock(tx, { storeId, productId, warehouseId?, delta,
    reason, actorId })`: upsert the `StockLevel`, write `type: "ADJUST"` with `balanceAfter`,
    `createdBy: actorId`, `note: reason` (there is no `reason` column — §4.5), and refuse a
    negative result with `InsufficientStockError` unless the caller passes `allowNegative: true`
    (stock-take correction, manager+ only, recorded in the audit log).
  - `apps/api/src/inventory/inventory.service.ts` (+ `.test.ts`): `adjust()`, `history()`,
    `flow()` (filters: product, type, from/to, warehouse, actor), each tenant-scoped.
  - `apps/api/src/inventory/inventory.controller.ts` (new — no stock routes exist today):
    `POST /admin/stock/adjust`, `GET /admin/stock/adjustments`, `GET /admin/stock/movements`
    (manager+ for the POST, VIEW for the reads), DTO rules for every field.
- **UI** (`InventoryPanel.tsx`, 134 lines — safe to read fully): a per-row "Adjust" action opening
  the 5-step flow (product → **current stock shown** → delta ± reason → confirm → the new row
  appears in history); a "History / Flow" view with the filters above; warehouse selector seeded
  from the existing warehouses endpoint.
- **Named acceptance tests**: `adjustStock` respects the guard (reject over-draw), records
  `balanceAfter` correctly on both directions, attributes the actor, requires a reason; history
  and flow are tenant-isolated (cross-tenant 404); `scripts/reconcile.ts` reports **0 drift**
  after adjustments (that is the ledger-integrity proof).
- **Probe**: extend `scripts/probe-stock-guard.ts` (or a new `probe-adjustments.ts`) — adjust
  +5, adjust −3, assert level/ledger/`balanceAfter` and the cross-tenant denial.
- **Rollback**: additive routes + a new service; no schema change. Reverting restores the
  warehouse-only path.

### M3 — Receipts & labels (N6) · P0.3 · M · ~160K
- **Goal**: 57 mm receipt polish + 57×40 mm product labels (browser print CSS only, no bridge).
- **Touch**: `apps/web/src/app/globals.css` (extend the existing print block),
  `ReceiptModal.tsx`, a new `LabelSheet.tsx`, `ProductsPanel.tsx` (batch select → Print labels).
- **Deliverable**: receipt shows the tender breakdown from M1 (method lines + change) and the
  TIN/address block the operator configured; label sheet = N per row with name, price, SKU,
  barcode (needs M5; print SKU until then).
- **Tests**: E2E print-preview assertion (element order), probe not needed (no API).

### M4 — Tax engine, PH VAT (N4) · P1.1 · L · ~340K
- **Goal**: correct VAT + BIR-shaped receipts, without breaking the existing money identity.
- **Decisions to lock BEFORE coding** (ask the operator if unclear — do not guess):
  1. Are catalogue prices **VAT-inclusive** (PH retail norm) or exclusive? Default: **inclusive**.
  2. Does the **delivery fee** carry VAT? Default: **no** (separate service line, still printed).
  3. Are **vouchers/loyalty discounts** applied **before** tax (tax on the discounted amount)?
     Default: **yes** — discount reduces the VATable base.
- **Schema** (`prisma/schema.prisma`, hand-edited — never `prisma format`, §6.2):
  - `StoreSettings`: `vatEnabled Boolean @default(true)`, `vatRateBp Int @default(1200)` (basis
    points = 12.00 %), `pricesIncludeVat Boolean @default(true)`, `tin String?`.
  - `Product`: `taxExempt Boolean @default(false)`.
  - `Order`: `vatableMinor Int @default(0)`, `vatMinor Int @default(0)`, `vatExemptMinor Int @default(0)`
    (explicit columns — reports must be able to SUM them; detail also goes into `snapshot.tax`).
  - Migration name: `module_m4_tax_engine`. Apply with `prisma migrate deploy`, then prove parity
    with `prisma migrate diff … --script` → *"This is an empty migration."*
- **Domain** `apps/api/src/domain/tax.ts` (+ `tax.test.ts`): pure functions
  `computeLineTax(line, { rateBp, pricesIncludeVat, taxExempt })` and
  `summarizeTax(lines, opts)` → `{ vatableMinor, vatMinor, exemptMinor, grossMinor }`.
  **Rounding rule (write it in the runbook): round per line to the nearest centavo, then sum** —
  never round the total (BIR-friendly and reproducible).
- **Identity to preserve** (checkout `:223`, `:268–:272`): with `pricesIncludeVat = true`,
  `totalMinor = subtotalMinor + deliveryFeeMinor − discountMinor` stays **unchanged**, and
  `vatMinor` is *extracted* from it. With exclusive pricing,
  `totalMinor = subtotalMinor + vatMinor + deliveryFeeMinor − discountMinor`. Assert this identity
  in a test for both modes — it is the single most likely regression.
- **Four snapshot writers must all carry tax** (§4.5): `pos.service.ts:145` (sell),
  `pos.service.ts:465` (hold), `checkout.service.ts:272`, `order-admin.service.ts:171`
  (item edit — also recomputes `totalMinor`; recompute tax there too or the receipt lies after
  an edit).
- **UI**: `SettingsPanel` gains a Tax section (enabled, rate, inclusive flag, TIN);
  `ProductsPanel` gains the per-product "VAT-exempt" toggle; `ReceiptModal` prints the BIR block:
  `VATable Sales / VAT (12%) / VAT-Exempt Sales / Zero-Rated / Total`, plus the store TIN and
  receipt number. `PosPanel` shows the tax line in the cart total when exclusive.
- **Named acceptance tests**: inclusive extraction (12 % of a ₱112.00 line = ₱12.00),
  exclusive addition, exempt product, mixed cart (vatable + exempt), rounding on a ₱0.99 × 3 line,
  voucher-before-tax, delivery fee excluded, and the four identity assertions.
- **Rollback**: additive columns with defaults (`vatEnabled` can be turned off in settings, and
  the identity test proves totals are untouched when it is off) — that is the safety valve.

### M5 — Product barcode + unit · P1.2 · M · ~150K ✅ DONE
- **Touch**: schema (`Product.barcode String?`, `Product.unit String?`, `soldByWeight Boolean`),
  migration incl. `@@unique([storeId, barcode])`, products API + panel, POS search by barcode.
- **Deliverable**: scan-or-type a barcode to add a line; "per kilo" products sell in decimal qty.
- **Depends**: nothing. **Unblocks**: N8 scanning, M3 labels with real barcode.

### M6 — Suppliers master · P1.3 · M · ~150K ✅ DONE
- **Touch**: `Supplier` model + migration, `Purchase.vendorId` (keep `vendor` text as legacy
  fallback), purchases API/panel autocomplete, receiving shows the supplier.
- **Rule**: backfill existing `vendor` strings into `Supplier` rows per store (idempotent script).

### M7 — Roles × permissions matrix · P1.4 · M · ~170K
- **Touch**: `TENANT_ROLES` (already enforced) + a `RolePermission` model (storeId, role, key,
  allowed) + matrix UI in `UserAccessPanel.tsx`; every guard reads the matrix with a
  default-permissive fallback so nothing breaks when a row is absent.
- **Rule**: never widen a role silently; changes are audit-logged.

### M8 — Reports expansion · P1.5 · M · ~190K ✅ DONE
- Five screens with date ranges: Stock (low), Sold stock, Income & Loss, Sales by payment,
  Customer statement. Read-only aggregates; one service per report + one test each; no schema.
  Web panel updated with tabbed views and date range pickers.

### M9 — Sectioned Settings · P1.6 · S–M · ~110K ✅ DONE
- `SettingsPanel` gains `?section=general|pos|receipt|orders|taxes|invoices` with one save bar
  per section; reuses existing endpoints (+ M4's tax section).

---

## 6. Safe execution — the protocol that prevents the known failure classes

### 6.1 Per-module loop (do not deviate)

```
1 PLAN      read this file's module block only (§5) + anchor-read the files named
2 SCHEMA    (L modules) hand-edit, then: prisma validate + migrate diff → "empty migration"
3 DOMAIN    service + tests; run the FILE only: node --import tsx --test <file>
4 BOUNDARY  controller + DTO rule for EVERY field (unruled fields are dropped silently)
5 UI        anchor-read the panel; declare all hooks before any early return
6 PROBE     one tsx script printing labelled evidence lines; clean up in `finally`
7 GATE      node scripts/run-tests.mjs | awk one-line summary  (ONCE)
8 BUILD     only if web changed: kill :3000 → rm -rf .next → build → start → chunks 200
9 RESTART   API once (from apps/api!): kill :4100 → PORT=4100 npm run start
10 E2E      only if a .tsx changed
11 DOCS     patch progress.md (+ this file's status/TODO) — no full reads
12 COMMIT   one module = one commit = one push; message = what/why/invariants/gate numbers
```

### 6.2 Failure classes seen in this project → the pre-flight check

| Failure class | Symptom | Check/fix |
|---|---|---|
| DTO strips unruled fields | "at least one X is required" for a field you sent | every field needs a rule; arrays need `kind:"array"` |
| Nested rule errors swallowed | invalid nested object accepted (`ok:true`) | outer check must forward nested errors (fixed in `validate.ts`) |
| Server started from repo root | `npm error Missing script: "start"`, then `ECONNREFUSED` | `cd apps/api` first; read the api log before debugging the app |
| Port held by a child | EADDRINUSE / stale code serving | `netstat -ano \| grep LISTEN \| grep ":4100 "` → `taskkill /F /T /PID` |
| Stale "watch pattern" notes | "API listening" for a dead wrapper | trust the listener check, not the notification |
| Pooler session cap | `EMAXCONNSESSION` / `P2028` | one test process at a time; sequential queries; keep the global 30s tx budget |
| FK-breaking test cleanup | `NotificationLog_storeId_fkey` at `store.deleteMany` | delete children by `storeId` (outbox, notifications, register rows, payments) before the store |
| POS tests blocked by the shift gate | 409 "No open shift" | fixture sets `requireOpenShift: false` |
| Unique/collision fixtures | random slug collision | use a monotonic `slugSeq`, not `random % n` |
| `prisma format` or edit of an applied migration | giant diff / checksum drift | never format; never edit applied SQL — add a follow-up migration |
| E2E claim token already used | 409 on first claim | make specs idempotent; scrape THIS order's token |
| Reconciliation phantom drift | on-hand off by the reserved qty | exclude `RESERVE` from the on-hand identity |

### 6.3 Definition of done (all must be real output, never asserted)

1. targeted tests green · 2. full gate one-line summary pasted · 3. probe output pasted ·
4. E2E (UI modules) · 5. typecheck `0` · 6. `docs/progress.md` + this file updated ·
7. commit + push · 8. report: what changed, invariants, evidence, gaps, next.

### 6.4 Risk register (per module) — what can go wrong and the mitigation

| Module | Main risk | Mitigation | If it goes wrong |
|---|---|---|---|
| M1 | refactor silently changes money behaviour | N2 + POS suites must pass **untouched** after Step 1; add the `sell(tenders)` probe leg before touching the UI | revert Step 1 alone (pure refactor commit) |
| M1 | two writers for payment rows (old inline + new helper) | delete the inline `payment.create` in `sell`/`completeHold` in the same commit as the wiring | grep `payment.create` in `pos.service.ts` → must be 0 |
| M2 | adjustment writes a balance without a movement | `adjustStock` is the ONLY writer; test asserts ledger-vs-balance and `reconcile.ts` = 0 drift | run `scripts/reconcile.ts` (dry-run) before committing |
| M2 | negative stock hides a mistake | guard rejects by default; `allowNegative` only for manager+ stock-take, audit-logged | flip the flag off; the movement row is the audit trail |
| M3 | print CSS breaks the N1 report | extend the existing print block, never re-scope `@page`; E2E print assertion | re-check the X/Z report print first |
| M4 | **money regression** (identity change) | identity test for inclusive AND exclusive mode; `vatEnabled=false` reproduces today's numbers exactly | flip `vatEnabled` off — totals return to the current behaviour with no code change |
| M4 | tax recomputed differently in 4 writers | one `summarizeTax` domain function, all four call it; test each writer path | reconcile order totals vs snapshot in a probe |
| M5 | barcode collisions across stores | `@@unique([storeId, barcode])`, nullable (multi-null is fine in Postgres) | drop the index in a follow-up migration |
| M6 | supplier backfill duplicates rows | idempotent backfill keyed by `(storeId, lower(name))`; run dry-run first | delete the created `Supplier` rows, `vendor` text is untouched |
| M7 | permission matrix silently widens access | default-permissive fallback + audit-logged changes + a test that a missing row == today's behaviour | delete the matrix rows (behaviour reverts) |
| M8/M9 | read-only/UI-only | no schema, no money | revert the commit |

### 6.5 Definition of Ready (before starting any module)

1. The module block in §5 + §4.5 constraints pasted into the session (that IS the brief).
2. Servers state known (`/samstatus`) and the API is on the code you think it is.
3. For schema modules: the migration name chosen + the operator decisions listed in the block
   answered (M4 has three — ask, don't guess).
4. The acceptance test names from the block written down first (test-first where practical).
5. Nothing else in flight: no other DB-heavy run, no uncommitted work from another module.

---

## 7. TODO checklist (copy one line per session)

```
M1  Split payments in the REAL money paths  (4 steps: one writer -> POS tenders -> UI -> E2E)
[x]   M1.1 extract applyTenders into payments/tenders.ts (N2 tests stayed green, behaviour preserved)  `d5cfe78`
[x]   M1.2 PosSellRequest/PosHoldCompleteRequest accept tenders[]; sell/completeHold delegate  `9befef5`
[x]   M1.3 OrdersPanel Pay modal tender rows (split toggle, per-row method/amount/change/reference, live Remaining)  (this commit)
[x]   M1.4 e2e/07-split-payment.spec.ts (real staff flow)  (this commit)
[x] M2  Stock Adjustment + Adjustment History + Stock Flow screens (reuse the existing ADJUST path)  `e485126` + (this commit)
[x] M3  Receipts & labels (57mm + 57x40mm label sheet)  (this commit)
[x] M4  Tax engine — PH VAT 12% incl/excl + exempt, BIR receipt, 4 snapshot writers  (this commit)
[x] M5  Product barcode + unit fields (+POS scan input)
[x] M6  Suppliers master (+ backfill Purchase.vendor)
[x] M7  Roles x permissions matrix screen
[x] M8  Reports expansion (5 screens with date ranges)
[x] M9  Sectioned Settings page
[x] R1  Ops: reconcile --apply + fixtures cleanup --apply — DONE 2026-09-14 (0 drift; fixtures swept; KAPE-001 stock at -79 needs manager intake)tures)
[x] R2  ESLint config (flat config, TS + react hooks) wired into `npm run lint`
[x] R3  Managed Redis (Upstash) — async Redis layer with in-process fallback (`redis.ts` + migrated ttl-cache/rate-limit). Operator: add REDIS_URL to .env to activate
[x] R4  Failed-delivery retry policy + post-dispatch cancellation rules
```

**Ordering rationale (why this sequence).** M1 finishes a shipped-but-unreachable feature and
removes a duplicate money writer; M2 needs no schema and closes the biggest Manage gap; M3 is
operator-requested and reuses N1's print CSS; M4 is the only heavy money change and is safest
*after* M1 unified the payment writer; M5 unblocks labels/scanning; M6–M9 are independent.
If the operator picks out of order, honour it — the loop in §6.1 is module-agnostic.

**Dependencies (hard).** M1 ← nothing · M2 ← nothing · M3 ← M1 (receipt shows tenders) ·
M4 ← M1 (one payment writer) and M9 optional · M5 ← nothing · M6 ← nothing · M7 ← nothing ·
M8 ← M4 for the tax report line only.

---

## 8. Session protocol (token discipline, both directions)

**Start a session with:** `read prompts/manage-and-token-plan-v1.md, do <Mx>, follow §6`.
**End a module by:** updating §5 status + §7 checkbox + `docs/progress.md`, then commit both.
**Never** re-derive the repo layout, re-read the hardening prompt, or re-audit a module that
already has a gate number recorded here.

If a module's token use exceeds the §1.3 red flag, stop and report the cost rather than
continuing — runaway exploration is the single biggest token sink in this project.

---

## 9. Command palette (installed, verified)

A real Hermes plugin registers these in-session slash commands (no shell memorisation):

| Command | Does | When |
|---|---|---|
| `/sam` | **bundle** — loads `sam-store-dev` + `systematic-debugging` + `dev-server-lifecycle` | first thing in a new session |
| `/samstatus` | ports + PIDs, `/health` + metrics (5xx/conflicts/outbox), git HEAD + dirty count, last gate, plan progress | session start, before/after a restart |
| `/samplan [M1..M9\|todo]` | the TODO checklist, or one module's brief from §5 | picking the next module |
| `/samsnapshot` | token-cost snapshot: biggest files, area sizes, test source, probe count | when a session feels expensive |
| `/samdesign [screen]` | UX/UI brief: Bootstrap 5.3 constraint, skills to load, a11y + verification checklist | before any UI work |
| `/samdebug` | evidence pack: git, worktree, ports, health, api-log tail (redacted), failing tests | when something breaks |
| `/samgate [status\|<file>]` | full gate **detached** (12–15 min) → `/samgate status`; a single test file runs inline | T3 discipline |
| `/samprobe [n1\|n2\|stock\|all]` | live API probes, filtered to the evidence lines | after any API change |
| `/samrestart [api\|web\|both]` | tree-kill the port holder, restart from the right cwd, verify | after edits (T6) |
| `/sambuild [check]` | detached web rebuild + restart → `/sambuild check` (BUILD_ID match + chunk 200s) | after any `.tsx` change |

Implementation: `$HERMES_HOME/plugins/samstore/` (`plugin.yaml`, `__init__.py`, `sam_ops.py`,
`sam_read.py`, `sam_actions.py`). Read-only by default; long work is detached so a command never
blocks the chat; log output is credential-redacted. Validate any change with
`hermes plugins validate <dir>` (it runs `register()` in isolation).
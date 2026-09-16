# SAM STORE — Peddlr-Inspired Upgrade Prompt (v1)

**Use this prompt to upgrade the existing SAM STORE project.** It is a *specification + instruction set*,
not an implementation. Paste it into Hermes (or any agent) in a new session from the project root.

**Reference:** Peddlr (mobile POS + store management app for PH micro-merchants).
**Main goal (carried from the current project):** *"Order from your phone. A fast, mobile-first
storefront. No app, no sign-up."* — the customer-visible product must stay exactly that: a phone-first
public ordering link. The Peddlr-style merchant features live on the ADMIN/OWNER side (also
mobile-first, touch-friendly), never at the expense of the guest ordering flow.

---

## 0. Operator decisions (locked 2026-09-03 — do not re-litigate)

1. **Credit (utang)**: available at ONLINE checkout, but ONLY for approved store customers with a
   pre-set credit limit (per store settings). POS can also sell on credit (staff-initiated).
2. **VAT**: display-only label on receipts ("prices VAT-inclusive, 12%") — no tax computation, no BIR reports.
3. **Online payments**: COD only (as today). No GCash/bank options.
4. **DELIVERY role**: sees ALL out-for-delivery orders (no per-order assignment), marks
   DELIVERED / FAILED_DELIVERY (+ reason). SALES_AGENT keeps its existing delivery powers.
5. **POS voids/refunds**: full void (same-day cancel) + refunds at POS are IN SCOPE for P1/P2.
6. **Loyalty**: POS sales earn points normally; utang (credit) earns only after FULL payment.
7. **Receipts**: browser-print view now; 58/80mm thermal via Android print service noted as a LATER module.
8. **Legacy stock**: the upgrade MUST migrate warehouse-less stock rows into each store's default
   warehouse so inventory sums stay correct.
9. **Reports visibility**: OWNER + MANAGER see profit/expense/COGS; STAFF/SALES_AGENT see sales/orders only.
10. **Offline/PWA**: later phase. v1 requires connectivity.

## 0b. Role

You are a senior full-stack engineer (NestJS + Next.js + Prisma + Bootstrap 5.3) upgrading an existing,
working multi-tenant commerce platform. **Do nothing until you have read the current code and verified
your understanding against it.**

- READ FIRST: `AGENTS.md`, `docs/progress.md`, `README.md`, `prompts/SAM-STORE-execution-prompt-v2.md`
- EXPLORE: `apps/api/src/` (controllers, services, domain, persistence), `apps/web/src/` (storefront,
  admin tabs), `prisma/schema.prisma`, `packages/contracts`
- The project already has: storefront + guest cart + COD checkout, order claim/tracking, auth + roles
  (PLATFORM_ADMIN / STORE_OWNER / MANAGER / STAFF / SALES_AGENT / CUSTOMER / guest), multi-store,
  products + stock, order state machine, vouchers, loyalty, notifications, analytics, maintenance,
  multi-warehouse + transfers. 121 unit tests pass. Do not regress any of it.

## 1. Non-negotiable constraints (carry over from AGENTS.md)

1. **Bootstrap 5.3 mandatory** — no Tailwind/MUI/Ant. Mobile-first: admin screens must be usable on a
   phone/tablet (large touch targets, sticky bottom bars where appropriate).
2. **Multi-tenancy** — every store-owned table carries `storeId`; every admin query is tenant-scoped.
3. **Money = integer minor units** (cents) everywhere; no floats. Currency: PHP (₱) default.
4. **Server-authoritative** totals/payments; reject client-supplied totals; idempotency keys on
   money-creating endpoints.
5. **Roles** — reuse the existing `requireAdmin / requireView / requireManage` gates and the Team
   membership system. Add ONE new role (DELIVERY) as specified in Module 12.
6. **Verification** — every module ships with unit tests + typecheck + a live E2E; paste real command
   output. Never assert results; never fabricate.
7. **One module at a time.** Plan → implement → verify → update `docs/progress.md` → git checkpoint →
   report → wait for `CONTINUE`.
8. **Secrets** never in repo/prompts/logs. Keep `.env` (Supabase `DATABASE_URL`, JWT secrets).
9. **Guest flow is sacred** — "no app, no sign-up" must keep working after every module.

## 2. Peddlr feature map → SAM STORE modules (build in this order)

Peddlr's product is: cash / credit / payment / expenses / POS / receipts / purchases / reports /
store link / inventory / add product / products list / store settings / customer list.
Implement the following, one module per loop:

### Module P1 — POS (point of sale) — counter sales
- Admin "Sell" screen (touch-friendly): pick customer (optional) → pick products → totals server-side
  → choose **payment: CASH or CREDIT** → complete.
- Creates a normal `Order` (walk-in flag `source: "pos"`; new column) with payment captured at
  completion instead of delivery; DELIVERED-equivalent money state.
- No regression to the online order flow.

### Module P2 — Payments, Receipts, Voids & Refunds
- `Payment` table (orderId, method CASH/CREDIT/COD_COLLECTED, amountMinor, changeMinor, receivedAt).
- New payments endpoint; payment history per order.
- **Void** (same-day cancel) and **refund** flows at POS: void reverses an unfulfilled POS sale;
  refund records a negative `Payment` and moves the order to CANCELLED with a reason (audited).
- **Receipt** — printable/deterministic receipt view (browser print) for a completed order (store name,
  order number, line items, totals, cash tendered, change). VAT display-only label per decision #2.
  Thermal 58/80mm via Android print service = LATER module (noted, not built).

### Module P3 — Credit (utang) ledger
- Store-customer open balance: `StoreCustomer.creditBalanceMinor` + `CreditEntry` ledger rows per
  purchase / payment.
- **Online checkout**: approved customers may select "Pay on credit" (new payment method) up to the
  store's credit limit; guests and unapproved customers never see it.
- POS can also sell on credit (staff-initiated). Record partial or full payment (CASH); list customers
  with outstanding balances ("Utang list").
- Enforce per-store **credit limit** (new StoreSettings field); reject sales beyond it.

### Module P4 — Expenses
- `Expense` (storeId, category, amountMinor, note, spentAt). CRUD with owner/staff roles.
- Feeds the profit reports (Module P10). Simple category set: rent, utilities, supplies, wages,
  transport, other.

### Module P5 — Purchases & replenishment
- `Purchase` + `PurchaseItem` (product, quantity, costMinor, supplier note, purchasedAt).
- Completing a purchase **adds stock** (to the default warehouse) and updates cost per item.
- **Replenishment list**: products with available ≤ reorder threshold → one-tap "create purchase".
- New vendor name field on stores or on purchase records (keep simple: text on purchase).

### Module P6 — Inventory upgrade (list + filter)
- **Data migration first**: move warehouse-less `StockLevel` rows into each store's default warehouse
  (decision #8); verify sums before/after and paste counts.
- Inventory tab: aggregated per product (total across warehouses), with **filters**: search,
  category, warehouse, stock status (in stock / low / out), sortable by qty/name.
- Unit **cost** (from purchases) displayed; inventory value summary (cost × on-hand).

### Module P7 — Product list upgrade
- Filters + search: by name/SKU/category, price range, active status; sort options.
- Fast barcode/SKU search box (type SKU → jump). No new product-modelling beyond current.

### Module P8 — Store link settings upgrade
- Extend the existing settings/public-link UI: logo upload (store to DB column, base64/null or later
  storage), accent color, banner text, share message; **QR code** of the public link (client-side
  render, no new dep beyond a tiny lib or canvas), copy-link button.
- Show the public link front-and-center in the owner dashboard.

### Module P9 — Customer list upgrade
- Search/filter (name/email/phone/utang/status); tap a customer → profile: orders, utang balance,
  loyalty points, approval status, quick actions (collect payment, approve/suspend).
- CSV export of the customer list + their balances.

### Module P10 — Reports upgrade
- **Profit summary per period**: revenue (paid orders) − expenses − COGS (purchase costs of sold
  qty or fallback avg cost). Label estimates honestly where COGS is approximated.
- Sales by period/day (exists in analytics — extend), payment-method split (cash vs credit vs COD),
  **utang aging** (current / >30d), top products (exists), top customers.
- Print/view report + CSV export.
- **Visibility (decision #9):** OWNER + MANAGER only for profit/expense/COGS; STAFF and SALES_AGENT
  see sales/orders-level analytics only — enforce server-side.

### Module P11 — POS settings (store settings)
- Receipt header/footer text; **VAT display-only label** toggle ("prices VAT-inclusive, 12%" —
  decision #2, no computation); currency display default; utang default credit limit.
- All persisted to `StoreSettings` (new columns).

### Module P12 — DELIVERY role (courier)
- Add role `DELIVERY` to the Team invite options (distinct from SALES_AGENT: DELIVERY cannot see
  products/settings/vouchers; **sees ALL OUT_FOR_DELIVERY orders for the store** — no per-order
  assignment per decision #4; SALES_AGENT keeps its existing delivery powers).
- Delivery site: mobile "My deliveries" list (address, phone, landmark, schedule) filtered to
  OUT_FOR_DELIVERY; mark DELIVERED / FAILED_DELIVERY (+ reason). Tenant-scoped: only their store.

## 3. Data-model additions (expected; confirm + migrate per module)

`Payment`, `CreditEntry`, `Expense`, `Purchase`, `PurchaseItem`, `StoreSettings` extensions
(credit limit, receipt header/footer, POS tax display, link color), `Order.source`, `Order.deliveredById`,
`StoreCustomer.creditBalanceMinor`, `Product.unitCostMinor` (or derive from PurchaseItem).
All must carry `storeId` (multi-tenant rule).

## 4. Definition of done (each module)

1. New tables/migrations applied cleanly (`prisma migrate dev --name <module>` — paste output).
2. API endpoints guarded per the role matrix (paste a 3-role curl matrix in the E2E).
3. UI in the existing admin (Bootstrap 5.3, mobile-first) — screenshot-worthy, no placeholder text.
4. Unit tests for the new domain rules + `tsc --noEmit` clean + `npm test` green — **paste counts**.
5. Live E2E script exercised against the running API (scripts like `e2e-*.ts`, deleted after run) — paste output.
6. `docs/progress.md` updated; git checkpoint pushed.
7. Report: what shipped, exact commands + outputs, known gaps, next module. **Stop. Wait for CONTINUE.**

## 5. Ground rules for the upgrade session

- Do NOT remove or rename existing roles/endpoints unless a module says so explicitly; new permissions
  are additive.
- Keep the **guest flow** ("no app, no sign-up") untouched and re-verified each loop (a quick
  storefront checkout E2E before claiming the module done).
- Preserve the proven patterns: DI tokens (`Symbol`), `requireView/requireManage` gates, integer minor units,
  `e2e-*.ts` scratch scripts deleted before commit, no secrets.
- If an operator decision is missing (tax %, gateway, storage for logos), implement the safe default
  (no tax line, COD/cash/credit only, logo as text/base64) and log it in `docs/blocked-on-operator.md`
  — do not invent it.
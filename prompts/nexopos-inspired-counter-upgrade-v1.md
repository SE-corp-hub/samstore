# SAM STORE — NexoPOS-Inspired Counter & POS Upgrade (v1)

You are a senior staff engineer upgrading **SAM STORE** (multi-tenant Messenger commerce
platform: NestJS + Prisma + Next.js + Bootstrap 5.3) using **NexoPOS**
(github.com/Blair2004/NexoPOS, Laravel + Vue + Tailwind, GPL-3.0) as a **UX/flow
reference**. Work inside the existing repository. This is not a rewrite and not a port.

> **Operator's intent (verbatim):** "the only things i like on our project is the 'sell'
> 'pos, and pre order' feature, other features i copy on github repo for UX flow of the
> system (optional)".

---

## 0. Decisions locked by the operator (2026-09-13)

| Decision | Value |
|---|---|
| First module | **Module 1 — cash drawer, shifts, Z-report** (nothing depends on it; biggest operational gap) |
| Register model | **One register per store**, shifts opened/closed by the cashier on duty. Sessions are keyed by `registerId` so more registers can be added later without a migration rewrite, but the UI assumes a single register. |
| Printing | **57mm thermal paper** for receipts (print CSS, no hardware bridge). Product/price **labels on 57 × 40 mm** stock. A4 invoice stays optional/secondary. ESC/POS remains a documented later option only. |
| Tax | **PH VAT: one default rate (12%)** with inclusive/exclusive flag + per-product exempt, **BIR-style receipt breakdown** (VATable sales / VAT / VAT-exempt / zero-rated). |
| Sensitive actions | **Capability matrix + manager approval** (approver's own credentials/PIN) for discounts, voids, refunds and cash-out. |

---

## 1. Integration verdict — read this before writing any code

**Can we integrate NexoPOS into SAM STORE? No. Can we learn from it? Yes, and that is the plan.**

| Question | Answer |
|---|---|
| Merge/port NexoPOS code into SAM STORE? | **No.** Three independent blockers below. |
| Run NexoPOS side-by-side as a second system? |  Possible but **not recommended**: two databases, two customer/product sources, no shared stock ledger, double entry of every sale. Only consider it if the operator wants a genuine multi-store ERP backend and accepts data-sync work. |
| Use NexoPOS as a reference for flows/UX and data-model ideas, implementing everything natively? | **Yes — this is the chosen path (Option A).** |

**Blocker 1 — license.** NexoPOS is **GPL-3.0 (copyleft)**. SAM STORE is a commercial
multi-tenant SaaS whose JavaScript is delivered to browsers; copying GPL source, templates,
CSS or assets into it creates a real obligation to license the derivative work under
GPL-3.0. Ideas and flows are not copyrightable — *code* is. Therefore: **read it, describe
the flow in your own words, implement it in TypeScript/Bootstrap. Never copy-paste.** No
NexoPOS file content, template markup, Tailwind class strings, or PHP logic may land in
`apps/`, `packages/` or `prisma/`.

**Blocker 2 — stack.** Laravel/PHP + Vue 3 + Tailwind + Vite vs NestJS/TypeScript +
Next.js + Bootstrap 5.3 (mandated by `AGENTS.md`). There is no shared runtime, no shared
component layer, and Tailwind is explicitly forbidden in this repo. Any UI "copy" would be
a from-scratch rewrite anyway.

**Blocker 3 — architecture.** NexoPOS is a modular single-tenant Laravel app with
marketplace modules. SAM STORE is tenancy-first: every store-owned table carries
`storeId`, composite FKs enforce tenant consistency, money is integer minor units, stock is
an append-only ledger, and checkout is one atomic transaction. NexoPOS's models (global
customers, global products, optional Multistore module) would *regress* those guarantees.

**What we keep (do not touch its core behaviour):** the existing **sell / POS / pre-order**
flows the operator likes — POS sell (cash/utang), held orders, pre-orders + finalize,
delivery conversion, uvoucher/loyalty/credit, the stock movement ledger, atomic checkout,
tenant authorization. Upgrades extend them; they are never replaced or bypassed.

**What "reference" means concretely (from the actual repo):**

| NexoPOS artefact | Concept to study | SAM STORE equivalent today |
|---|---|---|
| `app/Services/CashRegistersService.php` (`openRegister`, `closeRegister`, `cashIng`, `cashOut`, `saveOrderChange`, `getZReport`) + models `Register`, `RegisterHistory` | **Shift/drawer lifecycle, cash in/out, expected vs counted cash, Z-report** | **missing entirely** (`grep -c Register prisma/schema.prisma` → 0) |
| models `OrderPayment`, `PaymentType` + `OrdersService::makeOrderSinglePayment`, `OrdersController::addPayment` | **Multiple payments per order (split/partial), configurable payment types** | `Payment` model supports many rows per order (`amountMinor`, `changeMinor`, `type`), but every flow writes exactly one full payment |
| `OrdersService::refundOrder`, `refundSingleProduct`, `getOrderProductsRefunded` | **Per-line / partial refunds with restock** | whole-order void/refund only (Module 7 capped it) |
| models `Tax`, `TaxGroup`, `ProductTax`, `OrderTax`; `OrdersService::computeTaxFromOrderTaxes` | **Tax engine (inclusive/exclusive, per-product, receipt summary)** | **no tax fields at all** (`tax` → 0 in schema) |
| `app/Services/BarcodeService.php`, `app/Http/Controllers/Dashboard/ScanUtilityController.php` | **Product barcodes, scan-to-cart, phone-as-scanner, label printing** | no product barcode field; only `CustomerBarcode.tsx` (customer identity) |
| `OrdersController::orderReceipt`, `orderInvoice`, `printOrder`, `getOrderPaymentReceipt` | **Receipt/invoice printing + reprint** | `ReceiptModal.tsx` (on-screen only) |
| `PermissionController` + NexoPOS **Authorizer** app (QR approval for discounts/voids) | **Capability registry + sensitive-action approval** | coarse roles only (ADMIN/OWNER_MANAGER/VIEW/DELIVERY); no per-capability gate, no approval flow |
| models `OrderStorage`/order types + `changeOrderProcessingStatus` **and** `changeOrderDeliveryStatus` | **Order/channel type + two independent status tracks** | single `status` axis + `fulfillmentType` (PICKUP/DELIVERY) |
| models `OrderInstalment` (`payInstalment`, `listInstalments`, `markInstalmentAs`) | **Instalment/layaway schedules on credit** | utang balance + due dates only, no schedule |
| `app/Services/ReportService.php`, `Dashboard/ReportsController` | **Sales by cashier/register/payment/hour, X/Z, stock** | ReportsPanel + AnalyticsPanel (no shift/cashier dimension) |
| `app/Services/Module.php`, `ModulesService`, `MenuService`, `CrudService` | **Extension architecture (modules, hooks, menu/settings registry)** | monolith — **reference only, not in scope** |

---

## 2. Mandatory operating rules

1. Read `AGENTS.md` first and obey it (Bootstrap 5.3 only, tenant isolation on every
   query, integer minor units, server-authoritative totals, tenant-scoped migrations,
   no secrets in repo/logs/prompts).
2. **No NexoPOS code, markup, copy or assets.** Reference-only. If a flow is adopted, the
   implementation must be written from the SAM STORE domain model outward.
3. Re-verify every claim in §1 against the current code before changing anything; label
   anything unproven a hypothesis.
4. One module per `CONTINUE`: plan → implement → format/lint/typecheck/test/build →
   targeted live probes → `docs/progress.md` → git checkpoint → report → stop.
5. Preserve the flows the operator likes (sell/POS/pre-order). Do **not** refactor them
   into NexoPOS shapes; extend them.
6. Every money/stock path: server-authoritative, integer minor units, idempotent where a
   client can retry, audited (actor + timestamp), and inside the existing atomic
   transaction patterns.
7. Migrations: expand → backfill → verify → contract, tenant-scoped, with rollback notes.
8. Tests: failing test first where practical; concurrency and negative cases mandatory for
   money/stock; cross-tenant test whenever a query or auth path changes.
9. Gates (real output only): `npm run db:validate`, `npm run typecheck`, `npm test`
   (sequential runner), `npm run build`, `npm run test:e2e` for UI-touching modules,
   `npm run check:secrets`, plus `npx tsx scripts/reconcile.ts` when the module writes
   balances.
10. If a gate fails, fix the root cause; never report plausible-but-unverified output.

---

## 3. Modules

Dependencies are real: 1 → 2 → 3 build on the same order/payment plumbing; 4 and 5 are
independent; 6 depends on 4/5 for content; 7 gates 2/3/6; 8 depends on 1.

### Module 1 — Cash drawer, shifts and Z-report `P1`
**Goal:** a cashier works a shift; the store can prove what was expected vs counted.
- Schema (tenant-scoped): `Register` (one per store by default; name, status) and
  `RegisterSession` (openedBy, openedAt, openingFloatMinor, closedAt, closedBy,
  countedMinor, expectedMinor, varianceMinor, status OPEN/CLOSED, notes) tied to
  `(storeId)`; `Order.registerSessionId` (nullable, set for counter sales);
  `CashMovement` (sessionId, type: CASH_IN | CASH_OUT | FLOAT | DROP, amountMinor,
  reason, createdBy) — append-only.
- Rules: a POS sale/hold-complete/credit settlement records the session and the payment
  rows against it; **expected cash = opening float + cash payments + cash-in − cash-out −
  refunds paid in cash**; closing requires a counted amount and stores the variance;
  a closed session cannot accept new movements; sales without an open session are rejected
  for cash methods (or explicitly allowed by a store setting `requireOpenShift`, default
  **on**).
- X-report (mid-shift snapshot, non-destructive) and Z-report (on close, immutable summary
  with per-method totals, cash movements, refunds, variance) exposed from the API and
  printable (module 6).
- API: `POST /admin/registers`, `GET /admin/registers`, `POST /admin/registers/:id/open`,
  `POST /admin/registers/:id/close`, `POST /admin/registers/:id/movements`,
  `GET /admin/registers/:id/report?kind=x|z`, `GET /admin/register-sessions/current`.
- UI (Bootstrap): a register bar in the POS panel (open shift / current shift / close
  shift), a movement modal (cash in/out with reason), a close-shift modal showing
  expected vs counted with live variance, and a printable Z-report.
- Tests: opening/closing, variance math (±), no double-close, movements rejected after
  close, cash sale without a session rejected, cross-tenant isolation, concurrent close
  (only one wins), reconcile: sum(order payments in session) == report totals.
- Acceptance: a live POS cash sale appears in the session's expected cash; closing with a
  short count stores a negative variance and is visible in the Z-report; a second close
  attempt returns a conflict.

### Module 2 — Split and partial payments + tender/change `P1`
**Goal:** one order can be paid with several tenders (e.g. ₱200 cash + ₱300 utang), and
cash tendering computes change — without touching server-authoritative totals.
- Reuse the existing `Payment` model (multiple rows per order already supported); add
  `tenderedMinor` (cash tendered, distinct from `amountMinor` applied) if missing and a
  `seq` for stable ordering; add a payment-method registry per store
  (`PaymentMethod` table or `settings.paymentMethods` JSON: code, label, kind
  CASH/CREDIT/EWALLET/TRANSFER, requiresReference, enabled, sortOrder).
- Service: `recordSplitPayment(orderId, [{methodCode, amountMinor, tenderedMinor?,
  reference?}])` inside ONE transaction: validates each against the order's outstanding
  balance, rejects overpayment (except cash change), creates the Payment rows, updates
  `paymentStatus` (UNPAID/PARTIAL/PAID), and — for credit lines — writes the credit entry
  through the existing credit service (limit-checked, idempotent).
- Rules: outstanding = totalMinor − Σ(payments, refunds) − discounts already applied;
  change = Σ(cash tendered) − Σ(cash applied), never negative, recorded on the cash row;
  mixed credit+cash must respect the credit limit for the credit portion only; every part
  is idempotent by `(orderId, idempotencyKey)`.
- API: `POST /admin/orders/:id/payments` (array), `GET /admin/orders/:id/payments`,
  `GET /admin/payment-methods`, admin CRUD for methods.
- UI: a payments modal (add tender rows, live "remaining" figure, change display, method
  picker, reference field for e-wallets) used by POS complete, Orders pay, and pre-order
  finalize; the order card shows PARTIAL vs PAID and the remaining balance.
- Tests: exact, under, over (cash change vs rejection for non-cash), split cash+credit
  within limit, split exceeding limit rejected, retry idempotency, status transitions,
  reconcile: Σ payments == order total when PAID.
- Acceptance: live probe pays one order ₱200 cash + ₱300 utang → two Payment rows, credit
  ledger +1 entry of 30000 minor, status PARTIAL→PAID only when the balance is zero.

### Module 3 — Per-line refunds and partial returns `P1`
**Goal:** refund specific products/quantities, restock exactly those, keep the audit trail.
- Schema: `OrderRefundItem` (refundId, orderItemId, quantity, amountMinor) + restock link
  to `StockMovement` (`type: RETURN`); refunds reference the `Payment` rows they reverse
  (a refund is a Payment row of `type: refund` linked to a method, never free-floating).
- Service: `refundItems(orderId, [{orderItemId, quantity, restock: boolean}],
  {methodCode, reason, actor})` — one transaction: sum ≤ remaining refundable per line
  (original qty − already refunded), recompute order totals snapshot adjustments, restock
  via the **existing** `restoreStock` ledger helper (never direct writes), write the refund
  Payment row, update `paymentStatus` (PAID/PARTIAL/REFUNDED), append `OrderStatusHistory`
  with a `REFUND` reason. Keep the whole-order void/refund path working (module 7 of the
  hardening pass).
- Rules: refunds can never exceed captured amounts (per line and per method); restocking is
  per-line opt-in (a damaged item is not restocked); same-day void vs later refund stay
  distinct policies; every refund is actor-audited.
- API: `POST /admin/orders/:id/refunds`, `GET /admin/orders/:id/refunds`,
  `GET /admin/orders/:id/refundable`.
- UI: an order-detail refund modal listing lines with qty pickers, restock toggles, method,
  reason, and a running refund total; refunded lines show badges in the order view.
- Tests: partial qty, repeated refunds summing to the line qty (last one exact), over-qty
  rejected, restock on/off moves stock + ledger exactly once, cross-order line id rejected,
  tenant isolation, reconcile drift zero.
- Acceptance: live probe refunds 1 of 2 units with restock → stock +1 with a `RETURN`
  movement, one refund Payment row, order status history shows the refund, second refund of
  the same unit is rejected.

### Module 4 — Tax engine (PH VAT-ready) `P1`
**Goal:** compute taxes once, server-side, and show them on receipts/invoices.
- Schema: `Tax` (storeId, name, rateBasisPoints (e.g. 1200 = 12%), inclusive: boolean,
  compound: boolean, isDefault), `TaxGroup` + members for products with multiple taxes,
  `Product.taxId?`/`taxGroupId?`, and on `Order`/`OrderItem`: `taxMinor`, `taxableMinor`,
  `taxBreakdown` (JSON snapshot) so history stays immutable when rates change.
- Service: `computeTaxes(lines, store, customer, opts)` in the pricing domain
  (`domain/pricing.ts` sibling) used by checkout, POS sell, pre-order finalize and refunds;
  inclusive vs exclusive handling; rounding half-up at the line level with the residual
  assigned to the largest line (no lost centavos); totals remain integer minor units.
- Rules: the client never sends tax; the order snapshot stores the breakdown; changing a
  product's tax never rewrites historical orders; tax-exempt products are explicit.
- API: admin CRUD for taxes/groups; product create/update accepts a tax reference;
  receipts/invoice expose `taxBreakdown`.
- UI: a Taxes panel (rates, inclusive flag, default), a product tax selector, and a receipt
  footer showing "VATable sales / VAT / VAT-exempt" style lines.
- Tests: inclusive vs exclusive math on known fixtures, rounding residual, zero-rate and
  exempt, tax changes don't touch history, POS + checkout + refund paths agree, totals
  reconcile with the ledger.
- Acceptance: a live POS sale of ₱112 inclusive at 12% records taxMinor 1200 (₱12.00),
  taxable 10000; the receipt shows the breakdown; changing the rate leaves that order
  untouched.

### Module 5 — Barcode-first POS `P2`
**Goal:** scan to sell; type when no barcode exists.
- Schema: `Product.barcode` (nullable, unique per store via `@@unique([storeId, barcode])`),
  `ProductUnit` optional later; label fields (name, price, barcode rendered as SVG/PNG).
- Flow: the POS search box accepts scanned input (keyboard-wedge scanners type + Enter) and
  resolves exact barcode → adds one unit to the sale; unknown barcode → inline "not found"
  with a quick-create suggestion (respecting module 7 permissions); scale barcodes
  (weight/price embedded, EAN-13 prefix configurable in store settings) parse into
  quantity+product; product admin gains a barcode field + label printing sheet.
- API: `GET /admin/products/by-barcode/:code`, `PATCH /admin/products/:id/barcode`,
  `GET /admin/products/:id/label` (printable), bulk import column.
- UI: focus-trapped scan input in the POS panel (scanner stays armed; Escape clears), a
  "scanned" toast, and a label sheet printing on **57 × 40 mm** stickers (repeat across the
  sheet for a chosen product/quantity; `@page { size: 57mm 40mm }`).
- Tests: exact hit, unknown code, duplicate-per-store rejected, cross-tenant code isolated,
  scale-barcode parsing table (valid/invalid checksums), label endpoint renders.
- Acceptance: live probe scans a code → the item is in the sale and stock reserved; a
  duplicate barcode on another product in the same store returns a conflict.

### Module 6 — Receipt and invoice printing `P2`
**Goal:** hand the customer paper on **57 mm thermal paper**, and print **57 × 40 mm price
labels**, without any hardware bridge.
- Approach: **print-CSS only**: a print-only route/component per document (receipt on a
  57 mm roll, optional A4 invoice, label sheet on 57 × 40 mm stickers) using `@media print`
  + exact `@page` sizes (`size: 57mm auto` for the roll, `size: 57mm 40mm` for a label),
  monospace-safe layout, driven by the order snapshot; `window.print()` from the existing
  ReceiptModal and the POS success step. ESC/POS via a local bridge stays a documented later
  option (operator decision), never a hard dependency.
- Content: store identity (name/address/TIN if set), order number + timestamp, cashier +
  register session, line items with the **BIR-style tax breakdown**, discounts, delivery
  fee, payments with tenders/change, refunds noted, claim/tracking token, and a "COPY"
  marker with the reprint count.
- Rules: print payload is a snapshot (no live recompute); reprints are audited
  (`ReceiptPrint` log: orderId, docType, count, actor); no PII beyond what the customer
  already gets.
- API: `GET /admin/orders/:id/receipt?format=thermal57|a4` (HTML, print-ready),
  `POST /admin/orders/:id/receipt/printed` (audit).
- Tests: template renders from a snapshot with taxes/refunds/split payments; reprint
  increments the counter and is visible in audit; no recalculation drift vs the order.
- Acceptance: printing an order with split payments + tax shows every tender and the tax
  breakdown at 57 mm width without clipping; a reprint is marked COPY.

### Module 7 — Capability permissions + sensitive-action approval `P2`
**Goal:** the owner decides who may discount, void, refund or close a register — and
sensitive actions can require approval, not just role membership.
- Schema: `RoleCapability` (storeId, role, capability, allowed) with a capability registry
  in code (`pos.sell`, `pos.discount`, `pos.priceOverride`, `pos.void`, `pos.refund`,
  `pos.creditSale`, `register.open`, `register.close`, `register.cashOut`,
  `orders.edit`, `products.write`, `reports.view`…); `ApprovalRequest` (storeId, orderId?,
  action, payload, requestedBy, approvedBy, status, expiresAt) for the PIN/QR flow.
- Service: `requireCapability(user, storeId, capability)` extends the existing
  `resolveTenant` (module 1 of the hardening pass) — one enforcement point, server-side,
  never UI-only; approval: a cashier requests → an APPROVER-capable user confirms with
  **their own credentials/PIN** (never a shared password) → the request is consumed
  single-use and audited; expired requests are rejected.
- Rules: default matrix ships conservative (owner/manager full, staff sell-only);
  capability checks are tenant-scoped; approval tokens are single-use and short-lived;
  every approval/denial is audited with actor + action + payload hash.
- API: `GET/PUT /admin/roles/:role/capabilities`, `POST /admin/approvals`,
  `POST /admin/approvals/:id/approve`, `POST /admin/approvals/:id/deny`,
  `GET /admin/approvals?status=pending`.
- UI: a Permissions matrix panel (roles × capabilities), and an approval modal in POS/Orders
  (discount, void, refund, cash-out) that explains what is being approved.
- Tests: capability matrix enforcement per role, cross-tenant capability leak impossible,
  approval single-use + expiry, staff cannot self-approve, disabled capability blocks the
  server path even if the UI is bypassed.
- Acceptance: a STAFF user is blocked server-side from a discount; with an approved request
  the same action succeeds once and the approval cannot be reused.

### Module 8 — Order types and two-track status `P2`
**Goal:** separate "how it is produced/paid" from "how it is fulfilled", and label the
channel (walk-in / takeaway / dine-in / delivery / online).
- Schema: `Order.orderType` enum (WALK_IN, TAKEAWAY, DINE_IN, DELIVERY, ONLINE) — distinct
  from the existing `fulfillmentType`; optional `TableRef` only if the operator asks;
  add `processingStatus` (NEW → PREPARING → READY → SERVED/COMPLETED) alongside the existing
  delivery pipeline, with a documented mapping so nothing loses its current meaning
  (COD delivery orders keep their existing statuses).
- Service: one state machine extension in `domain/order-state.ts`; every existing caller
  (admin transition, POS complete, pre-order finalize, delivery service) routes through it;
  no synthetic/skipped history entries.
- UI: order-type selector at POS/checkout, a "kitchen/queue" style filter for
  PREPARING/READY, and the two tracks shown side by side in the order detail.
- Tests: allowed transitions per type, delivery orders cannot skip the delivery track,
  history records every hop, filters/counts agree with the lists.
- Acceptance: a TAKEAWAY POS sale moves NEW→PREPARING→READY→COMPLETED with full history
  while a DELIVERY order still requires the courier DELIVERED hop.

### Module 9 — Instalment schedules for utang `P3`
**Goal:** agree a payment plan on a credit balance and collect it over time.
- Schema: `InstalmentPlan` (storeId, storeCustomerId, orderId?, totalMinor, downMinor,
  count, frequency, startAt), `Instalment` (planId, seq, dueAt, amountMinor, paidMinor,
  status PENDING/PARTIAL/PAID/OVERDUE, paidAt); payments link to existing `CreditEntry`
  (type payment) and `Payment` rows.
- Service: create a plan (validates against the outstanding balance), pay an instalment
  (atomic: Payment row + CreditEntry + balance + status), recompute OVERDUE on read, and
  emit outbox events for due reminders (no live Messenger calls).
- UI: an instalments card in the Utang panel (schedule table, pay action, overdue badges)
  and a customer statement view.
- Tests: plan totals equal the balance, early/partial/late payments, overpay rejected,
  schedule status transitions, reminder events queued once per due period.
- Acceptance: a ₱1,200 utang becomes 4×₱300 weekly; paying one updates balance + ledger +
  status; a second payment of the same instalment is rejected.

### Module 10 — Counter reporting `P3`
**Goal:** the numbers an owner actually checks: by shift, cashier, method, product, hour.
- Reports: X/Z recap, sales by cashier (per session), by payment method, by order type,
  by product/category, hourly heatmap, discounts given, refunds, low stock, inventory
  valuation, gross margin (using cost from purchases where available), and guest vs
  account customers. All read-only, tenant-scoped, date-bounded, with CSV export.
- Performance: compound indexes for the new access paths (`Order(storeId, createdAt)`,
  `Payment(storeId, receivedAt)`, `RegisterSession(storeId, openedAt)`, `OrderItem(storeId,
  productId)`), and cursor pagination for large lists (evidence-driven: measure first).
- Tests: aggregate correctness against a seeded fixture set (one known shift), isolation,
  date boundaries (store timezone), CSV shape.
- Acceptance: a Z-report and the "sales by cashier" report agree exactly with the seeded
  fixture; exports contain no other store's rows.

**Backlog (not this pass):** loyalty rule engine (NexoPOS `RewardSystemRule` analogue),
product bundles/sub-items, phone-as-scanner utility, offline/PWA POS, ESC/POS bridge,
module/marketplace architecture (explicitly out of scope — monolith stays).

---

## 4. Required flow test matrix (new scenarios)

1. Open shift → cash sale → cash-in → close shift with a short count → variance recorded, Z-report totals match.
2. Cash sale attempted with no open shift → rejected (when `requireOpenShift`).
3. Split payment: ₱200 cash + ₱300 utang → two Payment rows, credit ledger entry, PARTIAL → PAID.
4. Overpayment non-cash → rejected; overpayment cash → change recorded, never negative.
5. Per-line refund of 1 of 2 units with restock → stock +1 (`RETURN` movement), refund Payment row, history entry.
6. Second refund of the same unit → rejected (per-line cap).
7. VAT-inclusive ₱112 at 12% → taxMinor 1200, taxable 10000, receipt shows the breakdown.
8. Rate change after an order → the historical order's tax snapshot is unchanged.
9. Barcode scan → correct product added; unknown scan → not found; duplicate barcode in store → conflict.
10. Receipt print of an order with tax + split payments + a refund → all sections correct; reprint marked COPY.
11. STAFF discount blocked server-side; approved request succeeds once; the approval cannot be reused.
12. Register close is idempotent under concurrency (one winner, one conflict).
13. Cross-tenant: register/instalment/barcode/report IDs from store A never resolve in store B.
14. Takeaway order runs NEW→PREPARING→READY→COMPLETED; delivery order cannot skip the delivery track.
15. Instalment plan: 4×₱300 on ₱1,200; one payment updates balance + ledger + status; double payment rejected.
16. `scripts/reconcile.ts` reports zero drift after every scenario above.

---

## 5. Verification gate for every module

```bash
npm run db:validate
npm run typecheck
npm test              # sequential runner (apps/api/src/**/*.test.ts)
npm run build
npm run check:secrets
npx tsx scripts/reconcile.ts          # when the module writes balances
npm run test:e2e                      # when the module touches UI flows
```

Plus: focused tests (including concurrency + negative cases), cross-tenant tests for any
query/auth change, `prisma migrate status`/diff for schema changes, targeted live API
probes with redacted identifiers, `git diff --check`, and a real-output report. Update
`docs/progress.md` and `docs/runbooks.md` (new flows: shift close, refunds, tax rates,
barcode, printing) before the checkpoint.

---

## 6. Reporting format

Per module: (1) what changed and why; (2) invariants now enforced; (3) tests added and real
gate output; (4) live verification with redacted identifiers; (5) migration/data impact and
rollback note; (6) commit hash; (7) remaining risks — then stop with
`Waiting for CONTINUE.`

---

## 7. Non-goals (explicit)

- No NexoPOS code, templates, CSS, assets or Tailwind in this repo (GPL + AGENTS.md).
- No rewrite of sell/POS/pre-order; no replacement of the stock ledger, atomic checkout,
  tenancy model, or the Messenger adapter boundary.
- No marketplace/module-loading architecture, no accounting journal, no multi-currency.
- No live Messenger/Graph calls; no new infrastructure (Redis/queue) unless the operator
  approves it in a module's scope.

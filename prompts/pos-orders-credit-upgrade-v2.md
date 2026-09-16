# SAM STORE — POS / Orders / Credit-Ledger Upgrade Prompt v2

Author: Hermes agent (2026-09-04), on behalf of store owner `extraricestore`.
Execute **one module per loop**: plan → implement → typecheck/test/build → update `docs/progress.md` → git checkpoint → report → wait `CONTINUE`. Every claim verified with real command output. Stubs are stubs; label them.

## §0 Locked decisions (operator-confirmed 2026-09-04 — do not re-litigate)

1. **Orders default = TODAY** (with date-range filter: today/yesterday/tomorrow + custom range) and a **customer-name search**. All-status list remains available via "All".
2. **Hold is a real backend state**: new `OrderStatus.ON_HOLD` (persisted). Held POS orders appear in **Orders → On-Process** and can be resumed/edited there. Client-side-only holds are out.
3. **Utang → "Credit Ledger"** (rename) with **Paid / Unpaid tabs**: one customer list; **Unpaid** = balance > 0, **Paid** = balance = 0. Balance auto-updates as payments come in.
4. **Start/due dates are real fields**: `CreditEntry.startAt` (default = purchase date) + `dueAt` (startAt + store's `creditTermDays`, configurable per entry at utang time). Reports/aging use them.
5. **POS is a full-stack staged flow**, mobile-first: Products → Review (add/select customer, autosave) → Hold (ON_HOLD) or Pay → Payment method (Cash | Utang) → Cash: enter amount tendered → show change → completed (Payment row + printable receipt) → back to POS. Utang: select or add customer → start/due dates → completed (+ ledger).
6. **Scope discipline**: UI + the explicit backend deltas in §3. No unrelated refactors. Money stays integer minor units; totals server-authoritative; tenancy untouched.

## §1 Real gaps found (from live code inspection 2026-09-04)

### POS (`apps/web/src/components/admin/PosPanel.tsx` + `apps/api/src/pos/`)
- **No staged flow**: it's one screen — tap products → pick cash/credit → "Complete sale". No review step, no hold, no tendered amount, no change display.
- **No hold / resume**: no ON_HOLD state, nothing persisted mid-sale. A held order must survive reloads and be editable from Orders.
- **Cash sales record no Payment row** (no tendered/change captured); `Payment.changeMinor` exists in the schema but POS never uses it.
- **No customer details entry**: only a dropdown (existing store customers) or a raw name. Walk-in phone/email can't be saved for reuse (no autosave), and utang requires a linked customer — so new utang customers can't be created inline.
- **Utang has no start/due dates** at POS time (and CreditEntry has no date fields).
- **Desktop-first**: two-column layout (`col-md-7`/`col-md-5`); on a phone it stacks awkwardly — not a touch-first register.
- No product category filter, no quick total summary during review, receipt only from the Orders tab (no print right after a sale).

### Orders (`apps/web/src/components/admin/OrdersPanel.tsx` + `/admin/orders`)
- **One flat table of everything** (last 100) — no "today" default, no tabs, no date or customer filters.
- No Pending / On-Process / Completed / Void grouping.
- **Held orders have nowhere to live** (no ON_HOLD) and no inline edit (add/delete lines, then pay-or-utang).
- Table-only UI — poor on mobile (despite the `table-responsive` wrapper).

### Utang / credit (`apps/web/src/components/admin/UtangPanel.tsx` + `/admin/credit/`)
- Labeled "Utang (Credit)" — operator wants **"Credit Ledger"**.
- Single list of debtors only; **no Paid/Unpaid tabs**, no way to browse fully-settled customers.
- No **start/due dates**, no aging indicator (days overdue), no paid-on display in the ledger.
- Desktop table — no mobile card layout.

## §2 Modules (one per loop)

### V1 — POS staged flow (mobile-first) + hold/resume
**Backend (new, §3):**
- `POST /admin/pos/hold` — create a held order (items + optional customerId/customerName/customerPhone) → status `ON_HOLD`, source `pos`, paymentStatus `PENDING`, **stock decremented** at hold (goods earmarked).
- `GET /admin/pos/holds` — list store's `ON_HOLD` orders (items, customer, total, heldAt).
- `PATCH /admin/pos/holds/:id/items` — add/delete lines (recompute totals server-side; adjust stock by the delta; validate availability on adds).
- `POST /admin/pos/holds/:id/complete` — complete with `{ paymentMethod: "cash"|"utang", tenderedMinor?, customerId?, startAt?, dueAt? }`:
  - cash → status COMPLETED, paymentStatus COLLECTED, **Payment row** `{method:"cash", amountMinor: total, changeMinor: tendered-total}` (reject tendered < total).
  - utang → requires customer; status COMPLETED, paymentStatus PENDING, **CreditEntry** (+ balance, + dueAt) as today.
- `POST /admin/pos/holds/:id/void` — restore stock, status CANCELLED, audit history (actor "pos_void").
- Extend `POST /admin/pos/sell` (immediate sale): optional `tenderedMinor` (cash) → Payment row + change; optional `startAt/dueAt` (utang).
- **Customer quick-create + autosave**: `POST /admin/customers/quick` `{name, phone?}` → creates Customer + StoreCustomer (no login account), returns the store-customer id for reuse. POS review "Add new customer" uses it and keeps it in the dropdown.
- State machine: add `ON_HOLD`; transitions `RECEIVED→ON_HOLD`? (POS hold creates directly as ON_HOLD), `ON_HOLD → COMPLETED | CANCELLED`; `isTerminal(ON_HOLD)=false`; paymentEffect: COMPLETED→COLLECTED (cash) stays PENDING for utang.

**UI — `PosPanel.tsx` rewrite (mobile-first, single column):**
1. **Products** — search + category chips, touch tiles with name/price/stock, stock-aware.
2. **Cart / Review** — line items with +/- , total; **"Add/select customer"** expander: dropdown of saved customers OR "Add new customer" (name + phone → quick-create → autosave → stays selected).
3. **Actions**: **Hold order** (→ ON_HOLD, toast, cart clears, held strip refreshes) · **Continue to payment**.
4. **Payment**: Cash | Utang toggle.
   - Cash: **tendered amount** numeric pad (quick ₱ amounts + exact), shows **change** live, disabled until tendered ≥ total.
   - Utang: customer required (select/quick-add), **start date** (default today) + **due date** (default start + store credit term; editable).
5. **Done**: success card — order number, total, **change** (cash), **Print receipt** (opens ReceiptModal) · "New sale" → back to Products.
6. Held strip under Products: current `ON_HOLD` orders with **Resume** (loads lines back into cart, removes hold) — resume reopens via a `PATCH items`+complete path (resume = load, then edit → pay/void). Keep it: Resume loads the held order's lines into the cart for editing, then completing/voiding happens through the same review/payment screen.

DoD: live E2E — hold an order (stock decremented), resume→edit (add a line → totals+stock adjust), complete cash with tendered (Payment row + change, e.g. ₱200 tendered / ₱170 total → change ₱30), utang complete with due date (CreditEntry has startAt/dueAt), void restores stock. Mobile: renders as stacked cards at 375px.

### V2 — Orders tabs + filters + on-process editing (mobile-first)
**Backend:** extend `GET /admin/orders` with filters: `?status=&from=&to=&customer=` (customer = name/phone substring). Default when no filters = server today range (client sends today by default). Keep `deliveryType`/`paymentStatus` in the select.

**UI — `OrdersPanel.tsx` rewrite:**
- Header: **date-range filter** (Today [default] · Yesterday · Tomorrow · Custom) + **customer search** box.
- **Tabs**: `Today` (default) · `Pending` · `On Process` · `Completed` · `Void`.
  - Pending = RECEIVED, CONFIRMED
  - On Process = PREPARING, READY, OUT_FOR_DELIVERY, **ON_HOLD** ("for delivery or reserved")
  - Completed = DELIVERED, COMPLETED
  - Void = CANCELLED, FAILED_DELIVERY
- **On-Process tab** adds per-order controls (role-gated as today): **Edit** (open a line editor — add product / delete line / change qty → `PATCH holds/:id/items`; only for ON_HOLD), **Pay / Utang** (complete a held order with cash-tendered or utang → `POST holds/:id/complete`), **Void** (restore stock), plus the existing status transitions for delivery orders.
- **Today tab** keeps existing transitions/receipt/details but scoped to today by default.
- **Mobile-first**: rows become stacked **cards** below `md` (order number, customer, total, status badge, action buttons); table ≥ `md`.

DoD: live — today default returns only today; filter by customer name; hold created in POS appears in On-Process; edit adds/removes a line; complete-as-utang updates ledger; void restores stock.

### V3 — Credit Ledger (renamed Utang) with paid/unpaid + dates (mobile-first)
**Backend:**
- Extend `GET /admin/credit/utang` → `?status=unpaid|paid` (unpaid default). Return per customer: `balanceMinor, creditLimitMinor, creditApproved, firstPurchaseAt, oldestDueAt, daysOverdue, paidAt (last settle)`. Paid = balanceMinor = 0.
- Include `startAt`/`dueAt` in `GET /admin/credit/:id` entries.
- `StoreSettings.creditTermDays` (Int, default 30) → used as default dueAt offset for POS + online credit checkout.

**UI — `UtangPanel.tsx` → rename file/heading to "Credit Ledger":**
- **Tabs: Unpaid | Paid** (counts).
- List = mobile-first cards (≥md table): customer, phone, **balance**, **due date** (+ **overdue** red badge with days), limit, actions (Pay, Ledger; Ledger also on paid rows).
- Ledger modal shows start/due dates per entry + aging.
- Approval flow unchanged (approve credit in Customers), but surface the credit-limit badge here too.

DoD: live — utang entry with dueAt appears Unpaid with overdue badge; after full payment the customer moves to Paid; ledger shows start/due dates.

## §3 Explicit backend changes allowed (everything else UI-only)

1. Schema: `OrderStatus` += `ON_HOLD`; `CreditEntry` += `startAt DateTime @default(now())`, `dueAt DateTime?`; `StoreSettings` += `creditTermDays Int @default(30)` (migration).
2. `order-state.ts`: ON_HOLD transitions (`ON_HOLD → COMPLETED | CANCELLED`), terminal flags, payment effects.
3. POS endpoints (hold/items/complete/void + extended sell with tendered + dates) per V1.
4. `POST /admin/customers/quick` (name/phone → Customer + StoreCustomer, no auth account).
5. `GET /admin/orders` filters (`status/from/to/customer`); `GET /admin/credit/utang?status=paid|unpaid` + date fields in detail.
6. `CreditService`: dueAt default from `StoreSettings.creditTermDays` (POS + online paths).
7. No other schema changes; no service/repository refactors outside these endpoints. Tenancy untouched. Totals stay server-authoritative.

## §4 Constraints (non-negotiable)

- **Bootstrap 5.3** only; no new runtime deps (existing: bootstrap-icons, qrcode). Mobile-first: all three screens usable at 375px.
- Keep every existing API contract intact; additive changes only. Online checkout flow untouched except dueAt default (read-only).
- No secrets/PII in UI text. Multi-tenant rule untouched.
- One module per loop with real gates (typecheck/test/build pasted). Update `docs/progress.md` after each module. Commit + push per module.

## §5 Definition of done (every module)

- Acceptance criteria in the module's DoD met with real command/browser output (curl/tsx E2E, DOM assertions ok).
- `npm run typecheck` clean (contracts+api+web), `npm test` all green (no regressions), `next build` succeeds.
- No failing stubs; labeled TODO where a stub is temporarily necessary.
- `docs/progress.md` updated; git commit + push; report → wait `CONTINUE`.
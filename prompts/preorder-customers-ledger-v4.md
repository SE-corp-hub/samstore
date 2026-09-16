# SAM STORE — Upgrade v4: Customers & Loyalty, POS Pre-Order (utang + signature), Credit Ledger Filters

**Goal (operator):** "Customers & Loyalty must add/edit/customize/redeem loyalty points. Sell gets a Pre-Order flow: day list + date-range filter, edit drafts, a Finalize tab — utang payment ending with a signature per transaction → completed. Credit Ledger gets customer-name and date filters."

Bootstrap 5.3, mobile-first, PHP minor units, `store_id` tenancy on every table, server-authoritative money. One module at a time: plan → implement → format/lint/typecheck/test/build → docs/progress.md → checkpoint → report → CONTINUE.

---

## Module A — Customers & Loyalty (admin)

**A1 Add customer (admin-created).** `POST /admin/customers` — name (required), phone, email (optional), optional initial credit limit + pre-approve. Creates the store-customer profile (approval = chosen or NOT_REQUIRED), loyalty balance 0, appears immediately in Customers + Credit Ledger. Duplicate phone/email within store → 409 with a clear message. Mobile-first modal, same customer card style as the list.

**A2 Edit customer details.** `PATCH /admin/customers/:id` — name, phone, email, credit limit (replaces the current limit modal → one edit form). Audit note optional. No status change here (approval stays in its existing flow).

**A3 Customize loyalty points.** `POST /admin/customers/:id/loyalty/adjust` — signed `{delta: int, note: string}`. Creates a `LoyaltyEntry type=ADJUST` (delta, note, balanceAfter) inside the same tx; balance can go +/− but never below 0 (409). Ledger modal shows ADJUST rows with reason alongside EARN/REDEEM.

**A4 Redeem loyalty points (staff-side).** In POS payment step, when a customer is selected and has points: "Redeem points" toggle → show `₱` value (reuse `redeemDiscountMinor`, cap = order total) → creates the order with `loyaltyPointsRedeemed`, records the redemption idempotently (existing checkout gateway logic reused by the POS service; one REDEEM entry per order). Balance shown live in the payment modal. Redemption only ever attaches to an order (audit trail). Profile shows running balance + entries.

> **Decided 2026-09-08:** "Customize" = manual points adjust (+/- with reason) + staff redeem at POS. No earn-rate settings panel (out of scope).

## Module B — POS Pre-Order → Finalize (utang + signature)

**B1 Sell gets a segmented control: `Sell` | `Pre-Orders` | `Finalize` (Bootstrap btn-group, sticky under the Sell header).** Regular Sell keeps today's cart/hold/cash/utang/receipt exactly as-is.

**B2 Pre-order creation** (Pre-Orders tab → "＋ New pre-order" or mode toggle in the cart bar):
1. **Select products** — same searchable product grid, per-line qty.
2. **Review, add customer details** — review list (qty, price, total; server-priced), add/select customer (existing autosave/select UI). Pre-order **requires a customer** (utang needs a debtor).
3. **Save draft** — `POST /admin/pos/preorder` → order `source=PRE_ORDER, status=ON_PROCESS, paymentMethod=credit`, stock reserved/earmarked (same hold semantics as ON_HOLD), start/due dates defaulting to today / +7d. Editable after save (A-edit below). Draft lands in Pre-Orders list + Orders ▸ On Process (single source of truth — both views read the same orders).
4. **Can edit order** — same stock-delta edit modal from W1/W2 (items add/remove, server recompute total; also editable from the Orders On Process tab).
5. **Delete draft** — void w/ reason (releases stock), consistent with existing void flow.

**B3 Pre-Orders list** (in Sell): **default = today**; date-range filter (from/to) for any window; rows: order number, customer, items count, total, due date, status badge, Edit / Finalize buttons; mobile cards, table on ≥md. Filters server-side (`createdAt` range + `source=PRE_ORDER`).

**B4 Finalize tab** (in Sell): lists on-process pre-orders (ON_PROCESS + source=PRE_ORDER with past-due highlighting), any date range (default today's created). Tap Finalize →
1. Payment **utang only** (locked decision): amount payable = remaining total (server-side), no tendered/cash option.
2. **Signature pad** — finger-drawn canvas (touch + pointer), Clear/Redo, required to Complete; captured as data-URL PNG and stored on the order.
3. Complete → `POST /admin/pos/preorders/:id/finalize` → idempotent, server-validates signature present + order still ON_PROCESS + computed totals; order → **COMPLETED**, balance→utang ledger (start/due from draft), entry reference to order; optional print receipt w/ signature block.

**B5 Regular POS utang gets the signature pad too** (locked decision — signature required on EVERY utang finalize, not just pre-orders). The existing Utang payment step in Sell gains the same canvas between amounts (start/due) and Complete; `POST /admin/pos/complete` validates `signatureData` when `payment=credit` — 400 without it. Cash sales unaffected.

**B6 Guardrails.** Pre-order is not a delivery order — no shipping address, no courier assignment (orders analyze as pickup/on-process). Stock is reserved at draft; releasing/voiding restores. Finalize is idempotent (retry-safe). No client-supplied totals anywhere.

## Module C — Credit Ledger (utang) filters

**C1** Unpaid/Paid tabs keep their semantics; add **Name search** (server-side `contains`) + **Date range** (default = all time; filter on **entry dates**, applied to the per-customer balance rows via aggregate: "unpaid entries in range"; per-customer ledger modal also gets the same from/to on entries). CSV export (if present) respects active filters. Mobile cards ≥ md table stays.

## Data model / API surface (draft)

- `Order.source` new enum member `PRE_ORDER`; `Order.signatureData` (text, nullable) + `signatureAt`.
- `LoyaltyEntry.type` + `ADJUST`.
- New: `POST /admin/customers`, `PATCH /admin/customers/:id`, `POST /admin/customers/:id/loyalty/adjust`, `POST /admin/pos/preorder`, `POST /admin/pos/preorders/:id/finalize`, `GET /admin/pos/preorders?from&to` (creator-safe: admin store-scoped), `GET /admin/credit-ledger?search&from&to&status` (entry-date filter); `POST /admin/pos/complete` now requires `signatureData` for credit payments.
- Existing: stock-delta edit (W1), void, receipt, loyalty earn/redeem gateway, holds — reused, not re-implemented.

## Tests & gates

- Unit: adjust guard (min-0, bad delta), preorder requires customer, finalize requires signature + idempotency, ledger filters, redeem-at-POS points math.
- Live E2E (real output pasted): create pre-order → edit items (stock delta) → finalize w/ signature → COMPLETED + utang entry + one REDEEM/one ADJUST record; ledger name+date filters return exact rows; cross-store 404 on customer ops.
- Gate: `npm test` (existing 150 + new), `npm run typecheck` (all 3), `next build`, live dashboard smoke (`/admin/dashboard` 200).

## Out of scope

Courier/delivery changes; customer-facing (storefront) loyalty redesign; multi-currency; paper-print integration beyond browser print of receipt.
# SAM STORE — Orders Workflow & Tab Routing Upgrade v3

Author: Hermes agent (2026-09-04), on behalf of store owner `extraricestore`.
Execute **one module per loop**: plan → implement → typecheck/test/build → update `docs/progress.md` → git checkpoint → report → wait `CONTINUE`. Every claim verified with real command output.

## §0 Locked decisions (operator-confirmed 2026-09-04 — do not re-litigate)

1. **Tabs restructure** (Orders panel): `Pending` (RECEIVED) · `On Process` (CONFIRMED, PREPARING, READY, ON_HOLD) · `For Delivery` (OUT_FOR_DELIVERY) · `Completed` (DELIVERED, COMPLETED) · `Void` (CANCELLED, FAILED_DELIVERY). **Marking an order CONFIRMED moves it from Pending → On Process.**
2. **Pending orders are editable**: RECEIVED (and CONFIRMED/ON_HOLD) orders support add/remove item with **stock-delta** (restore removed, deduct added) — same semantics as held orders.
3. **One-tap "Send for delivery"**: on a delivery-type pending/on-process order, a single action advances `CONFIRMED → PREPARING → READY → OUT_FOR_DELIVERY` (audited as one deliberate flow); the per-step dropdown remains available.
4. **"Move to completed"**: pickup/POS-type orders (`deliveryType = pickup | pos`) can go straight `RECEIVED → COMPLETED`. Delivery-type orders must pass through the delivery pipeline.
5. **Pending shows routing intent**: each pending row exposes whether it's a **delivery** order (has address / deliveryType=delivery) vs **pickup/POS**, and offers the matching action ("Send for delivery" vs "Move to completed").
6. Scope: Orders panel + POS/orders backend endpoints listed in §3. No unrelated refactors. Money integer minor units; totals server-authoritative; tenancy untouched.

## §1 Real findings from smoke test (2026-09-04, live)
- POS flows (cash sell + change, hold → edit → complete, utang, void) **all verified working** — no errors.
- Order transitions, all tab status filters, today-filter, combo filters **all return 200**.
- Gap: Orders tabs put CONFIRMED in Pending (operator wants it in On Process); OUT_FOR_DELIVERY is buried inside On Process (needs its own **For Delivery** tab); Pending orders (RECEIVED) have **no Edit / routing actions** and **no delivery-vs-pickup analysis**.

## §2 Modules (one per loop)

### W1 — Backend: edit + routing endpoints
- `PATCH /admin/orders/:id/items` — replace items for an order in `RECEIVED | CONFIRMED | ON_HOLD` (store-scoped). Behavior:
  - Load order + current items; validate availability of the new set (stock across warehouses).
  - Within one transaction: restore stock for removed quantities, decrement for added; replace `OrderItem`s; recompute subtotal/total; update `snapshot.lines`; append `OrderStatusHistory` entry (fromStatus=toStatus=current, reason "items edited").
  - Reject if status not editable (DELIVERED/COMPLETED/CANCELLED/OUT_FOR_DELIVERY etc.).
- `POST /admin/orders/:id/send-for-delivery` — one-tap advance: only from `CONFIRMED | PREPARING | READY`; walks `→ PREPARING → READY → OUT_FOR_DELIVERY` (idempotent — already-past states skipped); single status-history entry per hop; returns final status. Reject from RECEIVED (confirm first) and from non-delivery-type orders (deliveryType=delivery only).
- `POST /admin/orders/:id/complete-now` — `RECEIVED | CONFIRMED` → `COMPLETED` (paymentStatus → COLLECTED), allowed only when `deliveryType = pickup | pos` (server-enforced). Reject when the order has an address/deliveryType=delivery.
- `GET /admin/orders` unchanged (filters already support the new tab sets).
- Contracts: new request/response types in `packages/contracts`.

DoD: live E2E — edit a RECEIVED order (add + remove lines → stock delta exact), send-for-delivery lands in OUT_FOR_DELIVERY, complete-now on a pickup order → COMPLETED/COLLECTED, complete-now on a delivery order → 409 conflict.

### W2 — Orders panel tabs + routing UI
- Tabs per §0.1 (Pending / On Process / For Delivery / Completed / Void), each with the day-range + customer filters (already built).
- **Pending rows**: add per-row analysis chip — `delivery` (address present) vs `pickup/POS` — and actions:
  - Delivery-type: **Send for delivery** (one-tap) + Edit + the manual `→ CONFIRMED` dropdown fallback.
  - Pickup/POS-type: **Move to completed** + Edit.
- **On Process rows**: keep edit/pay/utang/void for ON_HOLD; add **Send for delivery** for CONFIRMED/PREPARING/READY delivery-type; keep per-step dropdown.
- **For Delivery tab**: OUT_FOR_DELIVERY-only list with call/navigate shortcuts (reuse courier-style tel:/maps deep links) + Delivered/Failed actions (role-gated) — singles them out from On Process.
- Edit modal reused for RECEIVED/CONFIRMED too (stock-delta via W1).
- Mobile cards + desktop table (existing pattern).

DoD: manual DOM/browser pass — after CONFIRMED, order appears under On Process and disappears from Pending; For Delivery tab shows only OUT_FOR_DELIVERY; pickup order completes in one tap; delivery order offers Send-for-delivery.

### W3 — POS/orders consistency + tests
- Ensure POS "Hold → complete" path and the new edit/routing endpoints don't double-decrement (shared stock helpers).
- Unit tests: order-state additions if any; item-edit validation (non-editable status), send-for-delivery hop logic, complete-now guard (pickup-only).
- Update `docs/progress.md` W1–W3; full `npm run typecheck` + `npm test` + `next build`; commit + push.

DoD: all gates green with real output; live E2E covering W1 flows; no regressions in POS smoke.

## §3 Explicit backend changes allowed
1. `PATCH /admin/orders/:id/items` (+ contracts) — stock-delta edit for RECEIVED/CONFIRMED/ON_HOLD.
2. `POST /admin/orders/:id/send-for-delivery` — one-tap advance to OUT_FOR_DELIVERY (delivery-type only).
3. `POST /admin/orders/:id/complete-now` — pickup/POS RECEIVED/CONFIRMED → COMPLETED.
4. No schema migrations. No changes to `OrderStatus` enum (ON_HOLD/COMPLETED already exist; RECEIVED → COMPLETED already in the state machine). Tenant + money rules untouched.

## §4 Constraints (non-negotiable)
- Bootstrap 5.3 only; no new deps. Mobile-first (375px). Additive API contracts only.
- No secrets/PII in UI. Multi-tenant rule untouched. One module per loop with real gates.

## §5 Definition of done (every module)
- Acceptance criteria met with real output (curl/tsx E2E, DOM assertions ok).
- `npm run typecheck` clean, `npm test` all green, `next build` succeeds.
- `docs/progress.md` updated; git commit + push; report → wait `CONTINUE`.
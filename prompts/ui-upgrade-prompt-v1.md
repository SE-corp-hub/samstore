# SAM STORE — Role-based UI/UX Upgrade Prompt v1

Author: Hermes agent (2026-09-04), on behalf of store owner `extraricestore`.
Execute **one module per loop**: plan → implement → typecheck/test/build → update `docs/progress.md` → git checkpoint → report → wait `CONTINUE`. Verify every claim with real command output. Stubs are stubs; label them.

## §0 Locked decisions (operator-confirmed 2026-09-04 — do not re-litigate)

1. **Admin shell**: fixed left sidebar with grouped nav (SELL · MANAGE · STORE · SYSTEM) + mobile drawer/topbar. No new routing library — keep the current tab-state model.
2. **Role-scoped nav**: tabs render ONLY what the role's backend endpoints allow (no more 403-on-click for MANAGER/STAFF).
3. **Overview tab**: KPI landing tab (today's sales, pending, out-for-delivery, low stock, utang owed) is the default dashboard tab for staff roles.
4. **Storefront credit checkout**: approved customers get "Pay on credit" at checkout (backend already supports it — wire the UI).
5. **Pickup toggle**: when `pickupEnabled`, storefront offers Delivery/Pickup choice; address optional for pickup (backend addition: `Order.deliveryType`).
6. **Success screen**: replace the raw claim-token code block with a clean "track your order" card (order number, total, live status, copy-link, share).
7. **Demo logins panel** on `/admin/login` — one-tap fill buttons for the seeded demo accounts, labeled "Demo only".
8. **Toast/alert system**: successes as auto-dismissing toasts, errors as inline alerts; confirm destructive actions with the existing modal pattern.
9. **Empty states & loading**: every panel gets an empty-state (icon + one-line hint + primary action) and skeleton/spinner loading instead of raw "Loading…".
10. **Scope discipline**: UI files + `apps/web` only, EXCEPT the explicit small backend changes listed in §3. No service/repository/schema refactors. English UI, PHP (`₱`) formatting — unchanged.
11. **Courier app**: full pass — logout, tel:/maps deep links, items summary, Recent (delivered/failed) section, sort by schedule.

## §1 Real gaps found (by role surface, from `apps/web/src` inspection)

### Admin shell (`app/admin/dashboard/AdminDashboard.tsx`)
- **All 17 tabs shown to every role** — STAFF/AGENT see POS/Stores/Maintenance/Team/StoreLink that their backend 403s (verified: `requireManage` = OWNER+PLATFORM_ADMIN guards store-link, vouchers write, transfers approve/complete, team manage, warehouses write). Clicking them yields dead ends.
- Nav is a flat pill list — no grouping, no icons, wraps badly on desktop, no collapse on mobile.
- Store switcher does `window.location.reload()` (full page bounce) — switch should remount panels without reload.
- No current-user display (name/role), no user menu, logout uses an arrow icon (`bi-box-arrow-right` — wrong glyph).
- Default tab is Orders; no KPI overview for quick decisions.
- Branding is a static "Sam's Admin" — store name/logo not reflected.

### POS (`admin/PosPanel.tsx`)
- No product search in the product grid; no category filter.
- No stock indicator on tiles (sells from a tile that may be 1-in-stock).
- No "last sale" summary card after completing a sale (only inline text); change for cash is shown but no tendered input — cashiers can't enter "paid ₱200, total ₱170" flows.
- No keyboard/touch scanner input for SKU.

### Orders (`admin/OrdersPanel.tsx`)
- Terminal-order rows show a receipt button for EVERY order incl. RECEIVED; void/refund only for COMPLETED (fine) but no row-level context menu.
- No filter/search (by order number, status, phone, date).
- No detail view inline (items, address, history) without opening receipt.

### Team / Customers / Utang / Products / Inventory / Expenses / Purchases / Vouchers / Stores / Warehouses / Maintenance
- Inconsistent table styling (some `table-hover`, some not), inconsistent action-button sizes/labels.
- No confirm on destructive deletes (expense delete, warehouse actions, product deactivate is a toggle — fine).
- Customers: profile modal exists but no quick "collect payment" from profile; team invites show temp password in the raw invite list with no "copy" affordance.
- Inventory: no per-warehouse breakdown expander; value summary fine.
- Analytics/Reports: no print-preview styling, tables overflow on mobile (no `table-responsive`).

### Storefront (`components/Storefront.tsx`, `ProductCard.tsx`, `CartDrawer.tsx`, `CheckoutForm.tsx`)
- **No search** and **no category chips** — all products in one grid.
- No product detail (description/quantity picker) — card-only.
- Cart drawer is solid but no per-line total clearing; fine overall.
- **Checkout is one long form**: no progress (Contact → Address → Review), no sticky order summary on desktop, no payment choice shown (hard-coded COD — approved customers are never offered credit; P3 decision #1 UI gap), vouchers/loyalty buried at the bottom with no balance hint.
- **No pickup/delivery toggle** even when `pickupEnabled` (settings exist; UI ignores).
- Store hours/cutoff (`orderCutoff`) never surfaced in hero.
- Success screen dumps the raw claim token as a `<code>` block — no readable tracking card, no copy button shared message.

### Customer account (`components/CustomerAccount.tsx`)
- Login/register only. **No order history, no loyalty balance/ledger** (server has `customerLedger`), no saved address/phone autofill, no credit status (approved-for-utang customers get no indication).

### Delivery courier (`components/DeliveryPanel.tsx`)
- **No logout button** in the courier app.
- No tel: link on phone, no maps link on address (Waze/GMaps deep link), no per-order item total/count summary, no failed-delivery history view, no sorting by schedule.

### Auth (`app/admin/login/AdminLogin.tsx`, `AdminLogin` homes)
- No demo-login hint panel; register page is bare (no role explanation, no "what happens next").

## §2 Modules (one per loop)

### U1 — Admin shell & navigation
- Fixed left sidebar (collapsible to icons on md, off-canvas drawer on mobile) with groups: **SELL** (POS), **MANAGE** (Orders, Products, Inventory, Expenses, Purchases, Team, Customers, Vouchers), **STORE** (Analytics, Reports, Settings, Store Link), **SYSTEM** (Warehouses, Stores, Maintenance).
- Every tab gets a bootstrap-icon glyph; active state = accent background.
- Store switcher: remount content by key without `location.reload()`; show store name + logo in the header.
- User menu (name + role badge + log out) top-right; correct icons throughout.
- Add **Overview** default tab (U3 depends on its data endpoints — they exist: `/admin/analytics/*`).
- DoD: role-gated nav list (U2 spec) renders; typecheck + build green; manual: one STAFF, one MANAGER, one OWNER screenshot-equivalent (no 403 hits in network).

### U2 — Role-based navigation map (server truth mirrored in UI)
| Tab | OWNER/PLATFORM_ADMIN | MANAGER | STAFF | SALES_AGENT |
|---|---|---|---|---|
| Overview | ✔ | ✔ | ✔ | ✔ |
| POS | ✔ | ✔ | ✔ | ✖ |
| Orders | ✔ | ✔ | ✔ | ✔ (view + delivery-state actions) |
| Products / Inventory | ✔ | ✔ | ✔ | ✖ |
| Expenses / Purchases | ✔ | ✔ | ✖ | ✖ |
| Team / Customers | ✔ | ✔ | ✖ | ✖ (customers = ✖ for STAFF too) |
| Vouchers | ✔ | ✖ (read-only list if any) | ✖ | ✖ |
| Analytics (sales-level) | ✔ | ✔ | ✔ | ✔ |
| Reports (profit) | ✔ | ✔ | ✖ | ✖ |
| Settings / Store Link | ✔ | ✖ | ✖ | ✖ |
| Warehouses (view) / Maintenance | ✔ | ✔ (view) | ✖ | ✖ |
| Stores (multi-store) | PLATFORM_ADMIN only | ✖ | ✖ | ✖ |
Implement a single `NAV_BY_ROLE` map in `lib/admin.ts`; dashboard reads it. Any tab the role can't open is hidden, not disabled. DoD: for each of the 4 staff roles, assert visible-tab set exactly matches backend permissions (verified by live 200/403 spot-check per tab).

### U3 — Overview dashboard (KPI landing)
- Cards: Today's sales (revenue + order count), Awaiting action (RECEIVED+CONFIRMED count), Out for delivery (count), Low stock (from inventory endpoint), Utang owed (OWNER/MANAGER only), plus a 7-day mini bar chart (reuse `BarChart` + `/admin/analytics/daily`).
- Each card links to its tab. Greeting with store name + "open storefront" shortcut.
- DoD: renders real numbers from live endpoints; responsive 1-col mobile / 3-col desktop.

### U4 — Storefront: catalog & ordering flow
- Search input (client-side filter over loaded products) + category chips (server `categoryName` on ProductDTO already included).
- Product card: sold-out overlay, low-stock hint, description line clamp; optional lightweight detail modal (qty stepper + add).
- Hero: show store hours/cutoff + delivery fee/min order as chips; keep P8 banner/accent.
- DoD: search + category filter tested in-browser; mobile-first grid unchanged.

### U5 — Checkout redesign (Storefront + CheckoutForm + cart flow)
- 3 visual steps with progress bar: **1 Contact** (name/phone, prefilled from customer account), **2 Delivery or Pickup** (toggle when enabled; pickup hides address fields), **3 Review & pay** (line summary, voucher apply w/ feedback, loyalty balance hint + redeem field, payment choice — COD default, **Pay on credit** only for approved+within-limit customers, THEN submit).
- Sticky order summary column on ≥lg screens; mobile collapsible summary.
- Success: replace token code-block with **Tracking card** — order number, total, "Cash on delivery" tag, live status via existing `/api/orders/track`, copy-track-link + share buttons.
- Backend changes allowed (small, explicit): `Order.deliveryType` ("delivery"|"pickup") + `Order.deliveryType` in snapshot, checkout accepts optional `paymentMethod: "credit"` for approved customers (already works — wire the UI), `required` address relaxed when pickup. NO total logic changes — server stays authoritative.
- DoD: guest COD order, logged-in credit order, pickup order all E2E-verified against live API.

### U6 — Customer account upgrade
- When logged in: loyalty **points card** (balance via `customerLedger`), **My orders** list (order number/status/date/total, tap to track), saved contact prefilled into checkout, credit status text ("You buy on credit up to ₱X — ₱Y owed") when applicable.
- DoD: customer@samstore.test sees their ledger + orders from live API.

### U7 — Delivery courier polish
- Header with app name + **log out**; auto-refresh retained.
- Each delivery card: call button (`tel:`), **navigate** button (Waze `https://waze.com/ul?q=…` or Google Maps `https://www.google.com/maps/search/?api=1&query=…` URL-encoded from address line 1), items count badge, total items qty.
- Group/sort by deliverySchedule when present; "Today" first.
- Add "Recent" section (last 10 DELIVERED/FAILED_DELIVERY) for recall.
- DoD: manual pass — card has call + navigate links that open correct deep links.

### U8 — Cross-panel consistency & accessibility pass
- `table-responsive` wrappers on every admin table; consistent `<h1 className="h4">` headers; consistent empty states (icon, hint, action).
- Toasts for success (POS complete, expense saved, purchase complete, utang payment, settings saved); inline alerts for errors only.
- Confirm modal for destructive deletes (expense delete, voucher delete) mirroring void/refund pattern.
- `aria-label` on icon-only buttons; focus-visible styles; alt text on storefront images.
- Login page: demo-login quick-fill panel (reads the seeded demo accounts; dev hint labeled "Demo only").
- DoD: full `npm run typecheck` + `npm test` (all existing tests still pass) + `next build` green; manual spot-check of each panel's empty/loading/error states.

## §3 Explicit backend changes allowed (everything else UI-only)

1. `Order.deliveryType` (String, default "delivery") + snapshot inclusion; checkout validation updates (pickup → address optional, no delivery fee).
2. Public store DTO already carries `pickupEnabled` — storefront uses it (no change).
3. POST `/public/checkout` already accepts `paymentMethod: "credit"` with customerToken — verify and keep; no new endpoint.
4. No schema migrations beyond `deliveryType` (+ default). No service/repository refactors. Tenancy untouched. Money stays integer minor units; totals stay server-authoritative (AGENTS.md).

## §4 Constraints (non-negotiable)

- **Bootstrap 5.3** UI only; no Tailwind/MUI/Ant. No new runtime deps beyond what's already installed (qrcode, bootstrap-icons). If a lib feels needed → ask operator first.
- Mobile-first: every screen usable at 375px wide.
- Keep every existing API contract intact except §3 item 1’s additive field.
- No secret/PII in UI text; demo logins panel shows passwords — acceptable because it's a dev seed, but wrap in `demo`-labeled card.
- Multi-tenant rule untouched: store A UI never queries store B data.
- One module per loop with real gates (typecheck/test/build pasted). Update `docs/progress.md` after each module. Commit + push per module.

## §5 Definition of done (every module)

- All acceptance criteria in the module's DoD met with **real** command/browser output pasted (curl/tsx E2E, screenshots not required — DOM assertions ok).
- `npm run typecheck` clean (contracts+api+web), `npm test` all green (no regressions), `next build` succeeds.
- No failing stubs; labeled TODO where a stub is temporarily necessary.
- `docs/progress.md` updated; git commit + push; report → wait `CONTINUE`.
# PINDIAN — Execution Plan (built on the existing "sam-store" base)

> Companion to `MASTER_PROMPT_PH.md`. This plan targets **building Pindian on top of the
> existing multi-tenant commerce platform currently at `D:\opencode project` ("sam-store")**,
> satisfying the master prompt's rule #1: *audit first, reuse existing components, never a
> destructive rewrite.* One module at a time; gates pass only with real command output;
> update `docs/progress.md` after every module; git checkpoint; report; wait for `CONTINUE`.

---

## 0. Context — audit result of the existing codebase

### 0.1 Stack already in place (reused as-is)

| Area | Existing implementation |
|---|---|
| Repo | npm-workspaces monorepo: `apps/api` (NestJS), `apps/web` (Next.js 15 + React 19 + **Bootstrap 5.3**), `packages/contracts`, `prisma/`, `docs/`, `scripts/` |
| DB | Prisma 6 + managed cloud Postgres (Supabase, `DATABASE_URL` set in `.env`); Redis via Upstash with **in-process fallback** (`REDIS_URL` unset → no-op, fine for single instance) |
| Money | **Integer minor units everywhere** — server-recomputed totals, client totals rejected (`src/domain/pricing.ts`) |
| Tenancy | Every store-owned table carries `storeId` from the first migration; tenant guard on every query; cross-store denial tested |
| Auth | JWT (bcrypt 12), phone-first identity (`User.phone` E.164 unique, A1), platform + store roles (OWNER/MANAGER/STAFF/SALES_AGENT/DELIVERY), role×permission deny matrix |
| Orders | Immutable line-item snapshot, store-scoped number via `StoreCounter`, single-use HMAC claim tokens, idempotency-key dedupe |
| Inventory | Multi-warehouse `StockLevel` + append-only `StockMovement` ledger (RESERVE/RELEASE/CONSUME/ADJUST/RECEIPT/TRANSFER), negative-stock guard, stock transfers |
| POS/cash | Registers + shifts (`RegisterSession`), cash movements, split payment, tenders, utang (credit) ledger, signature capture, printed receipts (`ReceiptModal`) |
| Money flows | Payments (`Payment`), expenses, purchases/suppliers, VAT model (`vatEnabled`, `vatRateBp` default 1200, `pricesIncludeVat`, `taxExempt`) |
| Commerce | Categories, products (SKU/barcode/unit), guest cart, COD checkout, order state machine, store settings, public store link, delivery + pickup flows, delivery status events, failed-delivery retry |
| Loyalty/vouchers | `LoyaltyEntry` ledger (EARN/REDEEM/ADJUST, balanceAfter), flatiscount vouchers with min-order/limits/concurrent-guard redemptions |
| Messenger | Provider interface + **suppressed/mock providers** + webhook signature verification; zero live Meta calls by design |
| Notifications | Transactional `OutboxEvent` (PENDING→PROCESSED/FAILED + retries) + `NotificationLog` |
| Ops | Rate limiter, audit log, ESLint + typecheck + secret-check scripts, **100+ unit tests** + Playwright E2E suite (9 specs), `docs/deployment.md` (Vercel + Supabase), `docs/progress.md`, `docs/runbooks.md` |

### 0.2 Gap vs. `MASTER_PROMPT_PH.md` (what must be built)

| Master-prompt section | Status on copied base | Work required |
|---|---|---|
| §3 Multi-tenant roles | Mostly done | Platform "Super Admin" store-creation/suspension UI gaps; customer approval flow exists (`StoreCustomer.approvalStatus`) |
| §4 Public store link | Done | Deep link + QR to Messenger not present |
| §5 Catalog | Partial | **No product variants or add-ons/modifiers**; no featured/tags/related/upsell/cross-sell |
| §6 Cart | Partial | No voucher/%/free-delivery redemptions in cart; no loyalty redeem at checkout; no senior/PWD discount line; no abandoned-cart recovery worker |
| §7 Checkout | Partial | Address is free-text (`line1/line2/landmark`); **PH Region→Province→City/Municipality→Barangay dropdowns missing**; DPA consent checkbox missing; order prefix is `SAMSTO-`, not `PIN-`; guest + logged-in split partial |
| §8 Orders | Done | Bulk status ops + CSV export may be missing; verify |
| §9 Inventory | Mostly done | Low-stock threshold per warehouse exists (`reorderThreshold`); unit-of-measure partial (`unit` on product); valuation report partial |
| §10 Loyalty | Partial | Earn/redeem exist; **checkout redemption, expiry, welcome/bonus/referral config, reversal on refund/cancel, anti-abuse dedupe missing** |
| §11 Vouchers | Partial | **% variants, free-delivery, first-order, per-customer limits, stackability rules, storewide promos missing** |
| §12 Messenger | Adapter-level done | Live connection UI (FB Login/Page connect), deep links/QR, full menu/postback **journey**, product cards/carousel templates |
| §13 AI chatbot | **Not built** | Live-data-only FAQ/search/order-status, Taglish, confidence fallback, handoff, audit trail |
| §14 Agent dashboard | **Not built** | Conversations/messages/assignment/SLA/canned replies (tables don't exist yet — add) |
| §15 CRM | Partial | Auto-store + aggregates exist; **segmentation + campaigns missing** |
| §16 Payments PH | Partial | **GCash/Maya/PayMongo gateway adapter missing** (PayMongo sandbox `PENDING_CREDENTIALS`); bank-transfer proof upload + payment-proof review queue missing; "received vs reviewed" states missing |
| §17 Shipping/delivery | Partial | **Delivery zones + per-zone ₱ fees missing**; courier adapters (Lalamove/GrabExpress/J&T mock) missing; COD remittance tracking partial |
| §18 Notifications | Framework done | SMS (Semaphore/Chikka mock) + email adapter interfaces + outbox worker loop; coverage of the 12 customer events |
| §19 Analytics | Partial | `AnalyticsPanel`/`reports` exist; add conversion, abandoned-cart, repeat-customer, voucher/loyalty usage, refund rate |
| §21 BIR tax | Partial | Config VAT done; **senior/PWD 20% statutory discount + ID capture missing**; e-invoice/CSF adapter `PENDING_CREDENTIALS`; Sales/Cash Receipts Journal export missing |
| §24 ERP-lite | Partial | Suppliers/purchases/expenses done; **chart of accounts + journal entries + double-entry + COGS/margin reports missing** |
| §22 Security/DPA | Partial | Consent records + data retention + NPC breach hooks missing; audit coverage gaps to close |
| §25 OpenAPI | **Not built** | Add OpenAPI docs for every endpoint |
| §26 Testing | Strong base | Extend to new modules; run the required two-store PH E2E scenario |
| §27 Deployment | Vercel+Supabase docs | Add Docker Compose + nginx + worker + CI/CD + setup guides (Meta/PayMongo/couriers/SMS/BIR) |

---

## 1. Non-negotiable constraints (inherited from `AGENTS.md` + master prompt)

1. **No local Docker, no local PostgreSQL.** Managed cloud Postgres (already configured) + managed Redis with in-process fallback.
2. **Bootstrap 5.3** only (no Tailwind/MUI/Ant).
3. **Tenancy from the first migration** — every new store-owned table carries `storeId`.
4. **Integer minor units for money**, server-authoritative pricing, immutable order snapshots, idempotency keys.
5. **Secret hygiene:** nothing secret in repo/commits/logs/prompts; `.env` never committed.
6. **Messenger:** provider interface + mock/suppressed providers only until operator supplies Facebook App + Page token + HTTPS webhook. Never guess a token.
7. **Capability fixture:** Docker/Postgres absence is by design (AGENTS.md). Supabase IS the Postgres; RLS is not used — tenant isolation is enforced in the app layer (current pattern), documented as such.
8. **Honest status everywhere:** sandbox adapters marked `PENDING_CREDENTIALS`; no fake "success".

---

## 2. Decision gates (RESOLVED 2026-09-16)

| Key | Decision | Resolved |
|---|---|---|
| D1 | Work location | **Copied source into `C:\Users\password\Desktop\extraricestore` with a fresh `git init`** (recommended: clean Pindian history; `D:\opencode project` kept as reference). Same GitHub account planned for a new `pindian` repo. |
| D2 | Dev database | **Reuse existing Supabase `DATABASE_URL`** — confirmed dev/sandbox-safe (migrations already present; "No pending migrations to apply"). Redis stays unset → in-process fallback. |
| D3 | Naming | **Keep `sam-store`/`@sam-store/*` code identifiers**; rebrand only user-facing copy to PINDIAN later. |
| D4 | Copy exclusions | Excluded `node_modules/ .git/ .next/ test-results/ logs/ lib/ *.tsbuildinfo .env`; kept `apps/ packages/ prisma/ docs/ scripts/ prompts/` + configs; `.env` recreated locally & gitignored. *Note:* `/XD lib` also matched `apps/web/src/lib` → restored explicitly. |

---

## 3. Milestones (one module per loop)

> Loop per module: plan → implement → format/lint/typecheck/test/build (paste real output) → bump `docs/progress.md` → git checkpoint → report → **wait for `CONTINUE`**.

### Model routing per phase (budget plan)

Tiers (per `AGENTS.md`):

| Tier | Model | Use for |
|---|---|---|
| **T1 — reasoning/risk** | `deepseek/deepseek-v4-flash-0731` → fallback **`z-ai/glm-5.3-flash`** | schema/migrations, money math, tenancy/authz, commerce invariants, adapter design, module planning, failing-test triage |
| **T2 — boilerplate volume** | **`inclusionai/ling-3.0-flash`** | CRUD scaffolding, DTO/plumbing, read-only panels, mechanical edits in established patterns, doc/OpenAPI volume |

Budget rules (apply to every phase):
1. **Plan + schema + money/authz work always T1.** Never save here — a tenancy or pricing bug costs more than the tokens.
2. **Batch all mechanical edits** (DTOs, panels, seed, docs, OpenAPI) and run them **in one T2 pass** per module.
3. When `deepseek` is unavailable/rate-limited, drop to `z-ai/glm-5.3-flash` for T1 — **never** route gate runs through `:free` variants (retry cost > paid tier).
4. Test *authoring* (voluminous asserts) is T2; *failing-test triage / invariant design* is T1.

Per-phase split (T1 share of the module's work):

| Phase | T1 (deepseek → glm-5.3-flash) | T2 (ling-3.0-flash) |
|---|---|---|
| 0 Foundation transfer | 20% (boot-debug reasoning) | 80% (copy, npm, scripts) |
| 1 PH context + portal | 70% (address schema, chain validation, tenancy) | 30% (dropdown UI, seed data volume) |
| 2 Catalog depth (variants/add-ons) | 60% (line identity, atomic stock, ledger) | 40% (picker/editor UI, DTO plumbing) |
| 3 Cart & checkout depth | 80% (voucher/loyalty/senior math, idempotency, consent) | 20% (forms/panels) |
| 4 Payments PH | 70% (gateway adapter, webhook idempotency, no-PCI rules) | 30% (proof-upload UI, DTOs) |
| 5 Shipping & delivery | 50% (zone model, courier adapter design) | 50% (zones UI, courier stubs) |
| 6 Messenger journeys | 60% (journey state machine, webhook security) | 40% (template wiring, connection UI) |
| 7 Chatbot + agent dashboard | 70% (live-data-only rules, fallback, handoff) | 30% (dashboard CRUD) |
| 8 CRM & campaigns | 40% (segmentation queries, aggregates) | 60% (panels, campaign plumbing) |
| 9 ERP + BIR | 85% (double-entry, COGS, VAT/senior engine) | 15% (report screens, exports) |
| 10 Compliance & security | 90% (DPA, breach hooks, audit completeness) | 10% (checklist docs) |
| 11 API docs + deployment | 20% (Docker/CI edge decisions) | 80% (OpenAPI volume, guides) |
| 12 E2E + readiness | 40% (E2E triage, checklist review) | 60% (test scaffolding volume) |

### Phase 0 — Foundation transfer & parity proof
- Copy source per D1/D4; fresh git repo; `npm install`; restore `.env` from source (local only).
- Parity gate: `npm run db:deploy`, `npm run db:seed`, boot API (:4100) + web (:3000), run unit tests + Playwright smoke, `npm run lint`. Storefront `/sam-store` and admin dashboard load.
- Resolve D1–D3; record decisions in PLAN.md + progress.md.
- **Model:** T2-dominant (copy + scripts); boot-debug reasoning on T1 fallback `z-ai/glm-5.3-flash`.
- **Accept:** all tests green; storefront checkout works; tenant guard demoed (A-Store cannot read B-Store). ✅ DONE

### Phase 1 — PH-context foundation (§20, §7 address, §3 portal)
1. **PH address model:** `regions/provinces/cities/barangays` lookup tables seeded with PH admin divisions; `addresses` table; checkout upgraded to cascading dropdowns (Region→Province→City/Municipality→Barangay) + Street/Blk/Lot + Landmark + instruction. Backfill-free (addresses already free-text in old orders).
2. **₱ / Asia/Manila / Taglish utils** in `packages/contracts`: `formatPesos`, `manilaNow`, `formatManila`, `pesoInWords` (Filipino money-in-words).
3. **Tenant + audit hardening check:** new-module regression tests; confirm every new endpoint reuses the tenant guard; document app-layer isolation (no RLS) in progress.md.
4. **Customer account portal:** register/login by phone (OTP-lite), profile + saved addresses, order history, loyalty balance, vouchers, consent management. Extend existing `CustomerAccount.tsx` + `customer-auth` service.
- **Status:** items **1 ✅** (`Ph*` tables + `db:seed:addresses` 17/17/60/592 curated PSGC-style subset, checkout cascade dropdowns + chain-validated name snapshot — Module P1, commit below), **2 ✅** (`format.ts`), **3 ✅** (hardening sweep documented: new tables tenant-scoped with cross-tenant tests; app-layer isolation noted in progress.md), and **4 ✅** (customer portal: register+login, `me` loyalty/credit/orders, saved-address book + consent, "use at checkout" prefill — Module P1.portal).
- **Model:** T1-dominant (70/30) — address schema + chain validation + tenancy on `deepseek` (fallback `z-ai/glm-5.3-flash`); dropdown UI + seed volume on `ling-3.0-flash`.
- **Accept:** PH dropdowns round-trip; portal flows tested; tenant regression suite green. ✅ (all green — 54 files / 371 tests)

### Phase 2 — Catalog depth (§5)
- Product **variants** (size/color/etc.) with per-variant SKU, price, and `StockLevel`; **add-ons/modifiers** (charges, taxable flag).
- Storefront: variant picker + add-on selector; cart lines carry variant/add-on selections; checkout snapshots them.
- Featured products, tags, search & filters, related/upsell/cross-sell; low-stock threshold surfaced per warehouse.
- **Accept:** variant cart/order/stock integrity tests; POS can sell variants.
- **Status:** **P2a ✅** — variants + add-ons end-to-end. **P2b ✅** — POS sells variants. **P2c ✅** — admin management of variants + add-ons (APIs + Products-panel `VariantEditor`, +6 DB tests). **Remaining P2d PENDING:** featured/tags/related/upsell, warehouse low-stock surfacing, add-on price revalidation at checkout.
- **Model:** T1-led (60/40) — line identity, atomic stock, ledger on `deepseek`/`glm-5.3-flash`; picker/editor UI + DTO plumbing on `ling-3.0-flash`.

### Phase 3 — Cart & checkout depth (§6, §7, §10, §11)
- Voucher engine v2: % and fixed, free-delivery, first-order, product/category-scoped, min-spend, usage + per-customer limits, **stackable/non-stackable rules**, storewide promos (`Voucher` extended + `VoucherRule` tables as needed).
- Loyalty-at-checkout: redeem balance as discount (atomic, dup-safe), earn on payment, **reversal on refund/cancel**, welcome/bonus/referral config, expiry job; customer-visible ledger.
- **Senior/PWD statutory 20% discount** (config/eligibility + ID capture field) + VAT handling on the discounted line.
- **DPA consent checkbox** at checkout → `consent_records` (auditable, per channel).
- Order number format to `PIN-YYYY-NNNNNN` via `StoreCounter` (per-store, configurable prefix).
- Abandoned-cart recovery: cart expiry job (`CartStatus.ABANDONED`) + outbox notification.
- **Accept:** voucher/loyalty/senior/tax math tests; duplicate redemption blocked; consent recorded.
- **Model:** T1-dominant (80/20) — voucher/loyalty/senior/VAT math, idempotency, consent invariants on `deepseek` (fallback `z-ai/glm-5.3-flash`); forms/panels on `ling-3.0-flash`.
- **Status:** **P3a ✅** — voucher engine v2 (types %, free-delivery, first-order, per-customer, product/category scope, stackable-with-loyalty; admin + panel + seed; +12 tests; live ₱194 smoke). **P3b PENDING** — loyalty earn/reversal/expiry/welcome config, senior/PWD 20% + ID capture, DPA checkout consent checkbox, `PIN-YYYY-NNNNNN` order numbers, abandoned-cart job.

### Phase 4 — Payments PH (§16)
- **Payment gateway interface** + **PayMongo sandbox adapter** (`PENDING_CREDENTIALS`): GCash, Maya, cards, GrabPay via gateway-hosted checkout; tokenized only — no raw card data.
- **Bank transfer + proof upload** (image validation, upload to object storage), payment-proof review queue, separate "**received** vs **reviewed**" states (`PaymentStatus` extended; webhook idempotency via existing `idempotencyKey`).
- Payment links; refund (full/partial) + status history.
- **Accept:** lifecycle tests (pending→received→reviewed→refunded); gateway mocked; no card data stored.
- **Model:** T1-led (70/30) — gateway adapter + webhook idempotency + no-PCI rules on `deepseek`/`glm-5.3-flash`; proof-upload UI + DTOs on `ling-3.0-flash`.

### Phase 5 — Shipping & delivery (§17)
- **Delivery zones:** zone model linking cities/barangays with per-zone ₱ fee + ETA; checkout picks zone from address (pickup/zone/out-of-coverage).
- **Courier adapter interface** + mock adapters (Lalamove, GrabExpress, J&T/JRS/NinjaVan-style) `PENDING_CREDENTIALS`; tracking number + `delivery_events`; COD remittance ledger (courier vs driver vs owner pickup).
- **Accept:** zone-fee math + coverage tests; courier mock end-to-end.
- **Model:** 50/50 — zone model + courier adapter design on T1 (`deepseek`/`glm-5.3-flash`); zones UI + courier mock stubs on `ling-3.0-flash`.

### Phase 6 — Messenger live + journeys (§12)
- Meta App/Page **connection UI** (FB Login), webhook registration + secret rotation, `messenger_users`/`messenger_pages` tables, messenger identity → customer mapping.
- **Journey engine:** welcome → persistent menu (browse categories → products → details) → add to cart → checkout collection via quick replies → order confirm → tracking updates; generic/button/carousel/image templates; typing + delivered/read receipts; deep links + QR for `/store/{slug}`.
- Adapter stays behind the interface; live calls only when credentials present (D-marked `PENDING_CREDENTIALS` otherwise).
- **Accept:** webhook signature/verification tests; journey state machine tests; portal shows mock "send suppressed" status.
- **Model:** T1-led (60/40) — journey state machine + webhook security on `deepseek`/`glm-5.3-flash`; template wiring + connection UI on `ling-3.0-flash`.

### Phase 7 — AI chatbot + human agent dashboard (§13, §14)
- **Conversation/message/assignment/agent tables** (tenant-scoped) + seed.
- **Chatbot engine:** intents (FAQ, product search, order-status, store hours, voucher/loyalty info); **queries live data only** — never invents stock/price/status/payment; Taglish; if unsure → "I'll ask our staff"; confidence threshold; safe fallback; conversation memory; full audit trail.
- **Agent dashboard:** live/in-progress list, takeover, assign, human/bot toggle, canned replies, quick replies, tags, search, SLA + response-time indicators, unread counts, agent performance metrics (feed existing analytics).
- **Accept:** fallback + handoff unit tests; chatbot returns only real data (tested against fixtures).
- **Model:** T1-led (70/30) — chatbot live-data-only rules + fallback + handoff on `deepseek`/`glm-5.3-flash`; agent-dashboard CRUD on `ling-3.0-flash`.

### Phase 8 — CRM & campaigns (§15)
- Enriched `StoreCustomer` aggregates (LTV, AOV, favorite products, recency, tags, campaign source) computed on write + rollups job.
- **Segmentation** (predefined + custom rules) and **follow-up campaigns** enqueued via `OutboxEvent` (Messenger broadcast where permitted; mock/suppressed until connected).
- **Accept:** segmentation query tests; campaign enqueue idempotent.
- **Model:** T2-dominant (60/40) — segmentation queries + aggregates on T1 (`deepseek`/`glm-5.3-flash`); panels + campaign plumbing on `ling-3.0-flash`.

### Phase 9 — ERP depth + BIR (§21, §24)
- **Chart of accounts + journal entries** (double-entry) auto-posted from sales, purchases, expenses, credit payments; COGS at inventory valuation; gross-margin per product/store; cash-flow report. (Modular: hidden unless owner enables.)
- **BIR:** senior/PWD discount + receipt lines (done in P3), VAT-exempt handling, receipt/invoice print aligned to BIR format incl. TIN (`ReceiptModal`), **Sales Journal + Cash Receipts Journal CSV export**, e-invoice/CSF adapter `PENDING_CREDENTIALS`.
- **Accept:** journal postings balance to zero; BIR slip print fixture verifies TIN/VAT/20% lines.
- **Model:** T1-dominant (85/15) — double-entry, COGS, VAT/senior engine on `deepseek` (fallback `z-ai/glm-5.3-flash`); report screens + CSV exports on `ling-3.0-flash`.

### Phase 10 — Compliance & security hardening (§22)
- DPA consent management + data-retention controls + **NPC breach-notification hooks**; CSRF, upload validation, output encoding; rate-limit coverage audit; audit-log completeness; security checklist written.
- **Accept:** security checklist reviewable; new endpoints covered by guards.
- **Model:** T1-dominant (90/10) — DPA/retention/breach hooks + audit completeness on `deepseek`/`glm-5.3-flash`; checklist docs on `ling-3.0-flash`.

### Phase 11 — API docs + deployment (§25, §27)
- **OpenAPI/Swagger** for every endpoint (auth, stores, store links, catalog, cart, checkout, orders, payments, customers, loyalty, vouchers, inventory, warehouses, delivery, POS/registers, credit, reports, notifications, analytics, webhooks, admin).
- **Docker Compose** (api, web, worker, nginx) + Dockerfiles + health checks + backup scripts + CI/CD; `.env.example` documented for all adapters.
- Setup guides: Meta App+webhook, PayMongo, couriers (Lalamove/GrabExpress), SMS, BIR e-invoice; extend `docs/deployment.md`.
- **Accept:** `docker compose up` boots stack; Swagger renders at `/docs`; CI renders from repo workflow file.
- **Model:** T2-dominant (80/20) — OpenAPI volume + setup guides on `ling-3.0-flash`; Docker/CI edge decisions on T1 (`deepseek`/`glm-5.3-flash`).

### Phase 12 — Full E2E + production readiness (§26, §28)
- **Required two-store PH scenario:** create *Lola's Sari-Sari* & *Kape PH* → separate owners/catalogs/public links → browse as guest → cart → voucher → loyalty redeem → guest checkout → payment update → inventory reserve → delivery update → Messenger notify (mock) → **verify Store A cannot read Store B** → customer sees only own orders → print BIR-style receipt.
- Full test report + **production-readiness checklist** (₱, Asia/Manila, Taglish, BIR, DPA, tenant isolation, mobile viewport, WCAG).
- Deliverables: source, schema+ER, OpenAPI, Messenger impl, dashboards (multi-store admin/store-owner/customer/agent), storefront, chatbot, catalog, cart/checkout, orders, inventory, CRM, loyalty, vouchers, payments, shipping, notifications, analytics, ERP-lite, Docker files, manuals (user/store-owner/super-admin), deployment guide, test report, security & DPA checklist.
- **Accept:** E2E green; checklist reviewed; git tag + summary.
- **Model:** T2-led (60/40) — E2E test scaffolding on `ling-3.0-flash`; E2E failure triage + production-readiness review on T1 (`deepseek`/`glm-5.3-flash`).

---

## 4. Test/verification strategy
- Unit (`node --import tsx --test ...`) for domain invariants (money, idempotency, tenancy, order state, voucher/loyalty math, tax).
- Playwright E2E (`npm run test:e2e`) for journeys (storefront checkout, pickup, POS, split-pay, receipt print already exist; extend for new modules).
- **Tenant isolation** tests on every new store-owned feature (A cannot read B).
- Mobile viewport + WCAG pass per new UI module.
- Every milestone: paste real gate output.

## 5. Risks / watch items
- **D2 (DB reuse)** — running 12+ new migrations on a live store DB could break production; if it's the operator's live DB, create a separate Pindian DB.
- `JWT_SECRET` missing from current `.env` (placeholder) — verify auth paths still boot; set secrets at Phase 0.
- Variant-aware stock touches the core `StockLevel`/`CartItem`/`OrderItem` shape — the highest-risk schema change; Phase 2 includes migration backfill + regression.
- Messenger journey is large; stays provider-interface-isolated so zero-credential risk.
- Renaming (`D3`) is deliberately deferred — churn-free.

---

*End of plan — one module per loop, real gate output, docs/progress.md after each, wait for `CONTINUE`.*
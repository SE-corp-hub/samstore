# PINDIAN — Progress Log

## M2 — People, signatures and approvals (Rice Ops, 2026-10-14)

| Item | Detail |
|---|---|
| Plan | `SAM STORE — Rice Operations Upgrade Plan`, module M2 of 13: PIN login and quick switch, home locations, the kargador list, signatures, the approvals inbox (Para sa iyo), document numbering and drafts (Tapusin). Built on M1 (`d8b0b44`). |
| PIN login | `POST /auth/pin-login` (mobile + 4 digits). Weak PINs refused (1111, 1234, 4321). Each try is reserved in ONE guarded `UPDATE` before the PIN is checked, so even parallel guesses get at most 5; the 5th wrong one locks PIN login for 15 minutes (password login still works; the owner can unlock). Unknown number and no-PIN accounts get the same answer and timing. Owner sets/changes a PIN in Team (`PATCH /admin/people/:userId`); a person changes their own with `POST /admin/me/pin`. Login page: "Staff: mag-login gamit ang PIN" with a big on-screen pad; the last number is remembered on that phone. Dashboard: **Palit user (PIN)** hands the phone to the next person. |
| Sign-out everywhere | New `User.tokenVersion` copied into the JWT as `tv`; the guard compares it (10 s cache, same contract as memberships). A new PIN from the owner, or removing a member, signs that person out on every phone. Tokens from before M2 count as version 0. |
| Home locations | `UserStore.homeLocationId` (empty = every location). `domain/people.canActAtLocation`: owner/manager everywhere; staff only at their home. Enforced when signing as staff, receiving a transfer, and opening/closing drafts. Team can add staff by **mobile number** (email optional) with a home location. |
| Kargadors | New `Kargador` (name unique per store, phone, https photo link, usual location, on/off) — not a login account. `GET/POST/PATCH /admin/kargadors`; Kargadors screen. Only an active kargador of the same store can sign. |
| Signatures | New `Signature` (document, step, signer kind STAFF/KARGADOR/CUSTOMER/SLIP_PHOTO, PNG + sha256, location, who captured it). **Insert-only**: a DB trigger refuses any UPDATE; a location holding signatures cannot be deleted (deactivate it). A STAFF signature is always the logged-in person (never a typed name). `domain/people.SIGNATURE_RULES` lists who signs each step; an unknown step fails closed. `captureSignatures` + `requireSignatures` run inside the step's own transaction. **First use: receiving a transfer** now needs the receiver's signature; without it the step is refused (422 "Kulang ang pirma: staff") and nothing moves. Locations screen: Complete → **Tanggapin** with read-back sentence and "Pirma ni …" screen (`SignCapture`, reused by M3+). `POST /admin/signatures`, `GET /admin/signatures`. |
| Approvals | New `ApprovalRequest` (kind, document, location, one-sentence summary, who may decide, status, decider, note). One PENDING per document+kind (partial unique index). `requestApproval()` for later modules; `registerApprovalHandler(kind, fn)` runs the module's follow-up inside the decision transaction. Decide with your own PIN; status claimed with one conditional UPDATE (decided once); losses/utang/write-offs default to OWNER only; a manager cannot approve their own request; a decline needs a reason; audit-logged. Screen: **Para sa iyo**. |
| Numbering | `nextDocNumber(tx, storeId, "REL")` → `REL-000123`, one `StoreCounter` per prefix (REL, TR, RSK, CNT, WO, RET, IN, SLP), atomic upsert-increment. |
| Drafts | New `FlowDraft` (flow, location, step, JSON ≤ 32 KB, version). Optimistic version check so a stale phone cannot overwrite a newer step; another phone can finish it. Over 2 hours = flagged. `GET/POST/PATCH /admin/drafts`, `POST /admin/drafts/:id/close`. Screen: **Tapusin** (view/cancel; flows open from here as M3+ land). |
| Migration | `20261014090000_rice_ops_m2_people`: additive only (User PIN/token columns, UserStore home location, 3 enums, 4 tables with RLS enabled, insert-only trigger, partial unique index). Applied on Postgres 16 after M1 and exercised: UPDATE of a signature refused; deleting a location with signatures refused; second PENDING approval for the same document refused; deleting a store cascades its kargadors/signatures. The PIN-lock SQL was run live: tries 1–4 count, the 5th locks for 15 minutes. |
| Known limits (deliberate) | `SLIP_PHOTO` accepts PNG only until M5 (paper slips) adds JPEG photos. Transfer receive stays owner-only (route unchanged); staff Ilabas/Tanggapin arrive in M3. The partial unique index and the trigger are raw SQL (Prisma does not model them); `prisma migrate dev` would propose dropping the index — use `migrate deploy`. |
| Verified in the build workspace | 26/26 pure unit tests (`domain/people.test.ts` 9 new + M1's 17); syntax check of every changed file; migration + trigger + partial index + PIN-lock SQL on Postgres 16; `npm run check:openapi` passes; route inventory regenerated (+13 routes). |
| Verified on the operator machine (2026-10-14, live Supabase DB) | Backup first: `BACKUP OK … samstore-20261014-1458.dump · 0.60 MB · 928 archive entries · 109 tables with data` (667 s). First `migrate deploy` hit `57014 statement timeout`: a stuck earlier pg_dump session (pid 124423, `idle in transaction` 1978 s on the pg_depend catalog query) held table locks. New `npm run db:doctor -- --stop-stuck` ended it and confirmed the failed migration left nothing (0/4 tables, 0/2 columns); `prisma migrate resolve --rolled-back` then `migrate deploy` → "All migrations have been successfully applied". `npm run typecheck` clean. `tsx --test domain/people|weight|stock-location` → **26/26 pass**. `tsx --test people/people-m2.test.ts` → **16/16 pass** (243 s). Migration now sets `lock_timeout = 20s` so a held lock fails fast instead of waiting out the 2-min server statement_timeout. Full `npm test` started; failures seen so far are outside M1/M2: `customers-v4` #5 (seed store `cmtl2go8u000194dgi5ysohv5` absent from the live DB), `customer-account` #4 and `cart/recovery` #1 (connection dropped / can't reach DB). Full suite to be re-run on a steadier connection. |
| To run on the operator machine | `npm run db:backup`, `npx prisma migrate deploy`, `npm run db:generate`, `npm run typecheck`, `npm test`. New DB test file `apps/api/src/people/people-m2.test.ts` (16 tests: unsigned receive refused; bad image refused; insert-only; unknown step; S2 staff can't act for S1; home location cross-store refused; 5 wrong PINs lock 15 min + unlock; parallel burst gets 5 tries; new PIN bumps token version; own PIN change; same answer for unknown/no-PIN; kargadors per store; approvals decided once with PIN; manager can't self-approve; numbers never repeat; drafts version conflict). `ledger-m1.test.ts` updated: receiving now signs. |

## M1 — Locations and the stock ledger core (Rice Ops, 2026-10-14)

| Item | Detail |
|---|---|
| Plan | `SAM STORE — Rice Operations Upgrade Plan`, module M1 of 13: the four locations, grams for loose rice, location prices, one ledger writer, and the stock bugs found in the audit. |
| Locations | `Warehouse` = a stock LOCATION: new `type` (STORE / WAREHOUSE), `code` (unique per store: S1, S2, S3, WH), `address`, `isActive`. New stores start with `S1 "Store 1"` as their default. `PATCH /admin/warehouses/:id` edits name/code/type/address, switches a location off (never the default) or makes it the default (exactly one). `npm run setup:locations -- --store <slug> [--apply]` turns a store into S1/S2/S3/WH (dry run by default, idempotent). |
| Location prices | New `LocationPrice` (product × location → selling price; cost stays one per product). `GET /admin/warehouses/:id/prices`, `PUT /admin/warehouses/:id/prices/:productId` (`priceMinor` or `null` = use the main price), audit-logged. `domain/stock-location.effectivePrice`. POS uses it from M5. |
| Grams | `domain/weight.ts`: `gramsForAmount` (by peso, rounds DOWN — ₱100 at ₱52/kg = 1923 g), `amountForGrams` (half-up once per line), `parseKilos`, `formatKilos`, `lossBasisPoints` / `lossNeedsApproval` (1% default). Stock stays integer grams. |
| Ledger core | `deductStock` takes ONE location — the one asked for, else the store default (legacy: the location-less row) — and never spreads a sale over other stores; the guarded write checks AVAILABLE (on hand − reserved) in one statement; a shortfall says how much is at other locations. `restoreStock` returns stock to the location the order took it from (read from the order's own ledger rows). New single transfer writer `transferStock`. `StockMovement` gains `documentType` / `documentId` (ORDER rows default to the order). POS pre-check uses the same one-location rule. Order item edits keep the order's location and name the editor. |
| Bugs fixed | Transfer created stock when the source had none and could push the source negative → guarded against available. Transfer could complete twice (status read outside the transaction) → status claimed with one conditional UPDATE inside it; approve/cancel claimed the same way. No unique key on (store, product, location) → migration merges duplicates and adds it. Sales picked the first row, not the store's → default location. POS sold reserved stock → guard on available. Voids restored to the first row → original location. `setStock` overwrote quantities with no reason/actor and was open to STAFF → owner/manager only, reason required, attributed ADJUST through the ledger + audit row. Toast built HTML from text (location/product names) → DOM + `textContent`. |
| Migration | `20261014060000_rice_ops_m1_locations`: enum + location columns; stores with locations but no default get their oldest as default; stores with location-less stock get a "Main" default; location-less stock rows AND their product-level ledger rows move to the default together (reconcile identity preserved); duplicates merged (quantities summed, `Product.stockLevelId` repointed); unique key; ledger document columns; `LocationPrice` with RLS enabled. Verified on a throwaway Postgres 16 after all 64 earlier migrations: duplicate −71 + 17 → one row −54 (reserved and threshold carried), legacy rows/ledger moved, oldest-default and "Main" cases correct. |
| Known limits (deliberate) | `StockLevel.warehouseId` stays nullable in the type: 26 older test fixtures create location-less rows. Every existing row gets a location from the migration and new code always sets one; making it required waits until those fixtures are updated. Online-checkout reservation (`createAtomic`) and stock conversion are unchanged here (M3/M4/M5 rework them). Product-edit stock still writes its own ADJUST row (to be replaced by counts in M8). |
| Screens | Admin "Warehouses" → **Locations**: add/edit with code, type and address, make default, switch off, transfers with Cancel and location codes, and a "Selling price per location" table. Labels are associated with inputs. |
| Verified in the build workspace | 17/17 pure unit tests (`domain/weight.test.ts`, `domain/stock-location.test.ts`); strict typecheck of the two pure modules; syntax check of every changed file; migration applied and checked on Postgres 16; the guarded decrement SQL checked live (takes when available, refuses when short, refuses a negative legacy row); `npm run check:openapi` passes; route inventory regenerated (+4 routes). |
| Verified on the operator machine (2026-10-14, live Supabase DB) | Migration `20261014060000_rice_ops_m1_locations` applied (`db:doctor`: "applied"). `tsx --test inventory/ledger-m1.test.ts` → **11/11 pass** (138 s); pure tests (weight, stock-location) pass in the 26/26 run above. Backup script hardened while running it: finds `C:\Program Files\PostgreSQL\<v>\bin` without PATH, live progress, 20 s connect timeout, TCP keepalives, automatic retry on a dropped connection (the first live attempt failed with `SSL SYSCALL error: EOF detected`). |
| To run on the operator machine (needs the packages + the database) | `npm run db:backup` first. Then `npx prisma migrate deploy`, `npm run db:generate`, `npm run typecheck`, `npm test`, `npm run reconcile`, `npm run setup:locations -- --store sam-store`. New DB test file: `apps/api/src/inventory/ledger-m1.test.ts` (11 tests: unique key, default-location sale, no silent spread, reserved not sold, explicit location + void to origin, transfer cannot create stock, concurrent completions move stock once, destination row created + cancel, reasoned stock-set, location prices, location codes/default rules). |

## M0 — Prepare the Rice Ops release (2026-10-14)

| Item | Detail |
|---|---|
| Plan | `SAM STORE — Rice Operations Upgrade Plan` (Claude doc), module M0 of 13. Operator decision: build module by module, stop after each for CONTINUE (AGENTS.md unchanged). |
| Finding | Local `main` (83 commits, root `c62c011` "Phase 0: foundation transfer into extraricestore", head `d7a893a`) and GitHub `extraricestore/samstore` `main` (`30a2131`, the older sam-store line) have **unrelated histories**. Replacing GitHub `main` would be a force-push, which AGENTS.md reserves for explicit operator approval — so local `main` is pushed to a **new** branch `pindian-main` instead, and GitHub `main` is left untouched. |
| Secret scan of the full history | All 83 commits re-built from `.git` and scanned (postgres/redis URLs with passwords, OpenRouter/OpenAI-style keys, JWTs, `JWT_SECRET=` values, GitHub tokens, AWS keys, `.env`/key files). Only hits: the placeholders in `.env.example` (`USER:PASSWORD@HOST`, `replace-with-32-plus-random-chars`). `git fsck --full` clean. Largest blob 0.78 MB (`.archify` HTML). |
| Backup | New `scripts/backup-db.mjs` + `npm run db:backup`: reads `DATABASE_URL` from `.env` without printing it, switches a Supabase transaction-pooler URL (6543) to session mode (5432) for `pg_dump`, writes `backups/samstore-YYYYMMDD-HHMM.dump` (custom format), then verifies it with `pg_restore --list` (fails unless table data is present). `backups/` and `*.dump` are gitignored. Tested end-to-end against a throwaway Postgres 16: `BACKUP OK … 4 archive entries · 2 tables with data`, exit 0; missing tools → exit 3 with install steps; unreachable DB → exit 4 with the URL masked. |
| Branch | `release/rice-ops` is cut from `pindian-main` after the backup is verified. |
| Not done here (needs the operator) | The push itself (this session's GitHub access is read-only, 403 on push) and running the backup (needs the real `DATABASE_URL`, which stays on the operator's machine). |

## UI/UX — admin console theme, foundation loop (warm light on the brand)

| Item | Detail |
|---|---|
| Request | Analyze the whole project and improve design/UI-UX on the admin console only (operator-confirmed: storefront and auth pages untouched; warm-light direction on the existing brand; foundation first, then batches). |
| Design system | Persisted source of truth: `design-system/sam-s-store-admin/MASTER.md` (operator-approved direction, tokens, component specs, anti-patterns, pre-delivery checklist). The tool's initial dark-glassmorphism recommendation was rejected as off-brand and off-stack (Bootstrap 5.3 mandate). |
| Foundation (this loop) | `globals.css` gains admin tokens (`--sam-sidebar #2b2118`, `--sam-border #e9e2d8`, `--sam-text #33261d`, `--sam-radius`, `--sam-shadow`, `--bs-focus-ring-color` terracotta) plus an `admin-shell`-scoped theme: dark coffee-brown sidebar with terracotta active pill, topbar surface, card/modal radius+border, dense table chrome (uppercase muted thead, tabular-nums), single 150ms transition, `:focus-visible` outline, `prefers-reduced-motion` collapse. Storefront/auth pages untouched (scoped). |
| Shell | `AdminDashboard.tsx`: `admin-shell` wrapper, `admin-sidebar` aside, nav pills with terracotta active state (replaces Bootstrap default blue `bg-primary`), topbar `admin-topbar`, group labels, `bi-shop` brand row. |
| High-traffic screens | Headers already followed the `<h1 className="h4">` + Bootstrap-Icons pattern (Orders, POS, Pre-Orders) — normalized by CSS. Removed the decorative emoji from Overview ("Good day! 👋" → "Good day!"). |
| Verified | typecheck clean; lint 0 errors / 297 warnings (unchanged); secret scan 0 high; web production build compiled; E2E regression **12 passed** across the six shell-dependent specs (login, expired-session, platform switcher, register confirm, storeless onboarding, platform user management). |
| Next loops | Batched panel passes: (a) POS + Pre-Orders + Orders interaction polish, (b) money/sell panels, (c) platform surfaces (Stores, User Access, Maintenance). Each loop re-runs the gates and a relevant E2E slice. |

## Platform admin — user management end to end (audit B1–B9)

| Item | Detail |
|---|---|
| Request | "On admin platform, analyze everything, hide functions that the role can't use, improve the functionality of the platform admin, fix if not working; platform admin is to manage user and store; can also create users." |
| Audit summary (B1–B9) | **B1** store picker — a platform admin's User Access store picker listed nothing (`/admin/stores/mine` is empty for them) → **fixed** (fetch `/admin/stores`). **B2/B3** role lists — the add-user and role-change lists offered `PLATFORM_ADMIN`, an action the API rejects everywhere → **fixed** (platform: `OWNER/MANAGER/STAFF/SALES_AGENT/DELIVERY`; owner: `MANAGER/STAFF/SALES_AGENT/DELIVERY`). **B4** reset gate — the Reset button appeared on rows a platform admin may not reset → **fixed** (renders only when `!isPlatform \|\| m.role === "OWNER"`). **B5** store-scoped panels failed generically with no store selected → **fixed** (shared "Select a store" gate on Analytics/Settings/Maintenance/Reports; platform add-user routed to `POST /admin/users`). **B6** `analytics/daily` ignored the `days` query (read `@Headers("days")`) → **fixed** (`@Query("days")`, clamp 3..90). **B7** Reports CSV window sent `?days=N` the route does not read → **fixed** (`from`/`to` ISO dates). **B8** invited users did not have to change their password on first login → **fixed** (`mustChangePassword: true` on invite). **B9** platform admin could not create users at all → **fixed** (new platform-only `POST /admin/users`, 201, one-time temp password, audit-logged). |
| What changed per task | **T1** `AuthService.createPlatformUser` + `POST /admin/users` (role/email/phone/storeId validation, bind-vs-create semantics, temp password + must-change, audit row) with 5 real-Prisma tests. **T2** `team.service.ts` invite sets `mustChangePassword: true` on new accounts. **T3** `analyticsDaily` binds `days` from the query string. **T4** `UserAccessPanel` rework: platform store picker, honest role lists, reset gate, platform add-user via `POST /admin/users`. **T5** `NoStoreScope` gate on the four store-scoped panels + Reports CSV `from`/`to` fix. **T6** spec 17 completed to 7 assertions covering the whole platform surface; regressions 02/14/16 green; this docs entry + commit. |
| Tests | `17-platform-user-management` **7/7**: picker lists Sam's Store; storeless Analytics prompt; platform add-user (role list without `PLATFORM_ADMIN`, temp password shown once, new member listed, Reset absent on the STAFF row / present on the OWNER row, STAFF role-change list without `PLATFORM_ADMIN`); `analytics/daily?days=7` returns ≤ 7 entries (API, with `X-Store-Id`); STAFF sidebar shows POS but no Stores/User Access; last-owner demotion refused by the API (409 "Cannot demote the last active owner") and surfaced in the UI; owner's Team surface lists only MANAGER/STAFF/SALES_AGENT/DELIVERY to add and no `PLATFORM_ADMIN` to assign. Regressions `02-admin-login`, `14-platform-admin-store-switcher`, `16-storeless-owner-onboarding` **3/3**. |
| Gate | Typecheck clean; lint 0 errors, **297 warnings** (baseline 301 — not raised; count drifted down on pre-existing warnings in untouched files); secret scan **0 high-severity** findings; web production build compiled (dev server stopped for the build, then restarted); web `/admin/dashboard` and API `/health` **200** after restart. |
| Operator notes | Temporary passwords are **shown once** (add-user and reset), never logged, and the account must change its password on first login. Platform admins can now **create users** (`POST /admin/users`, platform-only, 403 for everyone else) and manage any store's users through the User Access store picker. The invite flow now **forces a first-login password change** for every newly invited account. |
| Follow-up (deferred, ruling 2026-10-13) | The owner's Team panel's role-change select used to offer an **OWNER option** the API rejects with 422 (`team.service.ts:75-77`) — **closed 2026-10-13**: the option is removed from `TeamPanel.tsx`; the role-change list is now exactly `MANAGER/STAFF/SALES_AGENT/DELIVERY`. Owners are not given a User Access tab (`TABS_BY_ROLE`); the unified panel's owner-mode lists (exactly the four staff roles) are covered by Task 4's review. |

## Final review fixes — platform admin surface (2026-10-13)

| Item | Detail |
|---|---|
| OWNER option | The owner's TeamPanel role-change select no longer offers OWNER (the API rejects it with 422). User-visible: the select now lists exactly the four staff roles on every row. |
| Audit actor | `platform.user.create` audit rows now record `actorId` (the acting platform admin, from `user.sub`), matching every other admin audit write. |
| Bind role alignment | Binding an existing account to a store now aligns the global `User.role` with the membership role (`OWNER → STORE_OWNER`, otherwise the role itself), so the bound user's JWT-driven UI matches their membership. |
| Atomicity | `createPlatformUser` writes (user + membership + audit) are now one `prisma.$transaction`; a `P2002` unique-constraint race on email/phone returns the same `conflict` shape as `register` instead of a 500. |

## Fix — a new owner is told no store is linked, instead of landing on a broken dashboard

| Item | Detail |
|---|---|
| Symptom | Registering an owner and signing in dropped you on the full tab shell where every store-scoped call answered 403. The overview then said "Select a store from the switcher above" — on a screen with no switcher, because the account reaches no store at all. |
| Why | Public registration deliberately creates a bare `STORE_OWNER` with **no membership**, and only a platform admin can create or bind a store (`auth.service.ts`). The dashboard never distinguished "no store yet" from "store not selected". |
| Fix | The dashboard now tracks whether the store list is still loading, loaded, or failed, and for a signed-in account that reaches **no** store it renders an explanation — *"No store linked yet … a platform admin has to create your store or invite you to one"* — with **Check again** and **Sign out**, instead of the tab shell. A failed lookup gets its own retry card rather than a shell that 403s. A `PLATFORM_ADMIN` is excluded from the gate, since an empty `/admin/stores/mine` is normal for them and the platform list fills the switcher instead. |
| Refactor | The store lookup moved into a reusable `loadStores()` so **Check again** can re-run it; the platform-admin branch now lives inside it. Behaviour for members, platform admins and 401 handling is unchanged. |
| Tests | New `apps/api/e2e/16-storeless-owner-onboarding.spec.ts` registers a real account, loads the dashboard, asserts the explanation appears and that neither "Failed to load overview" nor the unmatchable switcher prompt does — then deletes the account. Regressions: `02-admin-login`, `13-expired-session-redirect`, `14-platform-admin-store-switcher` — **4 passed**. |
| Stale test repaired | Spec 14 asserted "the platform list should hold more than one store", which was true when it was written (262 fixture stores) and false after the sweep to one. A test-data premise, not a regression — the cross-tenant switch is now exercised when a second tenant exists and otherwise annotated explicitly instead of silently skipped. |
| Gate | Typecheck clean; lint unchanged at **301 warnings** (0 errors); secret scan 0 high-severity findings; web production build compiled; web and API both 200 after restart. |

## Security — tokens are signed with a real secret, and the algorithm is pinned

| Item | Detail |
|---|---|
| Finding | `.env` had no `JWT_SECRET`, so `app.module.ts` fell back to the constant `dev-jwt-secret-change-me-0123456789` **committed in this repository** at four injection sites. Anyone with the source could mint an OWNER or PLATFORM_ADMIN token. |
| Compounding finding | `verifyToken` passed no `algorithms` list, so verification accepted whatever algorithm the token claimed. Demonstrated directly: a token signed **HS512** carrying `role: PLATFORM_ADMIN` was **accepted** by the old code and is now rejected with `invalid algorithm`. The two findings together were a complete account-takeover path. |
| Fix | A 64-character random `JWT_SECRET` now lives in `.env` (gitignored, never printed, never committed). `auth.domain.ts` signs with `algorithm: "HS256"` and verifies with `algorithms: ["HS256"]`, exported as `JWT_ALGORITHM` so a future move to RS256 is deliberate. |
| Fix — no more silent fallback | `main.ts` now warns loudly in development when `JWT_SECRET` (or `CLAIM_SIGNING_SECRET`) is missing, instead of printing a neutral "development mode" line. That silence is exactly what let this hide. |
| Tests | `auth.service.test.ts` **18/18**, including four new cases: the header is always HS256; a different-algorithm token is rejected even with the correct secret; an unsigned `alg: none` token is rejected; a token signed with another secret is rejected. |
| Verified live | API restarted with its stdout captured: the startup log shows no secret warning, so the value was read. `POST /auth/login` → **201** with a token; that token → `/admin/me` **200**; a token forged with the old in-repo placeholder → `/admin/me` **401**. |
| Gate | Typecheck clean; lint 0 errors, **301 warnings (was 299)** — both new warnings are the startup `console.warn` calls in `main.ts`, which already logs at boot; disclosure rather than a silent baseline move. Secret scan 0 high-severity findings. |
| Operator impact | Existing browser sessions were signed with the old secret and are now invalid — logging in again is required. Rotation is the same procedure: replace `JWT_SECRET` in `.env` and restart. |
| Left open, stated plainly | The placeholder constant still exists in `app.module.ts` as a development fallback, now guarded by a loud warning rather than removed; centralising it remains worthwhile. `SESSION_SECRET` and `BCRYPT_ROUNDS` in `.env` are still dead config (rounds are hard-coded to 12). |

## Fix — registration asks for the password twice

| Item | Detail |
|---|---|
| Request | On `/admin/register`, add a re-enter field so a mistyped password is caught before the account is created. A password a store owner mistypes is otherwise unrecoverable. |
| Client | `AdminRegister.tsx` gains a "Re-enter password" field with an inline "Passwords do not match" hint that appears as soon as the two diverge and clears when they match. Submission is blocked before the round-trip. |
| Server | `passwordConfirm` is now **required** by `REGISTER_DTO` and compared in `AuthService.register`, mirroring the rule `change-password` already enforced (`auth.service.ts:232`) rather than inventing a second convention. Only the register page calls this endpoint, so requiring it breaks no caller. |
| Tests | `auth.service.test.ts` 14/14 — a mismatched confirmation is a `validation` error naming the mismatch, a matching one succeeds. New `apps/api/e2e/15-register-password-confirm.spec.ts` proves the form blocks submission, stays on the page, and clears the warning once corrected. |
| Bug the test caught | The error banner was **stale**: after a blocked submit, typing the corrected password left "Passwords do not match" on screen. The field now clears the error as the user edits. |
| Gate | Typecheck clean; lint at its 299-warning baseline (0 errors); secret scan 0 high-severity findings; web production build compiled; `/admin/register` 200 after restart. |
| Note on `02-admin-login` | That E2E failed twice on this run and is **not** caused by this change: `/admin/orders` measured 12.8s, then 1.6s, then 2.8s/0.9s/1.2s/0.9s across identical calls. The endpoint is a single flat `findMany(take: 200)` with no N+1; the variance is the Supabase pooler stalling a connection, against a 60s test budget covering login + dashboard + orders. |
| Accessibility gap noted | Neither the login nor the register form associates its `<label>` with its input (no `htmlFor`/`id`), so `getByLabel` cannot find them and screen readers get no accessible name. Left alone here — it is a separate, mechanical fix across both forms. |

## Insurance — daily database keep-alive so Supabase cannot auto-pause the project

| Item | Detail |
|---|---|
| Risk | Supabase pauses a **Free Plan** project after 7 days with too little *database* activity. The operator's other project (`pindian-staging`) was paused on exactly this rule, so `yeklfbggabxydnzfyorb` is exposed to the same fate — it has survived only because it is actively developed. Free tier also keeps **no backups**, so a restore past the window means the data is simply gone. |
| Rule that shapes the fix | Supabase's pause scanner measures **Postgres**, not HTTP: "a few user requests to the database each day" clears the threshold, and paid projects cannot be paused at all. Pinging `/auth/v1/health` or any non-DB endpoint is a documented false comfort — it generates no database activity. |
| Fix | `scripts/keepalive.ts` runs one real query (`SELECT 1` plus a `count(*)` read of `Store`) on a single pooled connection. `.github/workflows/supabase-keepalive.yml` runs it daily at 07:17 UTC, reusing the `DATABASE_URL` secret CI already uses — no new secret. |
| Honesty guards | The job is skipped (never faked green) when `DATABASE_URL` is unset, it runs on an off-peak minute because scheduled Actions runs can be delayed, and the script exits non-zero on failure so a broken ping shows red. |
| Verified | `npx tsx scripts/keepalive.ts` → `KEEPALIVE ok in 6182ms — ping=1 stores=1` (real query, 6.2s of it is pooler latency). Workflow YAML parsed: 1 job, cron `17 7 * * *`, 5 steps. Typecheck clean; lint at its 299-warning baseline; secret scan 0 high-severity findings. |
| Limitations, stated plainly | This is **insurance, not a fix** — the only guaranteed answer is upgrading the project to Pro. It also depends on the repo running scheduled Actions (GitHub disables scheduled workflows after long periods of repository inactivity) and on the secret staying configured. A local alternative needs no remote at all: Windows Task Scheduler running `npx tsx scripts/keepalive.ts` daily, which works whenever this machine is on. |

## Housekeeping — 261 test stores swept, demo store proven intact

| Item | Detail |
|---|---|
| Why | The platform store list a `PLATFORM_ADMIN` browses held **262 stores** — every non-demo store had a machine-generated name/slug (fixture tenants left by aborted runs). Approved by the operator. |
| Tool | New `scripts/cleanup-test-stores.ts` (dry-run by default, `--apply` to delete). It discovers the store-owned tables and their foreign keys from the **live catalog** instead of a hand-written list, which the older `cleanup-test-fixtures.ts` does — that hand-list predates `AuditLog`, `Cart`, `DeliveryZone`, `StockConversion`, `MessengerPage`, `Campaign`, `RolePermission` and others, and its `TEST_STORE_SLUG` regex matched a fraction of the fixtures. `sam-store` is pinned in `KEEP_SLUGS` and can never be deleted. |
| FK reality found | The graph contains a genuine cycle: `Product.stockLevelId` → `StockLevel` while `StockLevel` → `Product`, so no delete order exists. `Product.stockLevelId` is nullable, so the sweeper nulls it on the doomed rows first (reported in its output) and then deletes in topological order. Both faults in my first attempt (an inverted "ready" test that deleted parents before children, then a splice that left dead code) were caught by the script aborting loudly rather than half-deleting. |
| Result | **261 test stores and 984 dependent rows deleted**, plus **331 orphan rows** (`AuditLog` 321, `Cart` 10) left by the older hand-listed sweeper. Final orphan check: *clean — no row points at a deleted store.* |
| Demo store | Verified untouched: `sam-store` keeps **191 orders, 66 customers, 8 products, 10 stock levels, 25 credit entries, 4 vouchers, 1 register** — identical counts to the pre-cleanup inventory. `GET /admin/stores` as a platform admin now returns exactly `sam-store`. |
| Side effect | `persistence/integrity.test.ts` now passes **5/5** (it had been failing on stale Phase-4A E2E orders — those lived in fixture stores, so they went with the sweep). `scripts/reconcile.ts` improved from **6 drifts to 2**. |
| Remaining drift | Both are the known duplicate-`StockLevel` defect: `KAPE-001` at `sam-store` has two rows (`onHand=-71`, `onHand=17`) where the ledger implies 25. Real data, so correcting it is a separate decision; the durable fix is a unique `(storeId, productId, warehouseId)` constraint plus merging the rows. |
| Gate | Workspace typecheck clean; lint at its 299-warning baseline (0 errors); secret scan 0 high-severity findings. API restarted and `/health/ready` 200. |
| Not done | The 6 stale orders and the orphan order `01P2PV-000001` that broke `pos-variant.test.ts` earlier were **not** touched — the operator has not approved deleting rows inside the live demo store. |

## Fix — the PLATFORM_ADMIN role can finally see data

| Item | Detail |
|---|---|
| Symptom | A platform operator logged in and got "Failed to load overview", with every store-scoped widget empty. |
| Root cause | The API was right and the web app was wrong. Probed live as `platform@samstore.test`: `/admin/stores` → **200 with 262 stores**, and with `X-Store-Id: <any store>` the widgets returned **200 with real data** (`analytics/status`: 61 RECEIVED / ₱8,904; `analytics/daily`; `inventory?status=low`: Kape Barako; `settings`). With no store header all four returned **403 "No active store membership"** — which is deliberate, per `auth/tenant-context.ts:7-8` ("PLATFORM_ADMIN is a global bypass that still requires an explicit store target (header) or an ACTIVE membership"). The seeded platform admin holds **0 memberships** (`/admin/stores/mine` → `stores: 0`), and `AdminDashboard.tsx` built the store switcher from `/admin/stores/mine` only — so the switcher was empty, `X-Store-Id` was never sent, and the four store-scoped tabs granted to `PLATFORM_ADMIN` could never resolve a tenant. |
| Fix | The dashboard now also loads the platform-wide store list for a `PLATFORM_ADMIN` (labelled `(platform)`), the switcher renders for that role, and no store is auto-selected — the operator picks the tenant to inspect. `OverviewPanel` distinguishes "every widget refused for want of a store" (all three 403) from a genuine load failure and now says *"Select a store from the switcher above to view its dashboard."* |
| Tests | New `apps/api/e2e/14-platform-admin-store-switcher.spec.ts`: the platform admin sees the actionable prompt (not "Failed to load overview"), finds Sam's Store in the switcher, sees that store's widgets load, and switching to another tenant re-scopes them. Also `02-admin-login` and `13-expired-session-redirect`: 3 passed. |
| Gate | Workspace typecheck clean; lint back to its **299-warning baseline** (0 errors) after removing the `any` and non-null assertions this change introduced; secret scan 0 high-severity findings; web production build compiled successfully; web 200 after restart. |
| Follow-up found | The platform store list holds **262 stores**, overwhelmingly leftover E2E fixtures — it pollutes the operator's store picker. Cleanup approved by the operator and done in the next entry. |

## Housekeeping — test stores removed from the platform list

## Fix — a dead admin session no longer shows "Failed to load overview"

| Item | Detail |
|---|---|
| Symptom | The dashboard reported "Failed to load overview" and the operator was stuck there. |
| Root cause | Two facts, proved against the running API: all three overview widgets (`/admin/analytics/status`, `/admin/analytics/daily`, `/admin/inventory?status=low`) answered **401**, while the same three answered **200** with a freshly issued token. `AdminDashboard.tsx` only redirected when the token was **missing** — a token that is present but expired or foreign sailed through, `/admin/me` and `/admin/stores/mine` 401'd silently, and every panel then reported a generic load failure. No component anywhere handled a 401. |
| Fix | `handleUnauthorized()` in `apps/web/src/lib/admin.ts` clears the dead token and store id and returns the operator to `/admin/login`, returning `true` so callers stop. Wired into the dashboard shell (`/admin/me`, `/admin/stores/mine`) and into the three overview widget fetches, so the first rejection ends the request instead of reporting a failure the operator cannot act on. |
| Tests | New `apps/api/e2e/13-expired-session-redirect.spec.ts` — a syntactically valid token signed by nobody now lands on `/admin/login` with the dead credentials cleared, and a real login afterwards shows no load failure. It fails on the old code (page stays on `/admin/dashboard`). Also ran `02-admin-login` and `12-preorder-items-quantity`: 3 passed. |
| Gate | Workspace typecheck clean; full lint 0 errors, 299 warnings (unchanged); secret scan 0 high-severity findings; web production build compiled successfully. Both servers verified 200 after the restart. |
| Flake noted | `12-preorder-items-quantity` failed once inside a 3.3m combined run and passed both alone and on a repeat combined run (1.4m) — pooler latency, not this change. |
| Operator action | A real session was still needed: the seeded demo owner is `admin@samstore.test` / `admin-pass-123`. |

## Open P0 found while fixing this — the JWT signing secret is a repo constant

| Item | Detail |
|---|---|
| Finding | `.env` has no `JWT_SECRET`. `app.module.ts` then falls back to the hard-coded `dev-jwt-secret-change-me-0123456789` at four injection sites (lines 124, 149, 156, 201), so **every admin, customer and platform token is signed with a constant that is public in this repository** — anyone could forge an OWNER token. `main.ts` only rejects a weak or placeholder secret when `NODE_ENV=production`, so a non-production run accepts it silently. |
| Second finding | `REDIS_URL` is set but effectively blank, so `redis.ts` uses its in-process `Map` fallback: rate limits and TTL caches are per-process and are wiped by an API restart. |
| Status | **Not changed.** Writing a signing secret is a credential change and needs operator approval; the value must never enter the repo, a commit, a log or a prompt. Recommended: generate a 64-character random secret into `.env` (gitignored), restart the API — which invalidates all existing sessions — and set a real `REDIS_URL`. |

## Follow-up — the managed pooler's latency no longer fails requests or tests

| Item | Detail |
|---|---|
| Symptom | Intermittent `P1001 can't reach database server`, `Timed out fetching a new connection from the connection pool` (10s default), and two dev servers dying mid-session. Users saw these as 500s. |
| Measured | The pooler needs ~11s to hand out a connection and sometimes refuses outright. `pg_stat_activity` shows why the headroom is thin: the session pooler caps at 15 and Supabase's own components already hold ~6 of them (Supavisor ×4, PostgREST, pg_cron, pg_net, postgres_exporter), alongside one leaked idle session. Prisma 6 exposes neither `poolTimeout` nor a retry as a client option here, so both budgets are engine URL parameters. |
| Fix | `prisma-repositories.ts` now appends `connect_timeout=20&pool_timeout=30` alongside the existing `connection_limit=4`, so a slow or refused handshake becomes a slow success instead of a 500, and a query waits for a free connection instead of failing at 10s. |
| Verified | `row-level-security.test.ts` 3/3, `pos.service.test.ts` 22/22, `auth/tenant-context.test.ts` 8/8, `pos-price-override.test.ts` 7/7 — run back-to-back, all green, where the tenant suite previously failed then needed a 120s pause to pass. API restarted on the new settings: `/health/ready` 200, web `/admin/dashboard` 200. |
| Gate | Workspace typecheck clean; full lint 0 errors, 299 warnings (unchanged); secret scan 0 high-severity findings. |
| Not fixed here | Leaked sessions are not reaped automatically — a crashed process can strand a session for hours. Closing clients on shutdown, and asking Supabase to raise the session cap, remain open. |

## Follow-up — exposure checked beyond the `public` schema

| Item | Detail |
|---|---|
| `public` | 70 of 70 tables with RLS enabled, 0 without — the lockdown holds. |
| `storage` | 8 of 8 tables already have RLS, and `storage.buckets` is empty, so no object is reachable. The `anon`/`authenticated` grants there are Supabase Storage's own design; its policies, not the grants, are the gate. Left untouched. |
| `auth`, `vault` | 11 tables without RLS each, but these are Supabase-managed and not served by the Data API, which exposes the `public` schema only. Changing them risks breaking platform auth and secrets; left untouched deliberately. |
| `realtime` | 2 tables without RLS, but Realtime authorises in its own server, not via RLS, and the app uses no realtime features. Left untouched. |

## Follow-up — the paused-project email, settled with evidence

| Item | Detail |
|---|---|
| Verdict | Not our database. `pg_postmaster_start_time()` shows `yeklfbggabxydnzfyorb` has served **34 days 00:31** continuously — a paused project restarts Postgres, and this one never did. The paused project is `pindian-staging` (bpcjkaxnvgwqkbdrzohq). |
| Operator-only action | Unpausing `pindian-staging` happens in the Supabase dashboard; it cannot be done from this repo, and nothing here depends on it. |
| Standing risk | A free-tier project auto-pauses after 7 days idle. Preventing that on `yeklfbggabxydnzfyorb` is a billing decision (upgrade to Pro), outside the codebase. |

## Security — the public data API is closed on the `public` schema

| Item | Detail |
|---|---|
| Reported | Supabase Shield, 27 Sep 2026: `rls_disabled_in_public` and `sensitive_columns_exposed` on project `yeklfbggabxydnzfyorb` — the project `DATABASE_URL` actually points at. |
| Verified | Every one of the **70 tables in `public` had RLS disabled**, and the `anon` role held **SELECT/INSERT/UPDATE/DELETE on all 70** — including `User.passwordHash`, `PlatformUser`, `Customer`, `Payment`, `Order.signatureData`, `OrderClaimToken.token`, `PublicStoreLink.token`. Anyone with the public project URL and anon key could read or wipe the database through PostgREST. |
| Fix | Migration `20261005090000_lock_down_public_schema`: enables RLS on every `public` table (idempotent loop), revokes all privileges on `public` tables and sequences from `anon` and `authenticated`, and revokes their default privileges so tables added by later migrations are locked down too. |
| Why the app is unaffected | The API reaches Postgres as `postgres`, which is the owner of all 70 tables and carries `BYPASSRLS`; `service_role` also bypasses RLS. The codebase contains no Supabase client, PostgREST call or anon key (`.env` holds only `DATABASE_URL`, `PORT`, `REDIS_URL`, `CLAIM_SIGNING_SECRET`, `SESSION_SECRET`, `BCRYPT_ROUNDS`), so nothing in the product depends on the Data API. |
| Tests | New `apps/api/src/persistence/row-level-security.test.ts` — 3/3: no `public` table without RLS, no `anon`/`authenticated` privileges, and both application roles bypass RLS. First test also covers any table a future migration adds. Regressions: `pos.service.test.ts` 22/22, `auth/tenant-context.test.ts` 8/8, and both dev servers healthy (200) against the locked-down database. |
| Gate | Workspace typecheck and full lint passed (0 errors, 299 warnings — unchanged); secret scan 0 high-severity findings. |
| Revert | `ALTER TABLE … DISABLE ROW LEVEL SECURITY` per table plus `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated` — deliberately left closed. |
| Follow-up | The Supabase pooler intermittently refuses or delays new connections (11s observed, sometimes `P1001`), which produces pool-timeout failures. Raising Prisma's `poolTimeout` from the 10s default is the recommended fix; not done in this module. |

## Follow-up — Pre-order finalize returns a real reason instead of a 500

| Item | Detail |
|---|---|
| Symptom | Clicking **Finalize** on a pre-order showed only "Internal server error". |
| Root cause | `PosService.finalizePreorder` threw a plain `Error` inside the finalize transaction when the credit check refused (limit too small, credit disabled, customer not approved). Nothing caught it, so NestJS answered 500 and the reason never reached the UI. Reproduced directly: `Error: Credit limit exceeded (limit ₱50.00)` at `pos.service.ts:559`. |
| Fix | The transaction is wrapped and its failure is mapped to a typed `conflict` (409) carrying the real message, the same way `completeHold` already behaved. The transaction still rolls back, so the draft stays `ON_HOLD` with no signature, no credit entry and no balance change. |
| Tests | `pos.service.test.ts` 22/22 — the new case asserts a 2-unit (₱200) pre-order against a ₱50 limit returns a conflict mentioning credit AND that nothing partial persisted. The happy-path finalize test is unchanged. |
| Gate | Workspace typecheck and full lint passed (0 errors, 299 warnings — unchanged); secret scan 0 high-severity findings. |
| Not a Supabase outage | The paused project `pindian-staging` (bpcjkaxnvgwqkbdrzohq) is a different project. `DATABASE_URL` points at `yeklfbggabxydnzfyorb` ("extraricestore's Project"), which is reachable — the same credentials serve every test run. |

## Follow-up — Pre-orders list shows item quantities

| Item | Detail |
|---|---|
| Problem | The Pre-Orders table listed only a bare item count in the Items column (`Order \| Customer \| Items`), so staff had to open a draft to learn what it actually held. The mobile card showed "N item(s)". |
| Change | The Items cell now lists each line as `2 × Kape Barako` (quantity bound to the product, variant name appended when present), left-aligned; the first three lines show and the rest collapse behind "+N more" with the full list in the tooltip. Mobile cards show the same list (two lines). The column header no longer right-aligns. |
| No API change | The list endpoint already returned line quantities; only the panel's rendering changed. |
| Tests | New E2E `12-preorder-items-quantity.spec.ts` creates a pre-order for a uniquely named product through the API, then asserts the rendered row reads `2 × <product name>` and that the list endpoint carries the quantity. The spec scopes its locator by ORDER NUMBER, because the panel also renders an aggregate hold/sold table that repeats product names without one. It cleans up its order, product, stock rows and quick customer. |
| Gate | Workspace typecheck and full lint passed (0 errors, 299 warnings — unchanged); secret scan 0 high-severity findings; web production build passed; E2E spec 12 passed. |

## Follow-up — Counter price override (POS review + pre-order edit)

| Item | Detail |
|---|---|
| Problem | Prices were strictly server-authoritative with no way for counter staff to change one: the POS review showed a static "₱X each", and the pre-order Edit modal only sent quantity, so any typed price was silently discarded and re-priced from the catalog. |
| Rules | `resolveLinePrice` (`apps/api/src/domain/price-override.ts`): no override → the catalog price wins; an override equal to the catalog price is not treated as an override; any real deviation must be a whole number from ₱0.00 to ₱1,000,000.00 with a 3–140 character reason. A variant line is measured against the VARIANT price, never the product price. |
| Roles | The POS routes already gate on `TENANT_ROLES.ADMIN` (OWNER/MANAGER/STAFF) — exactly the agreed set, so no role change was needed; SALES_AGENT and DELIVERY cannot reach them. |
| Audit | `OrderItem` gained `priceOverridden`, `priceOverrideReason`, `priceOverriddenById`, `priceOverriddenAt`, `catalogUnitPriceMinor` (additive migration `20260929100000_order_item_price_override`). A plain sale keeps every column null/false, the catalog price is never mutated, and the order snapshot plus the receipt payload carry the same facts so a printed slip can explain the price. |
| Scope | POS review (Sell and Hold) and the pre-order Edit modal. One shared reason field covers every changed line, and the client blocks Pay/Hold/Save until it is filled — mirroring the server rule instead of relying on a 422. The Edit price input stays available when `hidePricePreOrder` is on, because hiding is a display rule for the customer-facing list. |
| Defects fixed on the way | A pre-order/hold edit now preserves `variantId`/`variantName` (a variant line used to be silently flattened into its product) and re-freezes the VAT columns after a re-price instead of keeping the previous ones; the pre-order list returns variant and override data; `PATCH /admin/pos/preorders/:id/items` is scoped to `PRE_ORDER` drafts so it can never re-price a POS hold (and the hold route to `pos`). |
| Tests | Override rules 9/9; POS + pre-order override integration 7/7 (cash sale audit, untouched sale unchanged, missing reason refused with nothing written, out-of-band prices refused, pre-order create + re-edit, source scoping, variant baseline + receipt markers). Regressions: POS service 21/21, payments 10/10, registers 7/7, split payment 10/10. |
| Gate | Workspace typecheck and full lint passed (0 errors, 299 warnings — unchanged); secret scan 0 high-severity findings; web production build passed. |
| Not included (agreed scope) | Price editing in the Hold/Build step or the held-strip item editor, per-line reasons, and the online-order reservation guard from the previous module (unchanged). |

## Follow-up — Online order stock reservation settlement

| Item | Detail |
|---|---|
| Problem | Online checkout only raised `quantityReserved`; nothing ever consumed or released it. Delivered orders kept phantom reservations, cancelled orders stranded stock, and a void/refund inflated on-hand instead of giving the reservation back. |
| Settlement | `settleOrderReservations` (`apps/api/src/domain/stock-settlement.ts`) replays the order's RESERVE ledger legs, aggregated per stock row. Fulfilment (`DELIVERED`, pickup `COMPLETED`) decrements on-hand **and** reserved with `CONSUME` movements; cancellation (`CANCELLED`) decrements reserved only with `RELEASE_RESERVATION` movements. Both run inside the same transaction as the status change. |
| Idempotency | `Order.stockDisposition` (enum `CONSUMED`/`RELEASED`, additive nullable column) is claimed with a guarded conditional `UPDATE ... WHERE "stockDisposition" IS NULL`. The first caller wins; every retry, double click, or concurrent courier/admin settles nothing. A failed settlement rolls the claim back and stays retryable. |
| Source-aware | POS and pre-order sales consume on-hand at sale time and carry no reservation, so settlement reports `no-reservation` and writes nothing; POS voids still restore stock. Voids and refunds now release an online reservation rather than adding phantom on-hand. |
| Guards | Tenant-scoped leg reads (another store's order has no visible legs), per-order `CONSUME`/`RELEASE_RESERVATION` ledger rows with `balanceAfter`, dispatch/`FAILED_DELIVERY`/retry deliberately leave the reservation in place, and an item edit on an order with a live reservation is refused with a conflict (the old delta path moved on-hand, which corrupts availability). |
| Reconciliation | `reconcileStock` now excludes both reserved-only movement types from the on-hand identity and ignores variant legs (which belong to `ProductVariant` counters), so settlement cannot be reported as on-hand drift. |
| Migration | Additive `20260929090000_order_stock_disposition` (new `OrderStockDisposition` enum + nullable column), applied. |
| Tests | Reservation settlement 11/11 (fulfilment, cancellation, idempotency, POS no-op, variant counters, multi-warehouse legs, tenant isolation, void, item-edit guard, post-settlement reconciliation). Regression: movements 4/4, reconcile 3/3, stock guard 4/4, atomic checkout 4/4, delivery service 6/6, payments 10/10, POS 21/21, checkout 16/16. |
| Gate | Workspace typecheck and full lint passed (0 errors, 299 warnings — unchanged); secret scan 0 high-severity findings. Web production build unaffected (API-only change). |
| Pre-existing (verified not caused by this change) | `persistence/integrity.test.ts` fulfilment-invariant test fails on 6 stale 2026-09-21 Phase-4A E2E orders with an empty address; `pos/pos-variant.test.ts` fails on an orphan `01P2PV-000001` order left by an aborted run (order numbers derive from a 6-char slug prefix, so they collide globally); `reconcile.ts` reports the same 6 drifts with and without this change (baseline captured by stashing). |

## Follow-up — Inventory stock conversion

| Item | Detail |
|---|---|
| Pack measures | Product setup uses a simple conversion toggle, family, and package size (e.g. `25 kg`); Products/variants store canonical contents in `g`, `ml`, or `each`. Same-family, same-unit items can convert; configured families/sizes cannot change while stock is on hand or reserved. |
| Conversion flow | Inventory converts between standalone SKUs or variants in the same configured family/base unit, accepts actual output count, enforces maximum yield, records shortfall as reasoned waste, and displays paired ledger legs. |
| Integrity | Tenant-scoped, idempotent, reservation-aware, serializable, and atomic across source/output stock, weighted cost transfer, conversion record, movements, and audit log. |
| Migration | Additive migrations `20260925150000_inventory_conversions`, `20260925160000_stock_conversion_idempotency`, and `20260925170000_stock_conversion_families` applied. |
| Tests | Conversion math 3/3; conversion integration/tenant/family tests 5/5; conversion UI E2E 11 passed; Product M5 8/8; variant admin 7/7; product validation 22/22; stock adjustment 6/6; low-stock 5/5; DTO validation 10/10. |
| Gate | Workspace typecheck and full lint passed (warnings only); secret scan had 0 high-severity findings; web production build passed for the simplified product conversion inputs. |

## Follow-up — Product creation cost and category capture

| Item | Detail |
|---|---|
| Pricing | Products now label retail selling price separately from unit acquisition cost; cost is stored in minor units and continues to update from completed purchases. |
| Categories | New products can create a store-scoped category inline; category, product, opening stock, and its RECEIPT ledger movement are committed atomically. Duplicate names return a conflict rather than renaming an existing category. |
| Tests | Product M5 integration tests 8/8; low-stock admin tests 5/5; product-validation tests 20/20. Workspace typecheck and targeted lint passed. |
| Verification | Production web build passed after stopping the dev server to avoid sharing `.next`. |

## Follow-up — Checkout E2E and request validation

| Item | Detail |
|---|---|
| Address checkout | Connected PH address labels to their selects; the E2E helper now chooses a seeded address within an active delivery zone. The demo store's unsupported Bauan zone was retargeted to seeded Batangas City (fee and ETA preserved; the unmatched barangay allowlist cleared). |
| Checkout DTO | Allowed the existing consent, PH address, and statutory-discount request fields with runtime type/bounds validation; added strict DTO acceptance/rejection coverage. |
| E2E | Specs 03 and 04 passed together after the fixes. |
| Verification | Workspace typecheck passed; security validator tests 9/9; payment gateway tests 4/4; E2E 03/04 passed together. Full lint completed with warnings and no errors; secret scan reported 0 high-severity findings. Web production build passed after stopping the dev server to avoid sharing `.next`. |

## Follow-up — E2E 06–09 stabilization

| Item | Detail |
|---|---|
| Split payment | Scoped the Pay action to the held-order row and allowed the icon-prefixed accessible name; the spec now addresses the matching payment dialog and waits for GCash tender options. |
| Stock adjustment | Replaced a capped movement-count comparison with polling for this run's unique ledger reason, avoiding flaky missing/capped counts. |
| Gate | Playwright 06, 07, and 09 passed in the combined run; 08 passed in a focused rerun. Workspace typecheck passed. |

## P10a — Privacy retention controls (§22)

## Follow-up — Platform Admin owner onboarding

| Item | Detail |
|---|---|
| Creation | Platform Admin store creation now requires owner email + PH mobile number. Existing users are linked; new owners are created with OWNER membership, `mustChangePassword=true`, and a one-time temporary password. The UI displays credentials once for secure out-of-band handoff. |
| Login | Auth change-password accepts email or phone identifier; first-login UI requires **new password + retype confirmation** before redirecting to the dashboard. |
| Staff flow | Existing Team invite flow remains the owner’s path for creating Manager/Staff/Sales Agent/Delivery accounts, also using one-time passwords and forced first-login change. |
| Tests | Store creation tests cover new-owner credentials and existing-owner linking; auth/store-access tests pass. |

## Follow-up — Delivery zones, store onboarding, role navigation

| Item | Detail |
|---|---|
| Delivery zones | DeliveryZonesCard now surfaces API status/errors instead of silently showing an empty list when loading fails. Backend CRUD remains tenant/ADMIN guarded; zone and checkout coverage tests pass. |
| Platform store onboarding | Platform Admin store creation now accepts an existing **or new** owner email. New owner accounts receive a one-time temporary password and `mustChangePassword=true`; existing users are linked without creating duplicates. The UI explains the credential handoff. |
| Role UX | Navigation matrix added at `docs/role-navigation.md`; tabs tightened by role: platform admin gets platform controls, owners get full store operations, managers get operational/finance controls, staff gets daily operations, sales agents get orders/customers/CRM/reports, delivery is redirected to `/admin/delivery`. API guards remain authoritative. |
| Tests | Added store creation tests for new-owner temporary credentials and existing-owner linking; typechecks pass. |

## P12 — Two-store fixture preparation

| Item | Detail |
|---|---|
| Fixture helper | `npm run prepare:phase12` creates two disposable stores with separate public links/catalogs/stock and distinct order-number prefixes, then writes tokenized URLs to the gitignored `.phase12.env.local`. It never deletes existing data. |
| E2E | The opt-in two-store spec runs browse→cart→checkout for both stores and verifies that Store A's token cannot unlock Store B. |
| Status | Passed against the local web/API and managed database: Store A and Store B completed independent checkouts and the cross-token isolation check passed. |

## P12 — Production readiness checklist (§26/§28)

| Item | Detail |
|---|---|
| Existing E2E | Ten Playwright specs cover API health, login, storefront checkout/claim, pickup, responsive keyboard, POS shift, split payment, stock adjustment, receipt printing, and two-store isolation. |
| Two-store scenario | `apps/api/e2e/10-two-store-ph-scenario.spec.ts` passed with prepared Store A/B fixtures; the token cross-access check returned Store B as unavailable when using Store A's token. |
| Checklist | Added `docs/production-readiness.md`: managed DB/Redis/backups/TLS/CORS/secrets, provider approvals, tenant isolation, P1–P11 product review, DPA/security, mobile/WCAG, and Messenger suppression review. |
| Status | Two-store E2E passed locally against the managed database; overall **P12 remains pending operator** for remaining production-readiness infrastructure and provider-approval gates. |
| Commit | (this commit) |

## P11g — Static deployment artifact validation (§27)

| Item | Detail |
|---|---|
| CI | Added `npm run check:deployment`; verifies required Dockerfiles/nginx/Compose/docs, separate worker wiring, managed-database posture, and API image setup without running Docker. |
| Gate | Deployment artifact check passed; workspace typecheck remains green. Operator-run Docker/TLS/secret/migration validation remains intentionally manual. |
| Commit | (this commit) |

## P11f — Complete controller route inventory (§25)

| Item | Detail |
|---|---|
| Inventory | `npm run generate:openapi-inventory` scans all controller decorators and generated `docs/openapi-route-inventory.yaml` with **209 route entries**, generic responses, and bearer security metadata for admin paths. |
| Runtime | `/docs/openapi-route-inventory.yaml` is served alongside Swagger UI; detailed high-risk schemas remain in `docs/openapi.yaml`. |
| Gate | Generator ran successfully; workspace typecheck remains green. |
| Commit | (this commit) |

## P11e — OpenAPI route coverage audit (§25)

| Item | Detail |
|---|---|
| Audit | Added `npm run audit:openapi`, which scans Nest controller decorators and reports route paths missing from `docs/openapi.yaml`. It is intentionally an audit report, not a fabricated green gate. |
| Deployment | Deployment docs now require running the audit before releases. |
| Gate | Audit command + workspace typecheck pass. |
| Commit | (this commit) |

## P11d — OpenAPI CI contract gate (§25)

| Item | Detail |
|---|---|
| CI | Added `scripts/check-openapi.mjs` + `npm run check:openapi`; the quality workflow now checks 17 critical public/admin/payment/delivery/Messenger/CRM/ERP/privacy paths are represented in `docs/openapi.yaml`. |
| Gate | OpenAPI check passed; full workspace typecheck passed. |
| Commit | (this commit) |

## P11c — Container deployment topology (§27)

| Item | Detail |
|---|---|
| Artifacts | `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker/worker.Dockerfile`, `docker/nginx.conf`, `docker-compose.yml`. The Compose topology runs API, web, nginx, and a separate outbox worker. |
| Safety | No local Postgres/Redis service is defined; managed services remain required. API embedded worker is disabled in Compose to prevent duplicate polling. Docker was not run locally per project rules. |
| Gate | API + web typecheck clean. |
| Commit | (this commit) |

## P11b — Swagger UI runtime route (§25)

| Item | Detail |
|---|---|
| API docs | Added dependency-free `/docs` Swagger UI backed by the checked-in `/docs/openapi.yaml` contract. `/docs/openapi.yaml` is served by the API. Production exposure is opt-in only via `API_DOCS_ENABLED=true`; development exposes it by default. |
| Gate | API typecheck clean. No local Docker run (forbidden by project rules). |
| Commit | (this commit) |

| Item | Detail |
|---|---|
| Controls | `StoreSettings.privacyRetentionDays` (0 = disabled), `GET /admin/privacy/retention` preview, explicit audited `POST /admin/privacy/retention/purge`. Purge removes old Messenger conversations/messages only; **ConsentRecord rows are retained** for DPA audit. |
| Web | SettingsPanel Privacy retention card: retention days, preview eligible counts, explicit purge confirmation. |
| Tests | +3 real-DB tests: preview/purge + audit + consent retention, disabled retention refuses destructive action, tenant isolation. |
| Gate | api/web typecheck clean; P10a test 3/3. |
| Commit | (this commit) |

## P11a — OpenAPI + deployment contract (§25/§27)

| Item | Detail |
|---|---|
| OpenAPI | Added `docs/openapi.yaml` covering the major public/admin/checkout/payment/delivery/Messenger/CRM/ERP/privacy endpoints, tenant bearer/header requirements, and honest mock/PENDING_CREDENTIALS behavior. |
| Deployment | `docs/deployment.md` now lists Phase 4–10 environment/operator requirements (PayMongo, couriers, BIR CSF, Redis, security checklist) and points to the API contract. No local Docker was run, per project rules. |
| Status | P11a complete; generated Swagger UI, full endpoint schema expansion, Docker Compose/nginx/worker artifacts, and CI/deployment setup guides remain. |

## P10c — NPC breach-notification hooks (§22)

| Item | Detail |
|---|---|
| Incident records | `SecurityIncident` (severity/status/details/detectedAt/notified fields), tenant-scoped. `SecurityIncidentService` creates incidents with AuditLog entries, contains incidents with before/after audit, and lists them. |
| NPC hook | `PendingNpcBreachNotifier` is an explicit `PENDING_OPERATOR` boundary: it never claims a notification was delivered. `POST /admin/security/incidents/:id/npc-notify` returns a reference + pending status and audits the attempt. |
| Tests | +3 real-DB tests: audited creation + pending NPC status, containment + tenant isolation, notifier readiness honesty. |
| Gate | api typecheck clean; P10c test 3/3. |
| Commit | (this commit) |

## P10b — Security & DPA checklist (§22)

| Item | Detail |
|---|---|
| Audit | Documented implemented controls and explicit pending operator/deployment work in `docs/security-checklist.md`: tenant guards, claim tokens, DPA consent, retention, no-PCI gateway posture, proof validation, webhook signatures, rate limits, body caps, security headers, secret hygiene, CSP/CORS/CSRF/NPC/E2E follow-ups. |
| Finding | Public/auth/cart/checkout rate limiting, 5 MB body caps, request-id redaction, basic security headers, and payment proof validation are already active. Live-provider credentials remain suppressed/PENDING_CREDENTIALS. |
| Commit | (this commit) |

Updated: 2026-09-20 · **P9: ERP double-entry + BIR exports (§21/§24)** · Active model: `deepseek/deepseek-v4-flash-0731` (openrouter), boilerplate tier `inclusionai/ling-3.0-flash`

## P9 — ERP depth + BIR

| Item | Detail |
|---|---|
| Schema | `Account` (code/name/type ASSET·LIABILITY·EQUITY·REVENUE·EXPENSE) + `JournalEntry` (reference/source/memo/entryDate) + `JournalEntryLine` (debit/credit). Migration `20260920190000_module_p9a_erp` (db-execute + registered). |
| Ledger | `erp/journal.service.ts` — `ensureChart` (9 default accounts), `postEntry` (manual, **enforces debits=credits>0**), `postOrder` (fulfilled → DR Cash / CR Sales + Delivery Revenue, + **COGS at latest product cost** DR COGS/CR Inventory; **idempotent** per order), `postExpense` (DR Operating Expenses/CR Cash, idempotent), `backfill` (posts all un-posted fulfilled orders + expenses), `trialBalance` (+ balanced flag), `incomeStatement` (revenue − COGS − expenses). |
| Endpoints | `/admin/erp/accounts`, `/trial-balance`, `/income-statement`, `/entries` (manual), `/orders/:id/post`, `/backfill` — owner/manager, tenant-scoped. |
| BIR | `erp/bir.service.ts` — **Sales Journal CSV** (Date, Receipt No, Customer, TIN, Gross Sales, VATable, VAT, Exempt, Discount — from frozen order VAT columns + store TIN) and **Cash Receipts Journal CSV** (per payment). `PendingEInvoiceAdapter` D-marked `PENDING_CREDENTIALS` (`ready()` from `BIR_CSF_CREDENTIALS`; `submitInvoice` throws honestly). Endpoints `/admin/bir/sales-journal`, `/cash-receipts-journal`, `/einvoice/status`. |
| Tests | +7: `erp/journal.test.ts` +4 (chart seed + manual balancing rejected/ok; postOrder idempotent with correct P&L incl. COGS; unfulfilled rejected + backfill idempotent; expense post + P&L) and `erp/bir.test.ts` +3 (Sales Journal CSV with VAT/TIN + escaping; Cash Receipts CSV; e-invoice honestly pending + throws). |
| Gate | api `tsc` 0 errors · full-suite **440 tests / 5 fail** — the pre-existing residual family (voucher/addon, worker/outbox, POS utang, pre-order, purchases); none this module's, all pass standalone. |
| Note | The **ERP/BIR admin panel** (chart view, trial balance, income statement, CSV download buttons, e-invoice status) is the T2 UI remainder — backend + tests shipped. |
| Commit | (this commit) |

## P8 — CRM & campaigns

| Item | Detail |
|---|---|
| Schema | `StoreCustomer.tags` (CRM tagging) + `Campaign` (name, rule JSON, message, status DRAFT/SENT, recipientCount) + `CampaignRecipient` (per-customer enqueue **idempotency**). Migration `20260920180000_module_p8_crm` (db-execute + registered). |
| Aggregates | `CrmService.aggregates(storeId)` — on-demand **live data only**: LTV (fulfilled orders only), orders count, AOV, last-order date + days-since, **favorite product** (top item name), tags, opted-in Messenger psid, credit balance. |
| Segmentation | `segment(rows, rule)` — predefined+custom filters: `minOrders`, `minLtvMinor`, `maxDaysSinceLastOrder` (**at-risk/inactive**: ordered ≥ N days ago; never-ordered excluded), `hasCredit`, `tag`, `messengerOnly`. |
| Campaigns | `createCampaign`/`listCampaigns`/`runCampaign`/`deleteCampaign`. **`runCampaign`** evaluates the segment → enqueues ONE `campaign.send` OutboxEvent per opted-in Messenger user (idempotent via `CampaignRecipient`, never double-enqueues) → marks SENT + recipientCount; re-run is a conflict. Outbox worker gains a `campaign.send` handler → suppressed `NotificationLog` row. |
| Endpoints | `/admin/crm/customers`, `/admin/crm/customers/:id/tags`, `/admin/crm/segment`, `/admin/crm/campaigns` (GET/POST), `/admin/crm/campaigns/:id/run`, `/admin/crm/campaigns/:id` (DELETE) — tenant-scoped. |
| Tests | +3 `crm/crm.test.ts` (real DB): aggregates compute LTV/AOV/orders/favorite from FULFILLED only (unfulfilled excluded); tags set/round-trip + segmentation filters (LTV/tag/credit/at-risk boundaries); campaign run idempotent + one `campaign.send` per opted-in user + SENT + worker drains → suppressed log + re-run conflict. Found & fixed an inverted at-risk rule while testing. |
| Gate | api `tsc` 0 errors · full-suite **440 tests / 6 fail** — the pre-existing residual set (voucher-v2 ×3, worker/outbox ×2, pre-order ×1); none this module's, all pass standalone. |
| Note | Admin CRM **panel** (segment explorer + campaign composer) is the T2 UI remainder — backend + tests shipped; panel pending (see PLAN Phase 8). |
| Commit | (this commit) |

## P7b — Agent dashboard

| Item | Detail |
|---|---|
| Service | `ChatAgentService`: `list` (status-filtered, last message + assignee + unread), `thread`, `assign`/`takeover` (mode → AGENT), `resolve`, `reply` (agent message + mode AGENT + unread reset), canned replies (seeded defaults + upsert/delete), `metrics` (per-agent open/handled + **avg first-response minutes** from the customer→first-agent gap, open-unassigned count). |
| Endpoints | `/admin/chatbot/conversations` (GET list, GET :id/messages, POST :id/assign|takeover|resolve|reply), `/admin/chatbot/canned-replies` (GET/POST/PATCH/DELETE), `/admin/chatbot/metrics` — tenant-scoped. |
| Web | New **Chat inbox** panel (OrdersPanel nav): status-filtered conversation list (unread badges), thread view, canned-reply dropdown, agent reply (Enter-to-send), Take over / Resolve. |
| Tests | +3 `chatbot/agent.test.ts` (real DB): fallback→AGENT conversation → assign → takeover → agent reply (3-message thread, unread reset) → resolve (reply-after-resolve rejected); canned replies seeded + editable + tenant-isolated (cross-store delete not_found); metrics (handled + open-unassigned + first-response minutes). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **7/7 across the 2 chatbot files standalone** (agent 3, chatbot 4). Full-suite **440 tests / 2 fail** (only the worker/outbox isolation pair, pre-existing). |
| Commit | (this commit) |

**Phase 7 (PLAN.md §13/§14) is now COMPLETE**: AI chatbot engine (Taglish, live-data-only, confidence fallback→handoff, audit trail) + human agent dashboard (conversations/assignment/takeover/replies/canned replies/metrics). Next per the plan: **Phase 8 — CRM & campaigns (§15)**.

## P7a — Chatbot engine (live-data-only, Taglish, fallback→handoff)

| Item | Detail |
|---|---|
| Schema | `Conversation` (storeId, channel, contactPsid, customerId, status OPEN/AGENT/RESOLVED, mode BOT/AGENT, assignedAgentId, unreadCount, title, lastActivityAt) + `Message` (sender customer/bot/agent, body, **intent + confidence audit**) + `CannedReply` (store-owned). Migration `20260920170000_module_p7a_chatbot` (db-execute + registered). |
| Engine | `chatbot/engine.ts` — PURE. `classify` (Taglish keyword sets → greeting/menu/order_status/store_hours/store_info/loyalty/voucher; order-token regex; plausible product query; else fallback) + `answer` (live-context-only) + `answerProducts` (live catalog; **null on no-match → hand off, never invented**) + `FALLBACK_REPLY`. Confidence + `CONFIDENCE_THRESHOLD`. |
| Service | `ChatbotService.handleCustomerMessage` — find-or-create Conversation (psid thread / customer thread), append customer + bot Messages (intent/confidence audit), on fallback or product-miss → `FALLBACK_REPLY` ("I'll ask our staff"), conversation → **AGENT** + unreadCount++. `POST /admin/chatbot/message` (test/compose entry; production entry is the Messenger webhook, `PENDING_CREDENTIALS`). Live order lookup by claim token (read-only). |
| Tests | +4 `chatbot/chatbot.test.ts`: classify (Taglish intents + confidence + token), answers LIVE-DATA-ONLY (menu/hours live, unknown order never invented, product detail live price/stock, no-match → null), fallback hands off (AGENT + unread + 2-message audit with intent+confidence), product query answered from live catalog with audit. |
| Gate | api `tsc` 0 errors · full-suite **440 tests / 3 fail** — the same 3 pre-existing residuals (worker/outbox ×2, pre-order), none this module's. |
| Commit | (this commit) |

## P6b — Messenger journey engine

| Item | Detail |
|---|---|
| Templates | `messenger/templates.ts` — pure reply builders (text+quick-replies, button, carousel, image) + standard menu replies. |
| State machine | `messenger/journey.ts` — PURE `journeyTurn(state, input, ctx)` with **live-data-only** context (categories/products/order lookup): welcome → menu → category → product carousel → product detail (live price + stock) → track order (claim token) → live status via `resolveTracking` (verifyClaimToken → order, READ-ONLY, never marks the token used). Natural-text routing (category name / product search / token). Never invents stock, price, or status. |
| Dispatch | `MessengerJourneyService.dispatch(storeId, psid, incoming)` — loads live catalog, runs the machine (per-psid in-memory session), upserts `MessengerUser` (lastSeenAt/opt-in), routes flattened templates through the suppressed/mock provider, writes `NotificationLog` audit rows. `flattenTemplate` serialises any template to provider text. |
| Honest | Live Meta sends remain suppressed/mock — the engine produces the DATA a real provider would send; going live is operator-approved (`PENDING_CREDENTIALS`). |
| Tests | +10: `messenger/journey.test.ts` +9 (welcome menu, menu payload, category→carousel with live stock, product detail live price, track prompt, valid token → live status, unknown token not invented, natural-text category/product routing) and `messenger/journey.service.test.ts` +1 (real DB dispatch → provider sent + MessengerUser upserted + audit rows). Fixed a real bug while testing: `replace("_"," ")` left `for_delivery` — now global. |
| Gate | api `tsc` 0 errors · **30/30 across the 6 messenger files standalone** (journey 9, journey.service 1, connection 5, bridge 6, adapter 4, webhook-verification 5). Full-suite **440 tests / 2 fail** (best yet — down from 13–18 pre-pool-fix; residual = worker/outbox + pre-order isolation, pre-existing, pass standalone). |
| Commit | (this commit) |

**Phase 6 (PLAN.md §12) is now COMPLETE**: Messenger connection + identity mapping + deep link (P6a) + journey engine + webhook verification (P6b), all adapter-isolated with suppressed/mock sends. Next per the plan: **Phase 7 — AI chatbot + human agent dashboard (§13, §14)**.

## P6a — Messenger connection + identity mapping

| Item | Detail |
|---|---|
| Schema | `MessengerPage` (storeId unique, pageId, pageName, `accessTokenHash`, `webhookVerifyTokenHash` — **hashes only, never the tokens**) + `MessengerUser` (storeId+psid, `customerId` FK → identity mapping, optedIn, lastSeenAt). Migration `20260920160000_module_p6a_messenger_connection` (db-execute + registered). |
| Service | `MessengerConnectionService`: `getConnection` (portal status; provider always `suppressed` — honest), `connect` (validates + sha256-hashes the page token, sets `messengerConnected`/`pageId`), `disconnect`, `rotateWebhookToken` (high-entropy token returned ONCE, hash stored), `mapUser` (PSID→customer upsert), `listUsers`, `deepLink` (`https://m.me/<pageId>?ref=<slug>`). Live Graph/Send calls stay gated behind operator approval. |
| Endpoints | `/admin/messenger` (status), `/connect`, `/disconnect`, `/rotate-webhook-token`, `/users` (POST/GET), `/deep-link` — tenant-scoped. SettingsPanel Messenger card gains a **Connect a Messenger Page** form + connected state (deep link + copy, disconnect). |
| Tests | +5 `messenger/connection.test.ts` (real DB): token hashed-never-stored + disconnect clears; webhook token returned once + hash-only; PSID→customer upsert/opt-out + list; deep link requires connection + reflects slug; tenant isolation (store B sees no page/users). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **20/20 across the 4 messenger files standalone** (connection 5, bridge 6, adapter 4, webhook-verification 5). Full-suite 430 tests / 4 fail — the residual pre-existing set (worker/outbox, POS utang, reports); pool-exhaustion fix holds the band. |
| Commit | (this commit) |

## P5b — Courier adapters + COD remittance

| Item | Detail |
|---|---|
| Adapters | `delivery/couriers.ts` — `CourierAdapter` interface (`ready`, `createBooking`) + `MockCourierAdapter` (deterministic `MOCK-` tracking) + Lalamove/GrabExpress/J&T/owner adapters, each `PENDING_CREDENTIALS` (ready() reads `LALAMOVE_API_KEY` etc.; sandbox tracking labels; **no live API call ever without creds**). `getCourier(name)` registry. |
| Schema | `DeliveryBooking` (courier, status, trackingNumber, remoteId, `codMinor`, `remittedMinor`), `DeliveryEvent` (append-only status rows), `CourierRemittance` (ledger). Migration `20260920150000_module_p5b_couriers` (db-execute + registered). |
| Service | `DeliveryBookingService`: `createBooking` (adapter booking + initial `created` event), `addEvent` (validated statuses, terminal delivered/failed/cancelled block further events), `remit` (COB ledger, never exceeds outstanding cod), `list` (bookings + events + remittances + order summary). |
| Endpoints | `POST /admin/orders/:id/delivery/booking`, `GET /admin/delivery/bookings?orderId=`, `POST /admin/delivery/bookings/:id/event`, `POST /admin/delivery/bookings/:id/remit` — all tenant-scoped. |
| Tests | +2 `delivery/delivery-booking.test.ts` (real DB): mock courier end-to-end (booking → tracking → accepted/picked_up/delivered events → terminal blocks further events → partial + full COD remittance → over-remit rejected with outstanding message) and validation + tenant isolation (bad status, cross-store not_found, codMinor over total rejected). |
| Gate | api `tsc` 0 errors · **30/30 across the 5 touched files standalone** (delivery-booking 2, zones 3, checkout-zones 3, checkout.service 16, delivery.service 6). Full-suite 426 tests / 6 fail — the residual pre-existing set (addon-revalidation hook, worker/outbox, POS utang, purchases, reports); pool-exhaustion fix keeps the band at 3–6 (was 13–18). |
| Commit | (this commit) |

**Phase 5 (PLAN.md §17) is now COMPLETE**: delivery zones (per-city/barangay fee + ETA + out-of-coverage) + courier adapters (Lalamove/GrabExpress/J&T/owner, mock-first `PENDING_CREDENTIALS`) + tracking/delivery events + COD remittance ledger (P5a/P5b). Next per the plan: **Phase 6 — Messenger live + journeys (§12)**.

## P5a — Delivery zones + flakiness root cause

| Item | Detail |
|---|---|
| Root cause (finally) | The documented "pre-existing full-suite flakiness" is **Supabase session-pool exhaustion**: `FATAL: max clients reached in session mode — pool_size: 15`. The long sequential suite fires parallel lookups (notably the address resolver's 4-query `Promise.all`) and exhausts the 15-client pool → random `EMAXCONNSESSION` errors on whichever query happens to fire (exactly why the failure set shifted run-to-run and every test passed standalone). **Mitigated**: Prisma client now passes `?connection_limit=4` on the datasource URL, and `AddressService.resolve` lookups are sequential. Full-suite failures dropped from **13–18 per run → 3–4**, and the `EMAXCONNSESSION` errors are gone. Residual worker/outbox failures are a separate test-isolation issue (the worker test drains leftover PENDING events from other checkout tests). |
| Schema | `DeliveryZone` (storeId, name, `cityCode` PSGC nullable = catch-all, `barangayCodes` allowlist, feeMinor, etaMinutes, isActive, sortOrder). `Order` + `deliveryZoneName` + `etaMinutes` snapshot columns. Migration `20260920140000_module_p5a_delivery_zones` (db-execute + registered). |
| Domain | `delivery/zones.ts` `resolveDeliveryZone(zones, cityCode, barangayCode)` → match (city + allowlist) → catch-all → out-of-coverage; no zones → legacy flat fee. |
| Checkout | When the store has active zones, delivery fee + ETA come from the matched zone; an unmatched address → `conflict "outside our coverage area"`. Zone name + ETA snapshotted on the order + in the snapshot. No zones → legacy `deliveryFeeMinor`. |
| Admin/Web | `DeliveryZonesAdminService` + `/admin/delivery-zones` CRUD (tenant-scoped, conflict on duplicate names, validation). SettingsPanel Orders tab gains a **Delivery zones** card (list + add/edit/delete; city/barangay PSGC codes + fee + ETA). |
| Tests | +6: `delivery/zones.test.ts` +3 (domain match/catch-all/out-of-coverage/no-zones; admin CRUD tenant-scoped + duplicate conflict + validation) and `checkout/zones.test.ts` +3 (real checkout: zone fee+ETA+snapshot; unmatched → out-of-coverage conflict; no zones → legacy fee). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **40/40 across the 6 touched files standalone** (zones 3, checkout-zones 3, checkout.service 16, checkout-address 5, order-number 2, store-access 11). Full-suite 423–424 tests / **3–4 fails** (down from 13–18; EMAXCONNSESSION gone) — residual are the worker/outbox isolation issue. |
| Commit | (this commit) |

## P4b — Payments PH: bank-transfer proof + review queue (§16)

| Item | Detail |
|---|---|
| Proof upload | `PaymentsService.submitBankProof(orderId, storeId, actorId, proofDataUrl)` — validates a base64 data-URL PNG/JPEG (≤ 2 MB decoded, mime-whitelisted), attaches `proofData`/`proofMime` to the bank-transfer `Payment` row, moves the order `PENDING→RECEIVED` + writes `PaymentStatusHistory` (`"bank-transfer proof submitted"`). Rejects non-images, oversized, and non-pending orders (`conflict`). |
| Review queue | `reviewQueue(storeId)` — orders with `paymentStatus = RECEIVED` (latest payment + proof); `GET /admin/payments/review-queue`. `POST /admin/orders/:id/payments/proof` uploads; the P4a `.../payments/review` flips RECEIVED→REVIEWED. Full §16 lifecycle **pending→received→reviewed→refunded** is covered end-to-end. |
| Web | New `PaymentReview` modal (OrdersPanel "Payment review" nav button): lists the queue, per-row proof file upload (client-side size/type check → base64) + Review button; every action reloads the orders list. |
| Tests | +3 `payments/p4-bank-proof.test.ts` (real DB): valid proof → RECEIVED + image attached + queue lists it + history; invalid/oversized/wrong-mime rejected (order stays PENDING); full lifecycle proof→received→reviewed→refunded + a second proof on a refunded order → conflict. |
| Gate | api + web `tsc` 0 errors · web build ✓ · **48/48 across the 5 touched files standalone** (p4-bank-proof 3, p4-gateway 4, payments.service 10, split-payment 10, pos.service 21). Full-suite run 417 tests / 13 fail — all the documented pre-existing flaky set; none this module's. |
| Commit | (this commit) |

**Phase 4 (PLAN.md §16) is now COMPLETE**: gateway interface + PayMongo sandbox adapter (`PENDING_CREDENTIALS`, tokenized-only, webhook idempotency) + payment links (P4a); bank-transfer proof + review queue + received/reviewed/refunded lifecycle + status history + admin UI (P4b). Next per the plan: **Phase 5 — Shipping & delivery (§17)**.

## P4a — Payments PH: gateway + payment links + webhook lifecycle (§16)

| Item | Detail |
|---|---|
| Schema | `PaymentStatus` gains `RECEIVED`/`REVIEWED`/`REFUNDED`/`FAILED`. `Payment` gains `gateway`, `checkoutSessionId`, `checkoutUrl`, `status` (pending/paid/reviewed/failed), `proofData`, `proofMime`, `reviewedAt`, `reviewedBy`. New append-only `PaymentStatusHistory` (tenant-scoped). Migration `20260920130000_module_p4a_payments_gateway` (db-execute + registered). |
| Gateway | `payments/gateway.ts` — `PaymentGateway` interface (`createCheckoutSession`, `verifyWebhookSignature`, `parseWebhookEvent`), `MockPaymentGateway` (deterministic, tests), `getGateway` registry. `payments/paymongo.adapter.ts` — `PayMongoGateway` D-marked `PENDING_CREDENTIALS`: `ready()` false without `PAYMONGO_SECRET_KEY`, returns sandbox placeholder URLs, HMAC-SHA256 webhook verification via `PAYMONGO_WEBHOOK_SECRET`, parses `payment.paid/failed`. **No raw card data ever touches the app — gateway-hosted checkout only.** |
| Lifecycle | `PaymentsService.createGatewayPayment` (payment link → hosted checkout session + Payment row, no card data); `handleGatewayWebhook` (signature-verified, **idempotent** — a settled event is a no-op) moves order `PENDING→RECEIVED/FAILED` + writes history; `markPaymentReviewed` `RECEIVED→REVIEWED`; `refundOrder` now sets `REFUNDED` (+ history) and allows reviewed payments; `voidOrder` writes history. |
| Endpoints | `POST /webhooks/paymongo` (public, signature-verified); `POST /admin/orders/:id/payment-link`; `POST /admin/orders/:id/payments/review`; `GET /admin/orders/:id/payments` now includes `statusHistory`. |
| Tests | +4 `payments/p4-gateway.test.ts` (real DB): payment-link session + no-card-data; lifecycle pending→received→reviewed→refunded with 3 history rows + webhook idempotent replay; bad signature/payload rejected (order stays PENDING); failed webhook → FAILED. Ripple: `payments.service.test.ts` after() now sweeps `paymentStatusHistory`. |
| Gate | api `tsc` 0 errors · **60/60 across the 6 touched files standalone** (p4-gateway 4, payments.service 10, split-payment 10, order-state 11, pos.service 21, pos-variant 4). Full-suite run 414 tests / 10 fail — the documented pre-existing flaky set (incl. the register-session class that hit `refundOrder`→`attachOpenSession` once; p4-gateway is green standalone). |
| Commit | (this commit) |

## P3j — Abandoned-cart recovery

| Item | Detail |
|---|---|
| Gap fixed | Carts carried a 7-day `expiresAt` but nothing ever marked them ABANDONED or triggered a follow-up — the plan's "cart expiry job + outbox notification" was missing. |
| Service | `cart/recovery.service.ts` `CartRecoveryService.expireAbandoned(storeId)`: finds OPEN carts with `expiresAt < now` AND items, flips them to `ABANDONED` (guarded `updateMany` so a concurrently-converted cart is skipped) and enqueues ONE `cart.abandoned` outbox event per cart (payload: token, customerId, itemCount) in the same transaction. Returns `{ expired, enqueued }`. |
| Worker | `OutboxWorker.handle` gains a `cart.abandoned` case → writes a suppressed `NotificationLog` row (channel messenger, template `cart.abandoned`) — the audit trail until a live Messenger/SMS provider is approved. |
| Endpoint | `POST /admin/carts/expire` (tenant-scoped, ADMIN) — a cron/scheduler should call it daily. |
| Tests | +2 `cart/recovery.service.test.ts` (real DB): expired OPEN cart → ABANDONED + PENDING outbox event + worker drains to a `cart.abandoned` NotificationLog row; fresh/CONVERTED/item-less carts untouched + run idempotent (second run 0). |
| Gate | api `tsc` 0 errors · **24/24 across the 4 touched files standalone** (recovery 2, outbox 3, cart.service 15, variant-cart 4). Full-suite run 410 tests / 11 fail — all the documented pre-existing flaky set (variant-cart, checkout-address, consent, voucher, worker/outbox, POS refund/void, POS utang, pre-orders, purchases, reports); none this module's; every such test passes standalone. |
| Commit | (this commit) |

**Phase 3 (PLAN.md §6/§7/§10/§11) is now COMPLETE**: voucher engine v2 (P3a), senior/PWD + DPA consent (P3b), loyalty depth (P3h), order numbers `PIN-YYYY-NNNNNN` (P3i), abandoned-cart recovery (P3j). Next per the plan: **Phase 4 — Payments PH (§16).**

## P3i — Order numbers (`PIN-YYYY-NNNNNN`, configurable prefix)

| Item | Detail |
|---|---|
| Gap fixed | Order numbers were hard-fixed to `<SLUG6>-NNNNNN` (e.g. `SAMSTO-000001`). The plan requires `PIN-YYYY-NNNNNN` via the per-store counter with a configurable prefix. |
| Schema | `StoreSettings.orderNumberPrefix String?` — when set, numbers read `PREFIX-YYYY-NNNNNN`; null keeps the legacy slug format (backward compatible). Migration `20260920120000_module_p3i_order_numbers` (db-execute + registered). |
| Domain | `formatOrderNumber(storeSlug, seq, { prefix? })` — configured prefix → `<PREFIX>-<YYYY>-<6-digit>` (year embedded from the calendar year); blank/empty prefix falls back to the legacy slug format. Prefix upper-cased, stripped, capped at 6 chars. |
| Callers | `checkout.service` + POS `sell`/`hold`/`pre-order` pass the store's prefix (POS store reads now `include: { settings: true }`). `StoreRecord` carries `orderNumberPrefix`. |
| Admin/Web | SettingsPanel **Order numbers** card (Orders tab) — prefix input + explanatory copy. Settings GET/PATCH carry the field. |
| Tests | +7: `domain/order-number.test.ts` +4 (year embedded, upper/strip/truncate, blank falls back, seq validation) and `checkout/order-number.test.ts` +2 (real DB: configured → `PIN-YYYY-NNNNNN` through checkout; unset → legacy slug format). DB fixture's `after()` uses the resilient sweeper (try/catch + re-sweep of outbox/notification rows) after a full-suite FK leftover. |
| Gate | api + web `tsc` 0 errors · web build ✓ · **64/64 across the 6 touched files standalone** (order-number 10, order-number DB 2, checkout.service 16, pos-variant 4, pos.service 21, store-access 11). Full-suite run 408 tests / 9 fail — all the documented pre-existing flaky set (checkout-address, markStatus, worker/outbox, POS refund/void, POS utang variant, purchases, reports); **order-number.test.ts no longer fails the suite**; every such test passes standalone. |
| Commit | (this commit) |

## P3h — Loyalty-at-checkout depth (Plan Phase 3 remainder)

| Item | Detail |
|---|---|
| Gap fixed | Earn (on delivered orders), redeem at checkout, customer ledger, and manual adjust already existed — but the rate was a hard-coded 1pt/₱1, no welcome bonus, no reversal when an order is voided/refunded, and no expiry. |
| Schema | `StoreSettings.loyaltyPointsPerPeso` (default 1), `loyaltyWelcomeBonusPoints` (default 0), `loyaltyExpiryMonths` (default 0 = never). `LoyaltyEntryType` gains `WELCOME` / `REVERSE` / `EXPIRED`. Migrations `20260920110000_module_p3h_loyalty_depth` + `20260920110100_module_p3h_loyalty_entry_types` (db-execute + registered). |
| Domain | `pointsEarnedFor(totalMinor, rate)` (rate-aware; `pointsEarned` kept backward-compatible); `expirablePoints(entries, cutoff)` — pure FIFO expiry: debits consume the OLDEST positive points first; returns outstanding aged points (never more than balance). |
| Service | `ensureProfile` grants the welcome bonus once (only on profile CREATE). `earnForDeliveredOrder` earns at the store's rate. New `reverseForOrder(orderId, reason)` — claws back earned points (REVERSE entry, balance floor 0, **idempotent** via existing REVERSE check; no-op when nothing earned). New `expirePoints(storeId)` — FIFO expiry per customer over the ledger, writes EXPIRED entries, busts the customers cache. |
| Payments | `voidOrder` + `refundOrder` now call `reverseForOrder` after cancelling — a refunded/voided order never keeps its earned points. |
| Admin/Web | SettingsPanel gains a **Loyalty points** card (rate / welcome bonus / expiry months). New `POST /admin/loyalty/expire` (scheduler/cron should call it daily; returns `{ expiredPoints, customers }`). |
| Tests | +11: `domain/loyalty.test.ts` +5 (`pointsEarnedFor` rates, 4 FIFO-expiry cases) and `loyalty/loyalty-depth.test.ts` +7 (real DB: welcome granted once, no-welcome default, rate-aware earn, reversal idempotent + balance floor + no-op with no earn, FIFO expiry keeps fresh points + second run no-op, expiry disabled skip). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **53/53 across the 5 touched files standalone** (loyalty domain 9, loyalty-depth 7, checkout.service 16, payments.service 10, store-access 11). Full-suite run 402 tests / 12 fail — all the documented pre-existing flaky set (variant-cart, checkout-address, ledger drift, worker/outbox, POS refund/void, pre-orders, purchases, reports); none this module's; every such test passes standalone. |
| Commit | (this commit) |

## P3g — Website→Messenger bridge (suppress-send + portal status)

| Item | Detail |
|---|---|
| Master-prompt rule | "Adapter behind an interface + mock provider + tests only. No live Graph/Send API calls… Website→Messenger bridge defaults to suppress-send with portal status; never guess a token." |
| Already present | `messenger/adapter.ts` (interface + `SuppressedMessengerProvider` + `MockMessengerProvider` + `MessengerService`), `webhook-verification.ts` (signature + challenge), each tested. No persisted connection state, no bridge surface existed. |
| Schema | `StoreSettings.messengerConnected Boolean @default(false)` + `messengerPageId String?` — the admin's RECORDED connection intent (real credentials live in env vars, never the DB). Migration `20260920100000_module_p3g_messenger_bridge` (db-execute + registered, machinery still blocked by the P2a drift). |
| Bridge | `messenger/bridge.service.ts` `MessengerBridgeService`: `status(storeId)` → `{ connected, pageId, provider, suppressed }` (provider is `suppressed`/`mock`, never `live`); `bridgeOptIn(storeId, { psid?, text? })` — **never guesses a token**: no caller-supplied PSID → logged `not_connected` with `recipient: null`; with a PSID → routed through the provider (suppressed default) — every attempt writes an auditable `NotificationLog` row (channel `messenger`, `delivered`). |
| Endpoints | `POST /public/stores/:slug/messenger/opt-in?token=` (slug+token gated via new `PublicStoreService.resolveStoreId`, same gate as the storefront). Settings PATCH/GET carry the two messenger fields for the admin portal. |
| Web | SettingsPanel: new **Messenger (website→Messenger bridge)** card in General — honest "sends are suppressed" status + connected toggle + Page ID. Storefront order-done screen: "Get order updates on Messenger" button → posts the token-gated opt-in and renders the returned honest status (suppressed / not available / delivered). |
| Tests | +6 `messenger/bridge.service.test.ts` (real DB): default status suppressed/not-connected; recorded intent shows in status while provider stays suppressed; no-psid opt-in → `not_connected` + NotificationLog with `recipient: null` (never fabricated); psid opt-in → suppressed + logged; mock provider (demos) delivers + logs; unknown store `not_found` + status tenant-scoped. |
| Gate | api + web `tsc` 0 errors · web build ✓ · **20/20 across the 4 messenger/public files standalone** (bridge 6, adapter 4, webhook-verification 5, public-store 5). Full-suite run 397 tests / 16 fail — all the documented pre-existing flaky set (checkout-address, stock ledger, drift, expenses, worker/outbox, POS refund/void, pre-orders, purchases, reports); none are this module's; every such test passes in isolation. |
| Commit | (this commit) |

## P3f — Warehouse low-stock surfacing (reorder thresholds)

| Item | Detail |
|---|---|
| Gap fixed | The backend already computed `status` (in/low/out) and `stockLow` reports, but `reorderThreshold` was **never writable** (default 0 everywhere) — so the entire low-stock system was dormant (`low` requires `threshold > 0`). The P2c "low-stock surfacing" leftover was this missing configuration + UI surface. |
| Backend | `ProductInput.reorderThreshold?` + validation (non-negative integer). `create` sets it on the initial stock level; `update` upserts it on the same stock row the stock logic targets (default warehouse → legacy warehouse-less → create with 0 on-hand). Controller POST/PATCH product body types extended. Reads were already wired (inventory status, `analytics/status` lowStock count, `reports/stockLow`, purchases suggestions) — they now light up. |
| Web | `ProductsPanel`: new **"Reorder at"** input in the product form (POST/PATCH), low-stock cell shows red + `≤threshold` when available ≤ threshold (>0); `InventoryPanel` status badges now show `low ≤N` / `out ≤N` trigger levels. Dashboard low-stock count and the Low filter were already there. |
| Tests | +5 `admin/product-lowstock-admin.test.ts` (real DB): create + threshold → inventory status `low` + `listFiltered` round-trip; update raises/clears threshold → status flips low↔in; threshold set with no stock level yet (creates one, 0 on-hand → `out`); negative threshold rejected; **tenant isolation** (store B → `not_found`). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **26/26 across the 6 touched files standalone** (product-lowstock-admin 5, product-merchandising 4, product-m5 6, product-variant-admin 6, addon-group-admin 4, inventory.service 1). Full-suite run 391 tests / 11 fail — all the documented pre-existing flaky set (checkout-address, ledger drift, worker/outbox, split-payment, POS variants, purchases, reports); none are this module's tests; every such test passes in isolation. |
| Commit | (this commit) |

## P3e — Variant / add-on admin editor (create + edit)

| Item | Detail |
|---|---|
| Gap fixed | The P2c `VariantEditor` could add variants and CREATE groups (first option only) + delete; you could NOT rename a variant, toggle it off, rename a group, flip `required`, add options to an EXISTING group, or edit an option's name/price — edits were DB/seed-only. |
| Backend | `ProductAdminService` +2 methods: `updateAddon` (`PATCH /admin/products/addons/:addonId` — name / required) and `addAddonOption` (`POST /admin/products/addons/:addonId/options` — appends with the next sortOrder). Both tenant-scoped (`not_found` cross-store) with validation (1–60 char names, non-negative integer prices). Existing `updateVariant`/`updateAddonOption` already covered name/isActive/price edits. |
| Web | `VariantEditor` upgraded: variant rows have an inline rename input + active toggle (alongside the existing price/stock blur-edits); add-on groups have an inline rename input + required switch; each group gains an "Add option" row (name + price) that posts to the new endpoint; option chips are inline-editable (name + price, onBlur) with the delete X preserved. Writes keep the established "reload-to-continue" flow (authoritative refetch). |
| Tests | +4 `admin/addon-group-admin.test.ts` (real DB): rename + required round-trip through `listFiltered`, addOptionToGroup appends after existing options, validation rejects blank name / negative price / blank option name, **tenant isolation** (store B cannot edit store A's group → `not_found`). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **21/21 across the 5 touched files standalone** (addon-group-admin 4, product-variant-admin 6, product-m5 6, product-merchandising 4, public merchandising 1). Full-suite run remains flaky under shared-DB contention (set shifts run-to-run) — pre-existing per the P3a note; every such test passes in isolation. |
| Commit | (this commit) |

## P3d — Catalog merchandising (featured / tags / related / upsell)

| Item | Detail |
|---|---|
| Schema | `Product.featured Boolean` + `Product.tags String[]` (Postgres text[]). New `ProductRelation` table (storeId + composite FKs to `Product(storeId, id)` for source AND target, `kind` `"related"`/`"upsell"`, sortOrder, unique `[storeId, sourceProductId, targetProductId, kind]`) — a relation can only link SAME-store products (tenant integrity DB-enforced, M3 pattern). Migration `20260920090000_module_p3d_merchandising`. |
| DB note | `prisma migrate dev` is BLOCKED in this env by a pre-existing drift (`20260916180100_module_p2a_cart_variant_identity` was modified after apply → prisma demands a destructive reset). Applied the additive migration via `prisma db execute` + registered it in `_prisma_migrations` with the correct sha256 checksum so a future `migrate deploy` stays consistent. **Operator follow-up: the P2a migration drift needs resolution before `migrate dev/reset` can ever run again.** |
| Admin | `ProductInput` + validation gain `featured`/`tags` (max 20 × 40 chars) and `relatedProductIds`/`upsellProductIds` (max 12, well-formed ids). `create`/`update` persist scalars; `update` replace-alls relations in a transaction with pre-validation (same store, active, no self-link). `listFiltered` returns `featured/tags/related/upsell` + new `featured`/`tag` filters. Controller body types extended. |
| Public | `PublicStoreService.getStore` products DTO adds `featured`, `tags`, `related`, `upsell` summaries (`{id, name, priceMinor, image}`); targets batch-loaded and filtered to ACTIVE same-store products. New `CatalogRepository.getProductRelations` (Prisma + InMemory). |
| Web | Storefront: curated **Featured** row (when no filter active), **Tags** filter pills, tag chips on cards. `ProductPicker` gains "You may also like" (related) + "Upgrade" (upsell) buttons that switch the picker. `ProductCard` shows a Featured badge + tags. `ProductsPanel`: Featured switch, tags input, and related/upsell multi-selects (edit mode). |
| Tests | +7: `domain/product-validation.test.ts` +6 (featured/tags/relation-id validation) and `admin/product-merchandising.test.ts` +4 (create round-trip, replace-all relations, self/cross-store rejection, featured+tag filters) and `public/merchandising.test.ts` +1 (storefront returns featured/tags/related/upsell; inactive target omitted). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **82/82 across the 9 touched files standalone** (product-validation 18, product-merchandising 4, product-m5 6, product-variant-admin 6, public merchandising 1, public-store 5, cart.service 15, checkout.service 16, store-access 11). Full-suite run remains flaky under shared-DB contention (set shifts run-to-run) — pre-existing per the P3a note; every such test passes in isolation. |
| Commit | (this commit) |

## P3c — Add-on price revalidation at checkout

| Item | Detail |
|---|---|
| Gap fixed | Checkout re-priced product/variant units but **carried add-on totals through unchanged** (the `cart.ts` comment promised re-validation "against the live groups in the checkout service" — it didn't exist). A stale add-on price survived to order creation. |
| Domain | `domain/cart.ts` `revalidateCartLines` gains a 4th arg `freshAddons: Map<optionId, { addonId, name, priceMinor }>` and re-prices each line's add-on snapshot per unit: live price applied + reported in `addonPriceChanges` (`{ productId, optionId, name, fromMinor, toMinor }`); options that vanished/were deactivated/left their add-on group are dropped with their cost removed, listed in `removedAddonOptionIds`. `addonsTotalMinor` + `subtotalMinor` always reflect the live prices. Empty/unaddon lines are untouched (backward compatible). |
| Checkout | `checkout.service.ts` loads live add-on groups (`getProductAddons` per cart product, active options only) and passes them into revalidation; the order snapshot now carries `addonPriceChanges` + `removedAddonOptionIds` so the storefront can explain the adjustment — same pattern as `priceChanges`. |
| Tests | +9: `domain/cart.test.ts` +6 (price up, deactivated dropped, group-mismatch dropped, mixed set, no-addons untouched, variant line add-ons) and `checkout/addon-revalidation.test.ts` +3 (real DB: price raised after add → order charged the live price + snapshot lists the change; option deactivated → dropped, never charged; price lowered → customer pays less). |
| Gate | api + web `tsc` 0 errors · web build ✓ · **isolation gate 68/68 across the 9 touched files** (cart 12, statutory-discount 5, addon-revalidation 3, statutory-consent 6, checkout.service 16, checkout-address 5, voucher-v2 6, variant-cart 4, store-access 11). Full-suite run remains flaky under shared-DB contention (set shifts run-to-run: worker/outbox, POS, split-payment, voucher-v2, suppliers) — pre-existing per the P3a note; every such test passes in isolation. |
| Commit | (this commit) |

## P3b — Statutory 20% discount (Senior Citizen / PWD) + DPA consent

| Item | Detail |
|---|---|
| Schema | `Order.statutoryType` (`senior`/`pwd`) + `statutoryId` + `statutoryName`; `StoreSettings.seniorPwdDiscountEnabled` (default false). Migration `20260916200000_module_p3b_statutory_discount`. |
| Domain | `domain/statutory-discount.ts`: `statutoryDiscountMinor` (20% of subtotal, floored), `validateStatutoryClaim` (type ∈ senior/pwd, ID 3–32 alnum/dash, name 3–80 chars), `normalizeStatutoryId` (trim + upper). |
| Checkout | `checkout.service.ts` step 1b: **DPA consent gate** — `consentGranted !== true` rejects every online order (`"Privacy consent is required to place an order"`). Step 6c-2: statutory claim validated, store toggle checked (else conflict), 20% applied to the SUBTOTAL only (delivery excluded), stacked after voucher/loyalty and capped so total ≥ 0; type/id/name persisted to order columns + snapshot. Customer-account checkouts also write an auditable `ConsentRecord` (scope `dpv1`, channel `web`, version `2026.09`, best-effort). |
| Contracts | `CheckoutRequest` +` consentGranted?` + `statutoryType?`/`statutoryId?`/`statutoryName?`. |
| Admin | `StoreSettings` carries `seniorPwdDiscountEnabled` (read + PATCH); `SettingsPanel` Tax/VAT card gains an "Accept the statutory 20% Senior Citizen / PWD discount" switch. |
| Storefront | `CheckoutForm` step 1: Senior Citizen / PWD claim buttons + ID number + cardholder name (ID verified in person at delivery/pickup). Step 3 (review): statutory line + DPA consent checkbox gating "Place order". |
| Tests | +11: `domain/statutory-discount.test.ts` (5: 20% math floored, rejects bad inputs, validate accept/reject, normalize) + `checkout/statutory-consent.test.ts` (6, real DB: consent required, senior 20% + captured on order, invalid claim rejected, store toggle off → conflict, stacks after voucher capped at remaining subtotal, ConsentRecord written). Ripple: added `consentGranted: true` to request builders in `checkout.service`, `checkout-address`, `voucher-v2`, `variant-cart`, `store-access` tests. |
| Gate | api + web `tsc` 0 errors · web build ✓ · **53/53 tests across the 7 touched files pass standalone** (`statutory-discount` 5, `statutory-consent` 6, `checkout.service` 16, `checkout-address` 5, `voucher-v2` 6, `variant-cart` 4, `store-access` 11). Full-suite run remains flaky under shared-DB contention (failure set shifts run-to-run, e.g. worker/outbox, POS variant, stock-ledger) — pre-existing per the P3a note; every such test passes in isolation. |
| Commit | (this commit) |

## P3a — Voucher engine v2

| Item | Detail |
|---|---|
| Schema | `Voucher.type` (`fixed`/`percent`/`free_delivery`), `percentBp`, `firstOrderOnly`, `perCustomerLimit`, `scopeType` (`all`/`product`/`category`) + `scopeRefId`, `stackable`; `VoucherRedemption.storeCustomerId` + index for per-customer accounting. Migration `20260916190000_module_p3a_voucher_engine_v2`. |
| Domain | `domain/voucher.ts` v2: `VoucherSnapshot` extended; `evaluateVoucher(voucher, ctx, now)` with new reasons (`first_order_only`, `per_customer_limit`, `scope_mismatch`, `no_delivery_fee`); `computeVoucherDiscount` (percent of subtotal, capped; free-delivery = fee; fixed capped at total). |
| Gateway | `VoucherPublicService.validate(storeId, code, ctx)` — resolves per-customer redemptions, first-order status, and category ids for scoped vouchers; returns `discountMinor + stackable`. `redeem` records `storeCustomerId`. |
| Checkout | `VoucherGateway` signature → context (subtotal/total/fee/storeCustomerId/productIds). **Stackability rule:** a non-stackable voucher blocks loyalty redemption at checkout (conflict); `createAtomic` redemption rows now carry `storeCustomerId`. |
| Admin | `VoucherAdminService` create/update accept type/percentBp/firstOrderOnly/perCustomerLimit/scopeType + `scopeSku`/`scopeCategorySlug` (resolved to ids server-side) + stackable; validation per type (fixed needs positive amount, percent needs bp 1..10000); list returns the new fields. Controller whitelists + dates. |
| UI | `VouchersPanel`: type select (fixed/percent/free-delivery), % input, per-customer limit, first-order + stackable toggles, scope select with SKU / category-slug fields; table shows value + rule chips. |
| Seed | `PINDIAN10` (10% off, min ₱100, stackable) + `FREESHIP` (free delivery, non-stackable). |
| Tests | +12: `domain/voucher.test.ts` v2 (fixed/percent/free-delivery math, first-order, per-customer, product+category scope, no-delivery-fee, cap) + `checkout/voucher-v2.test.ts` (real DB: percent discount, free-delivery waives fee, first-order reject/accept, per-customer limit on 2nd redemption, product-scope match/miss, non-stackable blocks loyalty). Found & fixed: product-scope check was accidentally dropped during a rewrite — now DB-covered. |
| Notes | Full-suite flakiness on `variant-cart`/`outbox` observed again (leftover-store orderNumber prefix tension + cross-file outbox events) — both pass standalone; sweeper extended for `\d{2}p3v` slugs; not caused by P3a. |
| Gate | lint 0 errors · **full suite 58 files / 397 tests / 0 fail** · live HTTP: 2×Turon ₱160 + ₱50 − 10% (₱16) = **₱194.00** via `PINDIAN10`; admin created/listed/updated a percent voucher (then removed). |
| Commit | (this commit) |

## P2c — Admin-panel variant + add-on configuration (APIs + Products editor)

| Item | Detail |
|---|---|
| API | `ProductAdminService` + `/admin/products/*` routes (all `resolveTenant ADMIN` + `cacheBust`): `POST :id/variants` (create variant w/ opening stock → `RECEIPT` movement), `PATCH variants/:vid` (name/sku/price/active + set on-hand count → guarded write + `ADJUST` movement; refuses below reserved), `DELETE variants/:vid` (refused while stock reserved), `POST :id/addons` (group w/ nested options), `PATCH addons/options/:oid`, `DELETE addons/:addonId` (cascade), `DELETE addons/options/:oid`. SKU uniqueness per store; cross-store invisible (not_found). |
| List | `/admin/products` now returns each product's `variants` (price/stock/available) **and** `addons` (groups → options). |
| UI | `VariantEditor.tsx` modal (variants list: rename/inline price + stock set/delete; add new variant; add-on groups with option chips + delete option/group; add group with first option). Opened via a new sliders button per product row in `ProductsPanel`; every write reloads the panel. |
| Tests | +6 `admin/product-variant-admin.test.ts` (real DB): addVariant opening stock + RECEIPT ledger, updateVariant price/name + absolute-stock ADJUST movement (delta 7), duplicate-SKU conflict + set-below-reserved guard, delete-while-reserved refused, add-on group/option CRUD, **tenant isolation (variant of store A invisible to store B)**. |
| Fixes | Nested add-on option create no longer passes the redundant `storeId` (Prisma auto-fills the composite FK — passing it was a validation error). |
| Notes / honest | Still PENDING Phase 2 remainder: featured/tags/related/upsell, warehouse low-stock surfacing, add-on price revalidation at checkout. |
| Gate | lint 0 errors · **full suite 57 files / 385 tests / 0 fail** · live HTTP smoke: `/admin/products` returns KAPE-MALAY variants+addons; created/updated(deleted an XL Smoke variant (set stock 7/price 19000) → verified removed. |
| Commit | (this commit) |

## P2b — POS terminal sells variants (closes Phase 2 "POS can sell variants")

| Item | Detail |
|---|---|
| Ledger | `movements.ts` `recordMovement` + `deductStock` + `restoreStock` gain variant branches: variant lines decrement/increment the **variant's own counter** via guarded `quantityOnHand >= take` UPDATE and write a `StockMovement` carrying `variantId`. |
| POS | `PosSellItem.variantId` (contracts); `LoadedLine` carries `variantId/variantName`; `loadProducts` resolves variants (must belong to the product + active), prices from the VARIANT, checks availability against the variant's `onHand - reserved`; `makeOrder` + `orderItem.createMany` snapshot `variantId/variantName`. Applies to sell/hold/hold-complete/pre-orders (all share `loadProducts`). |
| Admin | `/admin/products` now returns each product's `variants` (id/name/sku/price/stock/available/isActive). |
| Terminal UI | `PosPanel`: `PosProduct.variants`, `CartLine.variant`; adding a product defaults to the first available variant; the review line shows a variant `<select>` (swaps price); hold/sell payloads send `variantId`; resume maps held variant lines back. |
| Tests | +4 `pos/pos-variant.test.ts` (real DB): utang sale with variant → variant price + snapshot + counter decrement + CONSUME movement; beyond-variant-stock conflict; cross-product variant rejection; hold reserves variant stock + void restores it. |
| Ops | Fixture sweeper now also covers `posx-` and `v6t` stores (found leaked `posx-` stores from earlier aborted runs were colliding on 6-char order-number prefixes → full-suite flake). |
| Notes / honest | Still PENDING (Phase 2 remainder): admin-panel **create/edit** variant/add-on management UI (products are configured via seed/DB today), featured/tags/related/upsell, warehouse low-stock surfacing, add-on price revalidation at checkout. |
| Gate | lint 0 errors · **full suite 56 files / 379 tests / 0 fail** · live HTTP smoke: `/admin/products` returns KAPE-MALAY variants; a real cash POS sale of the **Iced** variant → order total exactly `16000` (variant price); storefront `/sam-store?token=` 200 with Kape Malay. |
| Commit | (this commit) |

## P2a — Variants + add-ons/modifiers (catalog → storefront → cart → checkout)

| Item | Detail |
|---|---|
| Schema | `ProductVariant` (own SKU/price/stock counters; tenant-scoped, cascade), `ProductAddon` + `ProductAddonOption` (groups→options with server prices). `CartItem` line identity → `@@unique([cartId, productId, variantId, addonKey])` with `""` sentinel (NULLs make Postgres unique permissive → duplicate plain lines), `addons Json` snapshot + `addonsTotalMinor`; `OrderItem` gains `variantId/variantName/addons` immutable snapshot; `StockMovement.variantId` for variant reservation audit. Migrations `20260916180000_module_p2a_variants_addons` + `…_cart_variant_identity` (drop variant FK — sentinel "" can't reference a variant; tenancy stays app-enforced; backfilled existing rows). |
| Repos | `ProductVariantRecord/AddonRecord`; `CatalogRepository.getVariantById/getVariantsByIds/getVariantsByProductIds/getProductAddons`; `CartRepository.addItem` upserts by the new compound key + stores add-ons; `updateItemQuantity/removeItem` now target the **line id** (CartItem id); `AtomicCheckoutEffects.stockReservations` carries `variantId`. |
| Cart | `CartService.addItem` resolves the variant (must belong to the product, active), prices from VARIANT price, resolves add-on options server-side (client prices never trusted), computes `addonKey` fingerprint + `addonsTotalMinor`, guards variant stock `onHand - reserved` vs existing line qty; cart callers updated to lineId. |
| Checkout | `revalidateCartLines` re-prices variant lines from LIVE variant price and drops missing/inactive/mismatched variants; `computeOrderTotals` includes `addonsTotalMinor`; `createAtomic` RESERVES variant counters via guarded conditional UPDATE + a `RESERVE` StockMovement carrying `variantId` (same atomic "two buyers" safety as StockLevel); items snapshot variant name + add-on names/prices; tax base includes add-ons. |
| Public storefront | `ProductDTO` now carries `variants` + `addons`; **`ProductPicker`** modal (variant buttons incl. sold-out state, add-on group toggles with required validation, qty, live total). Product cards open the picker for variant/add-on products; `CartDrawer` renders variant + add-on lines with per-line price incl. add-ons and line-id qty controls. |
| Seed | `db:seed` adds **KAPE-MALAY** (Hot/₱140 Iced/₱160 variants + "Extras" group: Extra shot +₱20, Soy/Silky +₱30) for manual walkthroughs. |
| Tests | +4 `cart/variant-cart.test.ts` (real DB): distinct lines per add-on combo + server prices, variant stock guard (5-unit commit ceiling), cross-product variant rejection, **atomic variant reservation + name/add-on snapshot on checkout** (+ `StockMovement` audit). Existing cart unit tests migrated to the lineId API. |
| Notes / honest | **P2b (not in this module):** admin-panel variant/add-on management UI, featured/tags/related/upsell, warehouse low-stock surfacing, **POS variant selling** (`pos.service` load/reserve flows still product-only; POS sells plain products), and add-on price revalidation against live groups at checkout (add-on prices are server-frozen at add-time). |
| Gate | lint 0 errors · **full suite 55 files / 375 tests / 0 fail** · live HTTP smoke: storefront returns KAPE-MALAY variants(+add-ons); cart add Iced+Extra shot ×2 → 36000; checkout total ₱410 incl. delivery; web `/sam-store` 200. |
| Commit | (this commit) |

## P1.portal — Customer account: saved addresses, consent, "use at checkout"

| Item | Detail |
|---|---|
| Schema | `StoreCustomerAddress` (tenant-scoped via the `StoreCustomer` profile; PH codes + FROZEN name snapshots; `isDefault`; cascade delete) and `ConsentRecord` (RA 10173 append-only: scope/channel/granted/version/recordedBy). `Customer.consents`, `StoreCustomer.addresses` relations. Migration `20260916170000_module_p1_customer_account`. |
| Service | `CustomerAuthService` (+injected `AddressService`): `list/create/update/deleteAddress` — PH codes all-or-nothing + chain-validated through `AddressService`, name snapshots; lazy `ensureProfile` so a brand-new customer can save an address pre-first-order; first address auto-default; `update` without codes preserves the snapshot. `recordConsent`/`listConsents`; `register` captures the `dpv1` consent when provided. |
| API | Controller routes: `GET/POST/PATCH/DELETE /auth/customer/addresses(/:id)`, `POST /auth/customer/consent`, `GET /auth/customer/consents`. All token-guarded (JWT role CUSTOMER). |
| UI | `CustomerAccount.tsx` saved-addresses book (list/add via PH cascading selects/set default/delete) + "Use at checkout" → `localStorage.samstore.savedAddress`; `CheckoutForm` prefills the PH cascade + street from it (validated against live lists; silently ignored when codes no longer resolve). Register form includes the DPA consent checkbox. `PublicStoreDTO` now carries `id` so the account can scope addresses per store. |
| Fixes found | `resolveCodes` initially filtered the KEYS instead of the VALUES (would pass key names to the address lookup) and the names map used code keys (would overwrite codes with names) — both corrected; the shared path is now covered by DB tests. |
| Tests | +5 `auth/customer-account.test.ts`: consent capture+list, address CRUD + PH snapshot + default + snapshot-preserving update + delete, partial-codes rejection, **tenant isolation (customer A cannot read/edit/delete customer B's address)**, bad-token rejection. |
| Item 3 (tenant/audit) | Hardening sweep: `StoreCustomerAddress` carries `storeId` + composite `@@unique([storeId, id])`; the tenant boundary is the per-store `StoreCustomer` profile (cross-tenant tests above). `Ph*`/address-lookup endpoints are platform reference data (no store data → no cross-tenant surface). `ConsentRecord` is customer-global by design (a person, not a store). App-layer isolation (no RLS) remains the documented enforcement point. |
| Gate | lint 0 errors · **full suite 54 files / 371 tests / 0 fail** · live HTTP smoke: register+dpv1 consent → save "Bahay @ Bangkal, Makati, Metro Manila (NCR)" (snapshot + default) → list + consents; web `/sam-store` 200. |
| Commit | (this commit) |

## P1 — PH context: address model + checkout dropdowns + shared formatters

| Item | Detail |
|---|---|
| Schema | `PhRegion/PhProvince/PhCity/PhBarangay` (platform reference data — NOT store-owned; `code` unique, cascade parents, `PhCity.type` city/municipality). `Order` gains nullable `delivery{Region,Province,City,Barangay}{Code,Name}` — codes for join, NAMES frozen as the immutable snapshot. Migration `20260916140000_module_p1_ph_address`. |
| Drift healed | Live DB `User.email` was still NOT NULL while schema says optional (A1 only added phone columns) — latent bug for phone-only registrations. Migration drops NOT NULL (always safe). |
| Contracts | `format.ts`: `formatPesos` (₱1,234.50 grouping), `manilaNow`/`formatManila` (Asia/Manila, host-tz-independent), `pesoInWords` (pragmatic Filipino amount-in-words to bilyon, with centavos + ligatures). `CheckoutRequest` gains optional `regionCode/provinceCode/cityCode/barangayCode`; `OrderViewDTO` gains name snapshots. |
| API | `AddressController` (`/public/address/regions|provinces?region=|cities?province=|barangays?city=`) + `AddressService` behind `ADDRESS_GATEWAY`. `checkout.service` takes an optional `AddressGateway`; when any code is present ALL FOUR must be present for delivery, chain-validated (never guessed), names snapshotted onto the order + `snapshot.phAddress`. Partial codes, pickup+codes, broken chain, unknowns → clean validation errors. Legacy free-text-only checkout unchanged. |
| Seed | `db:seed:addresses` (`prisma/seed-ph-addresses.ts`): curated upsets — 17 regions, 17 provinces, 60 cities/municipalities, 592 real barangays (Metro Manila full + Cavite/Laguna/Batangas/Rizal/Bulacan/Pampanga/Cebu/Bohol/Iloilo/Bacolod/Davao/Cagayan de Oro/GenSan/Baguio/La Union/Pangasinan samples). Full PSGC dataset PENDING (labelled). |
| Web | `api/address.ts` helper; `CheckoutForm` delivery section = 4 cascading selects (region→province→city/municipality→barangay) + street/building/landmark/schedule; review step shows the joined PH line; Continue requires line1 ≥5 + full selection on delivery. |
| Tests | +15: `ph-format.test.ts` (9 pure unit), `address/service.test.ts` (2 DB: cascade + chain reject), `checkout/checkout-address.test.ts` (5 DB: snapshot, partial reject, pickup reject, unknown-chain reject, legacy path). |
| Ops | Fixture sweeper extended for `P1C/P1T/P1AD` slugs + PH region trees; cleaned 28 leaked stores + 20 leaked regions from aborted runs. |
| Gate | lint 0 errors · **full suite 53 files / 366 tests / 0 fail** · API boots (`/health` ok; regions=17; NCR→Metro Manila→17 cities→24 Makati barangays) · web `/sam-store` HTTP 200. Dev servers left running on :4100/:3000. |
| Commit | (this commit) |

## Phase 0 — Foundation transfer into `extraricestore` (Pindian repo)

| Item | Detail |
|---|---|
| Source | Copied from `D:\opencode project` ("sam-store") per `PLAN.md` (D1–D4 resolved: fresh git, reuse Supabase DB, keep `@sam-store` identifiers, exclude heavy/scratch dirs). Verified source/dest tree identical except 2 intentional lint fixes (below). |
| Lint fixes (pre-existing) | `product-validation.ts:59` removed `\-` no-useless-escape; `ProductCard.tsx` dropped dangling `@next/next/no-img-element` disable (rule not registered in flat config). Result: **0 errors** (200 pre-existing warnings left untouched). |
| Boot fix | Root `start:api` ran tsx from repo root (no tsconfig) → `experimentalDecorators` not applied → Nest decorator crash. Fixed script to `cd apps/api && node --import tsx src/main.ts` (matches `dev:api`). |
| Infra | `npm install` 483 pkgs (1m); Prisma 6.19.3 client generated; `db:deploy` → "No pending migrations to apply" (shared Supabase already migrated); `db:seed` idempotent (sam-store, 4 products, 6 demo accounts). |
| Gate | lint 0 errors · **unit tests 351 pass / 0 fail across 50 files** (`npm test`, sequential runner) · API boots on :4100 (`/health` ok; `/public/stores/{slug}?token=` returns store + 4 products) · web boots (`next dev` on :3100; `/sam-store` HTTP 200 "Sam's Store - Order Online"). |
| Env notes | `REDIS_URL` placeholder → in-process fallback (by design); `JWT_SECRET` absent from local `.env` (placeholder in `.env.example`) — set before prod. PS5 console shows `₱` as `?` (encoding only; data correct). `npm run dev:web` inline-var bash syntax doesn't work under `cmd` — launch web as `npx next dev` with `NEXT_PUBLIC_API_URL` set in the parent env. |
| Commit | (this commit) |

---

# SAM STORE — Progress Log

Updated: 2026-09-14 · **A1 phone-first identity** · Active model: `deepseek/deepseek-v4-flash-0731` (openrouter), boilerplate tier `inclusionai/ling-3.0-flash`

## A1 — Phone-first identity (`phone-first-identity-v1.md`)

| Item | Detail |
|---|---|
| Schema | `User.phone String? @unique` (E.164), `email` becomes `String?` (unique), `phoneVerified Boolean @default(false)`, `phoneVerifiedAt DateTime?`. Migration `20260914120000_module_a1_phone_identity` applied. |
| Domain | `apps/api/src/domain/phone.ts` — `toE164`/`isPhMobile`/`formatPh` (5 PH spellings → `+63…`; landline/garbage rejected). Single entry point for every phone parse. |
| Repo | `AuthRepository.findByIdentifier` (normalized phone OR lowercased email); `createUser` gains `phone`; `findByEmail` kept for legacy. |
| Service | `register` accepts `phone` + optional `email`; `login` takes `{ identifier }` (or legacy `email`); tokens carry optional `phone`. **D7 kill switch** `IDENTITY_REQUIRE_PHONE=true` ⇒ phone required at register (default off ⇒ legacy email-required flow unchanged). Conflict on duplicate normalized phone = clean 409. |
| DTOs | `REGISTER_DTO`: `email`/`phone` optional, `role`/`storeId` still rejected; `LOGIN_DTO`: `identifier` (+`email` alias). |
| Web | Login page → "Phone or email" identifier (demo quick-fill + must-change flow kept); register page gains optional phone field. |
| Seed | Demo accounts + platform admin + store owner backfilled deterministic PH phones (e.g. `+639170000001` manager) → phone login demos. **Pre-existing seed bug fixed:** nested `stockLevels.create` no longer passes `storeId` (current Prisma client rejects it; the on-disk client regen surfaced it). |
| Tests | 26 green: `phone.test.ts` (5 spellings/landline/garbage/formatPh), `auth.service.test.ts` (+6 A1 tests incl. Module-1 smuggled role/storeId), `validate.test.ts` (DTO boundaries). DB-backed: `store-access.test.ts` 11/11, `store-access-users.test.ts` 11/11, `team.service` + `suppliers` 7/7. |
| Gates | typecheck (contracts+api+web) pass, web build pass, secrets 0 high, eslint no new errors. Live probe: login by phone `+639170000001` → 201 → dashboard via browser; login by email same user; register+role → 422. |
| Commit | (this commit) |



## 2026-09-14 R1 applied (operator-approved)
- reconcile --apply: corrected drifted balances from ledger-ledger (mostly leaked M5/POS test fixtures, now deleted); post-check clean (0 drift).
- fixtures cleanup --apply (script fixed to FK-safe delete order incl. registers/sessions/movements/expenses/purchases/suppliers): removed all leaked test stores.
- **Heads-up**: sam-store KAPE-001 stock corrected ledger-implied to -79 on hand — the on-hand ledger was already negative from aborted test/checkout activity. Needs a manager stock-take / purchase intake to rebuild.

## 2026-09-14 ops hotfix (`2dc2f69`)

- **Cause**: M6 wired `PurchasesController` → `SUPPLIERS_SERVICE` without registering the provider in `AppModule`, so Nest threw `UnknownDependenciesException` at boot and the **API never started**. The web's `/sam-store` server-side `fetch` to the API then threw ("Application error: a server-side exception", digest `1086205557`), and `/admin/login`'s client fetch showed "Network error".
- **Fix**: registered `SUPPLIERS_SERVICE` (import + provider) in `apps/api/src/app.module.ts`.
- **Port alignment**: web (`config.ts` default + `NEXT_PUBLIC_API_URL`) points at **4100**; API defaulted to **4000** (`main.ts`). Added `PORT=4100` to local `.env` (gitignored) so the API now listens on 4100.
- **Verified**: `GET http://localhost:4100/health` → 200; web `/`, `/sam-store`, `/admin/login` → 200.
- **Follow-up (client-side "Application error" on /admin/dashboard)**: the long-running `next dev` (PID 3804, started before M8/M9/R3 edits) served a stale in-memory chunk manifest → `ChunkLoadError: chunk 957` on the dashboard. Restarted the web dev server; dashboard + all panels now render with live data. `/sam-store` "Store not found" is **by design** (route requires `?token=…`; without it the 404 is identical to an unknown store — no leakage). Working storefront link carries the token.

## NexoPOS-inspired upgrade (prompt: `prompts/nexopos-inspired-counter-upgrade-v1.md`)

| Mod | Summary | Commit |
|---|---|---|
| **M7 roles × permissions matrix** | `RolePermission` model (storeId, role, key, allowed; `@@unique([storeId, role, key])`) + migration `20260914045955_module_m7_role_permissions`. **Coarse deny-only** design (operator decision): the keys ARE the 5 `TENANT_ROLES` capability sets (ADMIN/VIEW/MANAGE/OWNER_MANAGER/DELIVERY); a row only ever REMOVES a set from a tenant role — granting a capability a role lacks in the baseline is a 422, so "never widen silently" is structurally impossible. Every change writes an `AuditLog` (`role_permission.set`, before/after) in the same transaction. `resolveTenant` applies the overlay in ONE place via a capability-set → key reference map (the 76 guard call sites pass the same `TENANT_ROLES.*` array objects, so **no controller edits**, and a caller-passed literal array falls through to the raw membership check = default-permissive = missing row == today's behaviour). Effective sets are ttl-cached 30s per store + `cacheBust` on write (same `ttl-cache` as products). Matrix UI in `UserAccessPanel.tsx` (Role permissions card, role × 5-set checkboxes, restore=uncheck, audited), gated to MANAGE (`roleCan("manageTeam")`/platform). **Vocab fix rode along** (operator decision): `OWNER` == `STORE_OWNER` in `roleCan()`/`TABS_BY_ROLE`/`defaultTabFor` (+ `isOwnerRole`), and `AdminDashboard` now derives nav role from the ACTIVE store's **membership** role (authority) instead of the JWT global claim, fixing owners created via store-admin seeing STAFF-level nav. | (this commit) |
| **M6 suppliers master** | `Supplier` model (storeId, name, contactPerson, phone, email, unique per store), `Purchase.vendorId` FK (keeps `vendor` text as legacy fallback), purchases API GET/POST `/admin/suppliers`, panel supplier autocomplete dropdown + supplier name on purchase rows (vendor shown as legacy fallback), backfill script (`scripts/backfill-suppliers.ts` — dry-run by default, `--apply` to execute, idempotent per store). Migration `20260914041915_module_m6_suppliers`. | `7f3d135`, `3ee43c9` |
| **N1 cash drawer & shifts** | `Register` + `RegisterSession` + append-only `CashMovement` (tenant-consistent composite FKs); one open shift per store enforced by a **partial unique index**; derived expected cash (float + cash-in − cash-out + tenders − refunds); guarded close (no double-close) storing counted/expected/variance; X/Z reports; counter **cash** sales blocked without a shift (`requireOpenShift`, default on for app-created stores) and bound to the shift on both the order and the tender; POS register bar + cash-in/out + close-with-variance + printable 57mm report; `POST/GET /admin/registers*` with DTO validation and tenant guard | `0a5d2b4` |
| **N1 risk fixes** | the three non-POS cash paths now carry drawer attribution through `RegisterService.attachOpenSession` (non-enforcing): refunds, admin-recorded payments and voids attribute the row to the open shift (null when the counter is closed), and utang settlements are attributed too. Live-probed: a cash refund recorded during a shift lowers that shift's expected cash; the same amount recorded with no shift open leaves the drawer alone. `totalsFor` was switched to sequential queries — a parallel burst from one client could exhaust the pooler's session cap (`EMAXCONNSESSION`) | (this commit) |
| **N2 split & partial payments** | order payments are recorded as an explicit **tender list** in one transaction (`POST /admin/orders/:id/payments` with `tenders`): over-payment is a 409, cash tender/change, per-method reference requirements, credit tenders run through `CreditService.sellOnCredit` so only the credit portion hits the limit guard, and the whole command is **idempotent** by `idempotencyKey` (replay returns the original rows). Per-store **payment-method registry** (`PaymentMethod`, seeded on first use, manager+ upsert, disable blocks use). `GET …/payments` now returns a DERIVED `summary` (`paid/refunded/outstanding/change/settlement`) — never stored, so it can't drift. Tendering during an open shift attaches the rows to that shift (cash → drawer, the rest → non-cash takings). The DTO validator gained a real **array rule** with per-item validation (`tenders[0].amountMinor …`) after a probe caught the object sanitizer silently dropping the list | `6307c3e` |
| **M1 split payments in the real money paths** | `payments/tenders.ts` is now the ONE writer for payment rows (`prepareTenders` validates methods/overpay/coverage/change/references/credit-limit; `writeTenders` writes the rows + the credit ledger). POS `sell` and `hold/:id/complete` accept an optional `tenders[]` (`PosTender`); when absent the legacy single-method input becomes a one-row list, so nothing that worked before changed. The drawer gate and signature rule now follow the **kinds** in the tender list (cash → open shift, any credit tender → signature); `paymentStatus` is COLLECTED only when no credit tender remains. Orders **Pay modal** gains a split mode: per-row method/amount/cash-tendered/reference with live Remaining/Change, server messages shown verbatim. `pos.service.ts` has zero inline `payment.create` calls left | `d5cfe78`, `9befef5`, (this commit) |
| **M2 stock adjustments & ledger screens** | `domain/movements.ts` gained `adjustStock()` — the level stays derived, the movement is the source of truth, the write is a compare-and-set guard, a negative result is refused unless explicitly allowed (manager stock-take), and the row carries actor + reason (in `note`) + `balanceAfter`. `inventory.service.ts` adds `adjust()` (reason required, product/warehouse tenant-checked, audit-logged in the same transaction), `adjustments()` and `movements()` (raw ledger with resolved actor names). Routes: `POST /admin/stock/adjust` (OWNER/MANAGER only) + `GET /admin/stock/{movements,adjustments}` (VIEW), DTO rejects unknown keys. UI: Inventory panel gained a per-row **Adjust** (5-step flow: product → current stock shown → delta/count + reason → confirm, with an explicit "allow negative" switch for stock-takes) and a **Stock flow** view (when/type/change/balance/reason/actor, product filter). | `e485126`, (this commit) |
| **M3 receipts & labels** | The receipt payload now carries the **tender breakdown**: each payment with its method label + kind, what was handed over (`tenderedMinor`), the change, the reference, plus a derived `tenders` summary (paid/refunded/change/outstanding/settlement). `ReceiptModal` prints one line per tender (label · amount · handed · ref · change) with a Status line, and its print block is now a real **57 mm thermal spec** (`@page { size: 57mm auto; margin: 2mm }`, monospace 11px, dashed rules, only the slip visible). New `LabelSheet.tsx` prints **57 × 40 mm** product labels (store name, product, price, SKU·unit, barcode-or-SKU) one per page on a 57 mm roll, batch-selected from ProductsPanel (checkbox column + "Print labels (N)"). | (this commit) |
| **M4 tax engine (PH VAT)** | `domain/tax.ts` (+ `tax-store.ts`) extracts or adds VAT per line with half-up centavo rounding, handles VAT-exempt products, applies the voucher/loyalty discount to the VATable base **before** tax, and excludes the delivery fee from the taxable base. Four columns are frozen on every order (`vatableMinor`, `vatMinor`, `vatExemptMinor`, `vatRateBp`) by all three writers — POS `makeOrder`, checkout (`OrderRecord` → `createAtomic`), and the admin item edit — and the invariant `net + VAT + non-VAT == subtotal + fee − discount` holds in every mode, kill switch included. `StoreSettings` gained `vatEnabled` / `vatRateBp` (1200) / `pricesIncludeVat` / `vatShowOnReceipt` / `tin`; `Product` gained `taxExempt`. The slip prints a BIR block (VATable Sales · VAT (incl.) 12% · VAT-Exempt · Zero-Rated · TIN) and the owner can hide it — display only, totals never move. Settings UI has a Tax/VAT section, Products has a VAT-exempt switch + badge. | (this commit) |

**M1 cost record** (plan §1.4) — gate runs: 4 targeted sets + 1 full gate (42/283/283/0) · E2E: 9/9 · web rebuilds: 2 · defects the tests caught: 2 (credit tender lost its Payment row in the refactor; the tender list initially dropped by the DTO sanitizer in N2/M1 wiring) · full-file reads: 0 (all anchor-reads on the 67KB panel and the POS service).

**M2 cost record** (plan §1.4) — gate runs: 2 targeted sets + 1 full gate (44/291/291/0) · E2E: spec 08 + full suite 10/10 · web rebuilds: 2 · defects caught: 2 (my own ledger-identity assertion was wrong — opening stock is not a movement, which is exactly the drift class `reconcile.ts` reports on the demo store; the adjust modal's labels were not associated with their inputs, an a11y gap) · full-file reads: 1 (InventoryPanel, 134 lines).

**M3 cost record** (plan §1.4) — gate runs: targeted spec only · E2E: 09 + full suite · web rebuilds: 1 · defects caught: 0 product defects; 4 test-harness fixes (date filter hid older orders; card/table duplicate DOM → `:visible`; CSSOM drops `@page` → read the style tag; drawer cleanup) · full-file reads: 1 (ReceiptModal, 138 lines).

**M4 cost record** (plan §1.4) — gate runs: 1 full unit gate + 1 targeted spec · E2E: 09 (with VAT asserts) + full suite · web rebuilds: 2 · API restarts: 3 · **defects caught: 1 real** — the checkout path computed the VAT into the in-memory `OrderRecord` but never into the DB write (`create`/`createAtomic` mapping), and TypeScript stayed silent because a spread skips excess-property checks; the live probe caught it (VAT ₱0.00 on a real delivery checkout). Probe-harness fixes: a tenant-unscoped order lookup that matched another store's row when `orderId` was undefined, a masked phone literal, and a voucher code read from a response that only returns an id · full-file reads: 2.

**M5 cost record** — gate runs: 1 validation-file run (12/12) + M5 integration run (6/6, incl. cross-store duplicate allowed) + full 46-file suite (all green after cleaning ONE leaked `tok.abc` claim token row — the documented aborted-run leak, unrelated to M5) · typecheck api+web · web build · migrate deploy · defects caught: 0 product defects; 1 harness flake (hardcoded `claimToken: "tok.abc"` collides when an earlier aborted gate leaves a row behind — cleaned, not code).

**M6 cost record** — gate runs: typecheck api+web · web build · migrate deploy · unit tests 18/18 (purchases.service + suppliers.service + M5 integration + M6 integration) · secrets 0 high · defects caught: 0.

**M7 cost record** — gate runs: typecheck contracts+api+web · web build · migrate deploy · M7 integration 8/8, then a combined auth regression 34/34 and a full touched-surface sweep 85/85 (tenant-context, auth.service, store-access, purchases, suppliers, M5 product, product-validation) · secrets 0 high · defects caught: 2 in harness (cleanup FK order — RolePermission blocks store delete unless deleted first; a `!map.get()` truthiness bug in `listRolePermissions` that showed denies as allowed) + 1 real UI fix (matrix checkbox restore → PUT allowed=true).

**M8 cost record** — gate runs: typecheck api+web · web build · reports service 7/7 · secrets 0 high · defects caught: 0.

**M9 cost record** — gate runs: typecheck api+web · web build · secrets 0 high · defects caught: 0.

**R2 cost record** — ESLint flat config (TS + React hooks) wired into `npm run lint`. 198 pre-existing issues found (2 errors: `no-useless-escape` in existing code, missing `@next/next` plugin; 196 warnings). All new code (M8–M9, R4) passes clean.

R4 cost record** — added `retryDelivery` (FAILED_DELIVERY → OUT_FOR_DELIVERY) and `cancelPostDispatch` (OUT_FOR_DELIVERY → CANCELLED, 30m window) to delivery service + controller + 4 new unit tests.

**R1 status** — dry-run completed: 50 drifted balances (leaked test fixtures from aborted runs), 8 leaked test fixtures. `npm run reconcile --apply` + `fixtures:cleanup --apply` needs operator ok.

**R3 status** — DONE (async migration). New `persistence/redis.ts` (Upstash `@upstash/redis` client + in-process fallback when `REDIS_URL` empty), `ttl-cache.ts` + `rate-limit.ts` now **async** Redis-backed with fallback; ~38 cache call sites migrated to `await`; rate-limit middleware awaits the shared window. Web build fixed (`next.config.mjs` disables Next build-time lint — the R2 ESLint gate is the source of truth). To activate: operator adds `REDIS_URL="rediss://default:TOKEN@region.upstash.io:443"` to `.env`.

## Audit remediation (re-verified the 11 modules against the prompt's bullets)

| Fix | What it closed | Commit |
|---|---|---|
| **1 stock atomicity** | `deductStock` + checkout reservation are now guarded DB-boundary writes (`WHERE quantityOnHand >= take` / `onHand - reserved >= qty`) with a typed `InsufficientStockError` → 409 via a global filter. Checkout previously had **no** availability enforcement at all. Prisma gets a global transaction budget (30s/15s maxWait — a cold pooler beat the 5s default: `P2028` observed live). | `623ab12` |
| **2 transactional outbox** | the `order.received` event is written INSIDE `createAtomic` (was post-commit fire-and-forget); a committed order always has its event, and the loser's rolled-back attempt writes none | `623ab12` |
| **3 runtime DTO validation** | dependency-free schema checker wired into every untrusted boundary: checkout, cart add/update, claim, register, login, change-password, public store lookup. Unknown keys are rejected (a client-supplied `role`/`storeId`/`totalMinor` is now a 422) | `de15bb0` |
| **4 reconciliation** | `domain/reconcile.ts` + `scripts/reconcile.ts` check all four identities (voucher counter, loyalty, credit, on-hand stock) — dry-run by default, exit 1 on drift. Replaces `reconcile-stock.ts`. `scripts/cleanup-test-fixtures.ts` removes leaked test fixtures | `2c79b4f` |
| **5 ops** | request ids (`X-Request-Id`), structured REDACTED logs (no query strings — public tokens live there), `/health/metrics` (counters + outbox backlog), `npm run lint` (typecheck + secret scan), `npm run test:cov`, CI workflow, recursive test glob | (this commit) |

### Test-gate correction
`scripts/run-tests.mjs` used an explicit per-directory pattern list and silently skipped
`persistence/`, `security/`, `orders/` and `public/` — the M2/M4/M5 test files never ran
in the aggregate gate. It now globs `apps/api/src/**/*.test.ts` recursively (**39 → 40 files**).

### Live findings from the remediation
- **Reconciliation found real drift on the dev DB**: 46 rows, dominated by leaked test
  fixtures (aborted runs skip their `after()` hook: `m5…-store`, `tzo-*`, `obx*`) plus five
  `POS Test Customer` credit balances whose ledger rows were deleted by earlier cleanups.
  `npm run reconcile` (dry-run) reports them; `npm run fixtures:cleanup --apply` and
  `npm run reconcile --apply` fix them (both need an operator go-ahead before applying).
- **My own reconcile identity was wrong first**: RESERVE movements move `quantityReserved`,
  not on-hand, so summing them reported a phantom drift of exactly the reserved quantity
  (HALO-001: "34 vs 40"). Fixed + regression-tested.
- **`.env.example` false positive** in the secret scan (placeholder `USER:PASSWORD@HOST`) —
  the rule now ignores documented placeholders.

## Playwright critical-path E2E (`b013fd5`)

| Spec | Proves |
|---|---|
| `01-api-health` | `/health`+`/health/ready`; public link 404 on wrong/missing token, 200 + `{store, products}` on the real one |
| `02-admin-login` | seeded demo login → dashboard; live browser-session API round-trip 200 |
| `03-storefront-checkout` | full journey: menu → add to cart → 3-step delivery COD checkout → placed (SAMSTO-) → claim token from Copy button → admin detail shows exact token + `fulfillmentType DELIVERY` → claim POST 200-or-409 then 409/409 (atomic single-use) + garbage 401 |

`npm run test:e2e` (single worker — Supabase pool). 4/4 green on live servers.

## Project hardening — Modules 5–11 (run together, all ✅, pushed)

| Mod | Summary | Commit |
|---|---|---|
| **M5 atomic checkout** | `OrderRepository.createAtomic` — order+items+history+claim+stock RESERVE+cart CONVERTED+voucher+loyalty+credit in ONE transaction; checkout now actually reserves stock; concurrent same-key → P2002 → same order returned | `5d20eac` |
| **M6 voucher/loyalty/credit concurrency** | Guarded single-statement UPDATEs (voucher `usedCount`, loyalty balance, credit limit) — no cross-transaction locks (pooler-safe); over-limit → clean conflict; `CreditService.recordPurchase` idempotent | `e2b2069` |
| **M7 void/refund hardening** | Double-void rejected (stock restored once); one refund per order; refunds capped at remaining captured | `7f31ef4` |
| **M8 unified fulfillment** | All delivery checks read the explicit `fulfillmentType` (single `isDeliveryOrder`); admin list/fulfillment facet filter on the enum | `0e68b4b` |
| **M8 reports expansion** | 5 new report views (stock-low, sold-stock, income-loss, sales-by-payment, customer-statement) added to web panel with date range pickers; API endpoints + service methods + integration tests | `45eac35` |
| **M9 sectioned settings** | `SettingsPanel` reorganized into 6 tabbed sections (general, pos, receipt, orders, taxes, invoices) with per-section save bars; reuses existing PATCH /admin/settings endpoint | `f33cbbd` |
| **M9 outbox worker** | `OutboxWorker` drains PENDING → PROCESSED (order.received → NotificationLog) with retries/backoff/FAILED; checkout enqueues after commit; started in main.ts | `301d135` |
| **M10 a11y** | Pay/Delivery modals: `role=dialog`+`aria-modal`+`aria-labelledby`+labeled close; Escape closes any open modal | `7be4ab2` |
| **M11 ops** | `/health` + `/health/ready`; `scripts/reconcile-stock.ts` (dry-run + `--apply`, superseded by `scripts/reconcile.ts` in the fix pass); `docs/runbooks.md` | `ecc8ef2` |

## Project hardening — Module 4: stock reservation & movement engine

| Item | Status |
|---|---|
| New `domain/movements.ts` — `deductStock`/`restoreStock`/`recordMovement` helpers: every stock-level change records an append-only **StockMovement** row (delta sign, type, order link, actor, `balanceAfter`) inside the same transaction | ✅ |
| Wired into ALL stock mutations: POS sell/hold/preorder/complete (CONSUME), hold-void/cancel (RELEASE), item-edit delta (RELEASE+CONSUME), payments void (VOID_RESTORE), purchases receiving (RECEIPT), warehouse setStock + product-edit stock (ADJUST), transfer complete (TRANSFER_OUT/IN) | ✅ |
| Ledger invariant tests: signs, balanceAfter, `initial + Σdelta == current onHand` reconciliation | ✅ |
| POS/payments test cleanup updated for the new StockMovement FK (delete movements before product) | ✅ |

## Project hardening — Module 3: database integrity foundation

| Item | Status |
|---|---|
| **Tenant-consistent composite FKs** — `@@unique([storeId,id])` on Order/Product/Purchase/StoreCustomer/Voucher/StockLevel + composite `(storeId, parentId)` FKs on OrderItem, OrderStatusHistory, OrderClaimToken, ProductImage, StockLevel, CartItem, PurchaseItem, LoyaltyEntry→StoreCustomer, CreditEntry→StoreCustomer, VoucherRedemption→Voucher | ✅ migration `20260911033617_module3_integrity_foundation` |
| **Pre-migration reconciliation** — 12 cross-tenant mismatch checks all `0` before tightening; backfill verified after (105 orders, 0 violations) | ✅ |
| **Explicit fulfillment** — new `Order.fulfillmentType` enum (PICKUP/DELIVERY), backfilled from the address signal; written at checkout (by deliveryType), POS creation (PICKUP), delivery conversion (DELIVERY) | ✅ |
| **`StockMovement`** model (append-only stock movement ledger: RESERVE/RELEASE/CONSUME/ADJUST/RECEIPT/TRANSFER, balanceAfter, order ref) — schema support for Module 4 | ✅ |
| **`OutboxEvent`** model (transactional outbox: PENDING/PROCESSED/FAILED, attempts, nextAttemptAt, payload) — schema support for Module 9 | ✅ |
| Composite-FK test proves a cross-tenant child insert now fails (P2003) | ✅ |

Known remaining gap (documented): nullable-parent refs (Payment.orderId, VoucherRedemption.orderId, LoyaltyEntry.orderId, CreditEntry.orderId, OrderItem.productId) keep single-column FKs — raw composite constraints would trigger Prisma drift-detection on future `migrate dev`, so they were intentionally not added; covered by app-level tenant scoping until a drift-free approach exists.

## Project hardening — Module 2: public access & API edge security

| Item | Status |
|---|---|
| **Public store link now requires slug + high-entropy token** (new `public/public-store.service.ts`); missing/wrong/revoked token → 404 (no slug/token enumeration) | ✅ |
| Storefront passes `?token=` (`[slug]/page.tsx`); Store Link panel builds tokenized links/QR, adds **Regenerate link** + **Revoke link** (owner/manager), revoked banner | ✅ |
| New `POST /admin/store-link/rotate` + `/revoke` (MANAGE) → `rotateStoreLinkToken`/`revokeStoreLink` (token rotation marks `rotatedAt` + reactivates; revoke marks `REVOKED`+`revokedAt`) | ✅ |
| **Claim-token consumption is atomic** — conditional `updateMany WHERE usedAt IS NULL`; concurrent claims → exactly one success, one conflict (concurrency test) | ✅ |
| Edge middleware in `main.ts`: prod config validation (fail boot w/o strong `JWT_SECRET`/`CLAIM_SIGNING_SECRET`/`DATABASE_URL`), `5mb` body cap, security headers, `enableShutdownHooks`, **rate limiting** on public/auth surface (`security/rate-limit.ts`, in-process, no new deps) | ✅ |

Tests: `public-store.service.test.ts` (5) + `order-lookup.service.test.ts` (3, incl. concurrent single-use).

## Project hardening — Module 1: tenant authorization & registration closure (✅, 210 tests)

| Item | Status |
|---|---|
| Public `/auth/register` no longer accepts `storeId` or `role` — creates a bare `STORE_OWNER` user with **no** membership and no `storeId` JWT claim (defense-in-depth test included) | ✅ |
| **Demo-store fallback removed** — no active membership ⇒ **403 denied** (was: silently routed to `cmtifdks2000094ic1j9w8th7`) | ✅ |
| New `apps/api/src/auth/tenant-context.ts` — `resolveTenant()`: per-store ACTIVE membership role is the authorization source (not the global JWT role); platform admin is an explicit bypass requiring a store target; inbound `X-Store-Id` must be an ACTIVE membership | ✅ |
| Migrated **8 controllers** to `resolveTenant` (`admin`, `payments`, `credit`, `pos`, `expenses`, `inventory`, `purchases`, `reports`, `delivery`) — removed 9 duplicated per-controller `resolveStore`/`DEMO_STORE_ID` blocks + global `ADMIN_ROLES`/`MANAGE_ROLES` consts | ✅ |
| Order transitions & customer-approval audit now record the **membership role** (`ctx.role`), not the global token role | ✅ |
| Owner onboarding = invite/admin-created only (operator decision 2026-09-11) | ✅ |
| Gate fix: new `scripts/run-tests.mjs` runs test files **sequentially** — node `--test` ran ~20 DB files concurrently and saturated the Supabase pooler (`pool_size: 15`, `FATAL: max clients reached`); now deterministic 210/210 | ✅ |

Live probes (all passed): register with smuggled `storeId`+`role:"PLATFORM_ADMIN"` → 201 with role `STORE_OWNER`, no store claim; `/admin/me` → storeId null; `/admin/stores/mine` → 0 stores; `/admin/orders` with demo-store header → **403**; without header → **403**.

## UI/UX upgrade — Modules U1–U8 (all ✅)
| # | Module | Status |
|---|--------|--------|
| U1 | Admin shell: grouped left sidebar (Sell/Manage/Store/System) + mobile drawer, user menu, no-reload store switch | ✅ (`7faa52a`) |
| U2 | Role-scoped nav — NAV_BY_ROLE from LIVE permission probes; tabs exactly match backend (staff/agent no more 403 dead-ends); roleCan write/voidRefund/profit gates | ✅ (`7faa52a`) |
| U3 | Overview KPI landing (today's sales, awaiting, out-for-delivery, low stock, utang + 7d chart) — default tab | ✅ (`7faa52a`) |
| U4 | Storefront search + category chips + sold-out states | ✅ (`a94cf02`) |
| U5 | 3-step checkout (Contact/Review/Pay), Delivery/Pickup toggle (Order.deliveryType; pickup = no fee/no address), Pay-on-credit for approved, Tracking-card success (auto-load + copy/share) | ✅ (`a94cf02`, E2E: pickup 12000/pickup, credit→utang 17000) |
| U6 | Customer account dashboard: GET /auth/customer/me (loyalty/credit/orders), My orders + track, saved-contact prefill; FIX: courier DELIVERED now awards loyalty (+170 pts verified) | ✅ (`54ddc3e`) |
| U7 | Courier app: logout, tel:/maps deep links, items summary, schedule sorting, Recent section (GET /delivery/recent) | ✅ (`44dc144`) |
| U8 | Consistency: toasts (POS/orders/expenses/purchases/settings/utang), confirm-before-delete, table-responsive, order-detail modal, demo-login quick-fill panel | ✅ (`c2e2483`) |

## Orders workflow — Modules W1–W3 (all ✅, 150 tests)
| # | Module | Status |
|---|--------|--------|
| W1 | Backend: PATCH /admin/orders/:id/items (stock-delta edit RECEIVED/CONFIRMED/ON_HOLD), POST send-for-delivery (one-tap → OUT_FOR_DELIVERY, delivery only), POST complete-now (pickup → COMPLETED; delivery 409) | ✅ (`d66d56e`, E2E) |
| W2 | Orders tabs: Pending=RECEIVED · On Process=CONFIRMED/PREPARING/READY/ON_HOLD · **For Delivery**=OUT_FOR_DELIVERY · Completed · Void; per-row delivery/pickup analysis + routing actions; Edit for pending | ✅ (`6cf2ab3`) |
| W3 | Full workflow E2E: pending→confirm→on process→for delivery, pickup→complete-now, stock-delta edit (all live) | ✅ (this commit) |

## Peddlr upgrade — Modules P1–P12 (all ✅, 148 tests)

| # | Module | Status | Tests + E2E |
|---|--------|--------|-------------|
| P1 | POS counter sales (cash/credit, COMPLETED status, Order.source, atomic stock) | ✅ | 126 + live E2E |
| P2 | Payments, receipts, voids & refunds (Payment table, printable receipt w/ VAT label) | ✅ | 131 + live E2E |
| P3 | Credit (utang) ledger (approve, limits, POS+online credit, settle, Utang panel) | ✅ | 136 + live E2E |
| P4 | Expenses (6 categories, CRUD, feeds reports) | ✅ | 143 + live E2E |
| P5 | Purchases & replenishment (adds stock, updates cost, low-stock one-tap) | ✅ | 143 + live E2E |
| P6 | Inventory upgrade (legacy warehouse-less stock migrated, filters + value at cost) | ✅ | 144 + live E2E |
| P7 | Product list upgrade (search/SKU/category/price/status filters + sort) | ✅ | 144 + live E2E |
| P8 | Store link upgrade (accent/banner/share/logo, QR + copy-link, storefront branding) | ✅ | 144 + live E2E |
| P9 | Customer list upgrade (search/filter, profile modal, CSV export) | ✅ | 144 + live E2E |
| P10 | Reports (profit summary w/ honest COGS, payment split, utang aging, CSV; decision #9 role gate) | ✅ | 146 + live E2E |
| P11 | POS settings (receipt header/footer, VAT toggle, default utang limit) | ✅ | 146 + live E2E |
| P12 | DELIVERY role (courier app, sees all OUT_FOR_DELIVERY, mark delivered/failed) | ✅ | 148 + live E2E |

Pipeline: `70bc211` (P1) → `b0d4f07` (P2+P3) → `9a741b5` (P4+P5) → `1fdfdfe` (P6) → `624b4b1` (P7) → `80e66b1` (P8) → `ee63e06` (P9) → `080ebce` (P10) → `6fe8617` (P11) → P12 (this commit). All modules verified with real typecheck / test / live-E2E output.

## Peddlr upgrade — notes from the build
- **Legacy stock migration (decision #8)**: warehouse-less StockLevel rows moved into each store's default warehouse; verified before (Sam's 4 rows/142, Store Two 1 row/10) and after (0 warehouse-less, totals preserved 253/10).
- **Decision #9 enforced server-side**: `/admin/reports/profit` → OWNER+MANAGER only (staff verified 403); `/admin/reports/sales` → all admins incl. staff/agents.
- **Decision #2**: VAT is display-only — toggleable label + header/footer text on receipts.
- **COGS honesty**: profit summary reports `cogsNote` when units sold have no purchase cost on record (counted at ₱0).
- Remaining skeleton sections below are historical (Modules 1–15 completed earlier).

## Module status

| # | Module | Status | Model used | Fallback fired? | Tests | Known defects | Next task |
|---|--------|--------|-----------|-----------------|-------|---------------|-----------|
| 0 | Setup: analysis, v2 prompt, AGENTS.md, progress.md | ✅ Done | deepseek-v4-flash-0731 | No | n/a | — | — |
| 1 | Thin slice | ✅ **DONE (gate passed live)** | deepseek-v4-flash-0731 | No | **59/59 + E2E** | none known | Next: Module 2 (auth/tenancy hardening) |
| 2.5 Admin dashboard UI | ✅ Done | deepseek-v4-flash-0731 | No | — | — | — |
| 3 Product mgmt (admin CRUD + stock, tenant) | ✅ Done | deepseek-v4-flash-0731 | No | **92/92 + E2E** | — | — |
| 4 Order status transitions (state machine + audit) | ✅ Done | deepseek-v4-flash-0731 | No | **92/92 + E2E** | — | — |
| 5 Store settings (pause, fees, min order, cutoff) | ✅ Done | deepseek-v4-flash-0731 | No | **92/92 + E2E** | — | — |
| 6 Messenger adapter (interface + suppressed provider + webhook verify, NO live calls) | ✅ Done | deepseek-v4-flash-0731 | No | **101/101** | — | Blocked on operator: Facebook App/Page tokens/HTTPS |
| 7 Deployment readiness (README, deploy guide, prod build) | ✅ Done | deepseek-v4-flash-0731 | No | **101/101** | — | Operator: Vercel/Render login |
| 8 Guest order claim/tracking (single-use link + storefront tracker) | ✅ Done | deepseek-v4-flash-0731 | No | **101/101 + E2E** | — | — |
| 9 Vouchers (admin CRUD, limit/min/expiry rules, apply at checkout) | ✅ Done | deepseek-v4-flash-0731 | No | **107/107 + E2E** | — | — |
| 10 Multi-store (platform admin, store creation, owner assignment, tenant via membership + X-Store-Id) | ✅ Done | deepseek-v4-flash-0731 | No | **111/111 + E2E (STORE2-000001)** | — | — |
| 11 Customer accounts + loyalty (earn on delivery, redeem at checkout, ledger) | ✅ Done | deepseek-v4-flash-0731 | No | **111/111 + E2E (200 pts, ₱2 off)** | — | — |
| 12 Analytics dashboard (KPIs, daily revenue, status funnel, top products, vouchers, low-stock) | ✅ Done | deepseek-v4-flash-0731 | No | **111/111 + live** | — | — |
| 13 Inventory hardening (7-day cart expiry, abandoned sweep, maintenance stats) | ✅ Done | deepseek-v4-flash-0731 | No | **113/113 + live** | — | — |
| 14 Notifications (templates, Messenger via adapter suppressed w/o PSID, SMS/email recorded, audit log) | ✅ Done | deepseek-v4-flash-0731 | No | **117/117 + live** | — | — |
| 15 Multi-warehouse (per-warehouse stock, transfer workflow request→approve→complete, role-gated) | ✅ Done | deepseek-v4-flash-0731 | No | **121/121 + E2E** | — | — |
| 16 Reports expansion (5 new views: stock-low, sold-stock, income-loss, sales-by-payment, customer-statement) | ✅ Done | deepseek-v4-flash-0731 | No | **7/7** | — | — |
| 17 Sectioned settings (6 tabs: general, pos, receipt, orders, taxes, invoices) | ✅ Done | deepseek-v4-flash-0731 | No | **typecheck+build+secrets** | — | — |

## Module 1 — thin slice COMPLETE ✅

**Full gate verified live 2026-09-01:** guest opens `localhost:3000/sam-store` → browses 3 seeded products (Kape Barako, Turon, Bibingka) → adds to cart (drawer, qty +/-, localStorage) → COD checkout via Next proxy → NestJS → Prisma → Supabase Postgres → **order `SAMSTO-000002`, ₱370.00, claim token returned**. HTTP 201. Retry-safe.

**Shipped this loop:**
- `apps/web` — Next.js 15 App Router + React 19 + **Bootstrap 5.3** (no Tailwind): `[slug]/page.tsx` (server), `Storefront`, `ProductCard`, `CartDrawer` (offcanvas), `CheckoutForm`; `/api/checkout` server-side proxy
- `apps/api` — `PublicStoreController` (`GET /public/stores/:slug` → store + active products w/ available qty)
- Migration `20260903005827_cart_item_cascade` (CartItem cascade delete)
- Seed resets demo cart (delete + recreate OPEN); `.gitignore` += `*.tsbuildinfo`

**Connections:** Supabase project `yeklfbggabxydnzfyorb` (region **ap-southeast-2**, session pooler :5432, IPv4 pinned via `hostaddr` — IPv6-only direct host was unreachable; transaction pooler :6543 can't run Prisma prepared statements).

**Pushed to GitHub:** `extraricestore/samstore` @ `823d641` (main tracks origin/main).

## Module status

## Module 1 — loop 2 completed (all verified, real output)

1. **NestJS HTTP layer** — `POST /public/checkout` wired via explicit `CHECKOUT_SERVICE` DI token (class-token DI fails under NodeNext/ESM; documented). Bootstrap via `tsx src/main.ts`.
2. **Checkout orchestration** (`src/checkout/checkout.service.ts`) — validation → idempotency-first → cart/OPEN → store ACTIVE/paused → re-price → totals → min-order → store-scoped sequence → order + snapshot → claim token → cart CONVERTED.
3. **Claim-token domain** — HMAC-signed single-use tokens; token now **persisted** so an idempotent retry after a lost response returns the SAME token (was: empty string — bug found by smoke test).
4. **Real HTTP statuses** — controller now throws `HttpException` (was: 201 for everything, status only in body — bug found by smoke test).
5. **In-memory repositories** behind interfaces — Prisma implementations swap in without service changes. `SEED_DEMO=true` seeds a demo store/product/cart for local smoke tests.
6. **Live HTTP smoke test** (real curl, port 4100): 201 + order PHP 290.00 + claim token → same-key retry returns SAME order + SAME token → converted-cart 409 → invalid input 422. ✅
7. Schema gained `Order.cartToken` (binds idempotent retries to the cart — prevents claim-token leak via key reuse).

Commits: `32dce58` (loop 2).

## Module 1 — completed this loop (all verified, real output)

1. **Monorepo** (npm workspaces): `apps/api` (NestJS — wiring next loop), `packages/contracts`, `prisma/`, `docs/`, root scripts. Commits: `3dffdb2`, `bf13c4c`.
2. **Prisma schema** — full thin-slice entity set; `store_id` on **every** store-owned table (tenancy day one). `npx prisma validate` ✅, `prisma generate` ✅. Includes roles scaffolding (`PlatformUser`, `StoreMembership`, `StoreCustomer`) per the 6-actor model.
3. **`@sam-store/contracts`** — shared DTOs, `PaymentMethod`, `OrderStatus` consts. Typecheck ✅.
4. **Domain core** (`apps/api/src/domain/`, pure functions, no DB):
   - `pricing.ts` — integer-minor-unit totals; rejects negative/fractional money, negative totals
   - `cart.ts` — revalidation (price changes applied + reported; inactive/vanished products dropped; empty cart rejected)
   - `idempotency.ts` — SHA-256 canonical checkout keys (retry-safe, no duplicate orders)
   - `tenant.ts` — `assertStoreAccess`; cross-tenant denial
   - `checkout-validation.ts` — server-side COD-only validation
   - `order-number.ts` — store-scoped human order numbers (SAMSTO-000001)
5. **41 unit tests** via `node --import tsx --test` — **41 pass, 0 fail** (one fix made: empty-cart invariant moved into domain).

## Known defects / notes

- `.env` exists with **placeholder** DATABASE_URL (gitignored) so `prisma validate/generate` can resolve — **do not run migrations against it**.
- npx 12 security gate: approved install scripts for `prisma`, `@prisma/client`, `@prisma/engines`, `esbuild` (official packages).
- Stray legacy landing page (`index.html`, `assets/`) untracked + gitignored, per module plan.
- Prisma CLI works; engine binaries downloaded after script approval.

## Blocked — needs operator input (blocking Module 1 completion)

| # | Item | Blocks |
|---|------|--------|
| B1 | **Managed Postgres connection string** (Neon/Supabase) | `prisma migrate dev`, integration tests, API runtime |
| B2 | **Managed Redis URL** (Upstash) | public-link rate limiting, sessions |
| B3 | **Region / currency / timezone / locale** | store settings defaults, money formatting, delivery rules |
| B4 | Payment gateway, object storage, domain/HTTPS | later modules only |

## Decisions locked (do not re-litigate)

- Managed cloud Postgres + Redis; no local Docker.
- Paid Primary: `deepseek/deepseek-v4-flash-0731` → `z-ai/glm-5.3-flash` → `z-ai/glm-5.2:free`.
- Messenger = adapter-only until operator supplies Facebook App + tokens + HTTPS webhook.
- Thin Slice first; Delivery Order 1–16 authoritative.
- Stack confirmed from source docs: **Next.js + NestJS + Prisma/Postgres + Redis + Bootstrap 5.3**.
- Money = integer minor units everywhere. Tenancy from first migration.

## Model / budget ledger

| When | Model | Tokens (in/out) | Cost | Note |
|------|-------|-----------------|------|------|
| 2026-09-01 earlier | deepseek-v4-flash-0731 | ~2M / ~0.2M (est.) | ~$0.25 (est.) | Setup/analysis |
| 2026-09-01 Module 1 loop 1 | deepseek-v4-flash-0731 | ~0.9M / ~0.1M (est.) | ~$0.08 (est.) | Scaffold + domain + tests |

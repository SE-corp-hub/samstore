# Platform Admin — User & Store Management, Visibility Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PLATFORM_ADMIN role's console honest (nothing visible that the role cannot actually do) and complete (create and manage users across stores), fixing the broken pieces found by the audit.

**Architecture:** Three API fixes/additions (a platform-only user-creation endpoint, a must-change-password fix on invites, a query-param fix on analytics) followed by a web rework of the User Access panel into a working platform-wide surface, a shared "no store selected" gate for store-scoped panels, and an end-to-end spec proving the platform surface.

**Tech Stack:** NestJS (apps/api), Next.js + Bootstrap 5.3 (apps/web), Prisma + managed Postgres, node:test, Playwright E2E.

**Spec:** The request "on admin platform, analyze everything, hide functions that the role can't use, improve the functionality of the platform admin, fix if not working; platform admin is to manage user and store; can also create users" plus the audit findings B1–B9 in `docs/progress.md` ("PLATFORM_ADMIN experience" analysis) and this session's evidence: team.service.ts:13-14, 37-39, 49-56; admin.controller.ts:319-343, 228-258; auth.service.ts:42, 291-296; UserAccessPanel.tsx:99-113, 216-233, 337-339; admin.controller.ts:1070; reports.controller.ts:83-85.

## Global Constraints

- Bootstrap 5.3 only; no new dependencies anywhere.
- Tenancy: every store-owned write carries `storeId`; a request never accepts a client-supplied storeId outside its legitimate body field.
- Role vocabulary: membership `UserStore.role` ∈ {OWNER, MANAGER, STAFF, SALES_AGENT, DELIVERY}; global `User.role` maps OWNER ⇄ `STORE_OWNER` (auth.service.ts:316-319 convention). Platform assignable set = `MANAGEABLE_STORE_ROLES`; store-owner invitable set = `INVITABLE_STORE_ROLES`.
- Temp passwords: generated `randomBytes(9).toString("base64url")`, returned exactly once, never logged, `mustChangePassword: true` on newly created users.
- Tests run sequentially against the shared pooler; E2E specs clean up their fixtures via `prisma` in `finally`.
- Lint baseline: 0 errors, 301 warnings. Do not raise the baseline.

## Review Focus

- A platform admin creates a user whose email already exists → the existing account is bound to the store, **no** new password, **no** temp password returned, must-change flag untouched. (Task 1 test)
- A platform admin assigns OWNER and later demotes the last active owner → refused by the existing last-owner guard; the UI surfaces the API's message. (Task 6, point 6)
- A storeless platform admin opens User Access → the store picker lists every store (`/admin/stores`), never an empty `/admin/stores/mine`. (Task 4, Step 1)
- A store owner (owner mode) never sees OWNER or PLATFORM_ADMIN in add/change-role lists — the API rejects those with 422. (Task 6, point 7)
- Any store-scoped panel with no store selected shows the "select a store" prompt, never a generic "Failed to load". (Task 5 test)

---

### Task 1: API — platform user creation endpoint `POST /admin/users`

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts` (add method near `changeRole`, ~line 280)
- Modify: `apps/api/src/admin/admin.controller.ts` (add route near the stores routes, ~line 343)
- Test: `apps/api/src/admin/platform-users.test.ts` (new, real Prisma — fixture pattern of `persistence/integrity.test.ts`)

**Interfaces:**
- Produces: `AuthService.createPlatformUser(input: { name?: string | null; email: string; phone?: string | null; storeId?: string | null; role: string }): Promise<AuthResult<{ userId: string; email: string; role: string; tempPassword?: string }>>`
- Produces: route `POST /admin/users` — gate `user.role !== "PLATFORM_ADMIN"` → 403 "Platform admin only"; returns **201** `{ userId, email, role, tempPassword? }`.

- [ ] **Step 1: Write the failing integration test** in `apps/api/src/admin/platform-users.test.ts` — a run-scoped fixture store (slug `PAU<ts>-store`), then:
  - create with a valid role + `storeId` → ok, user row has `mustChangePassword=true`, membership `ACTIVE` with the role, global `User.role` = `STORE_OWNER` for role OWNER else the role, and a `tempPassword` string is returned.
  - create with role `PLATFORM_ADMIN` → `validation` error.
  - create with an existing email → ok, **no** `tempPassword`, password hash unchanged, membership created.
  - create with a nonexistent `storeId` → `not_found`.
  - duplicate email → `conflict`.
  - cleanup in `finally` via `prisma` (membership, user, store; delete in that order).

- [ ] **Step 2: Run the test to verify it fails** — `node --import tsx --test apps/api/src/admin/platform-users.test.ts` → FAIL "createPlatformUser is not a function".

- [ ] **Step 3: Implement `createPlatformUser` in `apps/api/src/auth/auth.service.ts`**
  - Validate role ∈ `MANAGEABLE_STORE_ROLES` (auth.service.ts:42) → `validation` errors naming the allowed roles; email regex `EMAIL_RE`; phone via `toE164` when provided.
  - Duplicate checks by email then phone (same shape as `register`, auth.service.ts:85-92).
  - `storeId` optional; when present `prisma.store.findUnique` → `not_found`.
  - Existing user → skip password/must-change; new user → `randomBytes(9).toString("base64url")`, `bcrypt.hash(temp, 12)`, `mustChangePassword: true`, global role mapped via the OWNER→`STORE_OWNER` convention.
  - Membership `userStore.upsert` (create/update ACTIVE, role), mirroring team.service.ts:60-64.
  - `prisma.auditLog.create({ storeId: storeId ?? null, actorType: "platform_admin", action: "platform.user.create", entityType: "User", entityId: userId, after: { role } })`.
  - Return `{ userId, email, role, ...(tempPassword ? { tempPassword } : {}) }`.

- [ ] **Step 4: Run the test to verify it passes** — same command → PASS.

- [ ] **Step 5: Add the controller route in `apps/api/src/admin/admin.controller.ts`** — `@Post("users")`, `requireUser`, PLATFORM_ADMIN gate, body `{ name?, email, phone?, storeId?, role }`, `throw new HttpException(result.error, statusFor(result.error))` on failure, 201 on success (Nest `@HttpCode(HttpStatus.CREATED)`), and route-inventory update in `docs/openapi-route-inventory.yaml` (`/admin/users` post entry, same shape as `/admin/stores`).

- [ ] **Step 6: Verify** — rerun the integration test, then `npm run typecheck` and `npm run lint` (must stay at 301 warnings, 0 errors).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "Add a platform-only user creation endpoint"`.

---

### Task 2: API — invited users must change their password on first login (B8)

**Files:**
- Modify: `apps/api/src/admin/team.service.ts:49-56`
- Test: `apps/api/src/admin/platform-users.test.ts` (append)

**Interfaces:**
- Consumes: fixture pattern from Task 1.
- Produces: no interface change — behaviour change only.

- [ ] **Step 1: Write the failing test** — invite a brand-new email via `TeamService.invite` (construct the service directly) → assert the created `User` row has `mustChangePassword === true`.

- [ ] **Step 2: Run to verify it fails** — PASS→FAIL expected on the new assertion (row is `false` today).

- [ ] **Step 3: Implement** — in `team.service.ts` new-user branch (line ~49), add `mustChangePassword: true` to the `prisma.user.create` data.

- [ ] **Step 4: Run to verify it passes**, and rerun Task 1's suite (no regressions).

- [ ] **Step 5: Commit** — `git commit -m "Invited users must change their password on first login"`.

---

### Task 3: API — `analytics/daily` honours the `days` query (B6)

**Files:**
- Modify: `apps/api/src/admin/admin.controller.ts:1070`
- Test: E2E assertion in Task 6 (no separate unit test — the bug is parameter binding).

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /admin/analytics/daily?days=N` now controls the window (was `@Headers("days")`).

- [ ] **Step 1: Implement** — change `@Headers("days") days?: string` to `@Query("days") days?: string` on `analyticsDaily` (admin.controller.ts:1070). Keep the clamp `3..90`.

- [ ] **Step 2: Verify** — `npm run typecheck`; live probe with a platform token + `X-Store-Id`: `GET /admin/analytics/daily?days=7` returns ≤ 7 `days` entries. (Pooler latency may need one retry.)

- [ ] **Step 3: Commit** — `git commit -m "Honour the days query on analytics daily"`.

---

### Task 4: Web — User Access panel becomes a working platform-wide surface

**Files:**
- Modify: `apps/web/src/components/admin/UserAccessPanel.tsx` (store picker 99-107; role lists 216-233, 374-376; reset button 337-339; add-user flow 130-152; dead code 216-222)

**Interfaces:**
- Consumes: `POST /admin/users` (Task 1); existing `/admin/stores`, `/admin/stores/:id/users`, `/admin/stores/:id/users/:userId/{role,access,reset-password}`, `/admin/team*`.
- Produces: `PANEL_ADD_ROLES: string[]` and `PANEL_CHANGE_ROLES: string[]` — platform mode both `["OWNER","MANAGER","STAFF","SALES_AGENT","DELIVERY"]`; owner mode both `["MANAGER","STAFF","SALES_AGENT","DELIVERY"]`.
- Produces: platform add-user posts to `POST /admin/users` with `{ name, email, role, storeId }`; owner add-user keeps `POST /admin/team/invite`.

- [ ] **Step 1: Write the failing E2E** in `apps/api/e2e/17-platform-user-management.spec.ts` (setup in this task, full assertions in Task 6) — as `platform@samstore.test`, open **User Access**: the store picker lists `Sam's Store` (today it lists nothing).
  Run: `npx playwright test --config apps/api/playwright.config.ts 17-platform-user-management --workers=1 --reporter=line` → FAIL (picker empty).

- [ ] **Step 2: Fix the store picker (B1)** — `loadStores` (UserAccessPanel.tsx:99-107): when `isPlatform`, fetch `${API_URL}/admin/stores` and map `{ id, name, slug }`; else keep `/admin/stores/mine`. Guard `handleUnauthorized` like `AdminDashboard.loadStores`.

- [ ] **Step 3: Fix the role option lists (B2/B3)** — replace `ALL_ROLES` usages in the add-user modal (374-376) and the role-change select (224-233) with `PANEL_ADD_ROLES`/`PANEL_CHANGE_ROLES` per mode; delete the dead `roleOptions` block and the bogus self-guard (216-222); use `getAdminRole()`/`isPlatform` only.

- [ ] **Step 4: Gate the reset-password button (B4)** — render it only when `!isPlatform || m.role === "OWNER"` (mirrors StoresPanel.tsx:534-538 and admin.controller.ts:239-247).

- [ ] **Step 5: Route platform add-user through `POST /admin/users`** — in `addUser` (130-152): platform mode body `{ name, email, role, storeId }` → `POST /admin/users`; keep the existing temp-password-once display (`setLastTemp`).

- [ ] **Step 6: Verify** — rerun the E2E from Step 1 → PASS; `npm run typecheck`; `npm run lint` (baseline held).

- [ ] **Step 7: Commit** — `git commit -m "Make the User Access panel work for platform admins and hide unusable actions"`.

---

### Task 5: Web — "select a store" gate for store-scoped panels (B5) and the CSV window fix (B7)

**Files:**
- Create: `apps/web/src/components/admin/NoStoreScope.tsx`
- Modify: `apps/web/src/components/admin/AnalyticsPanel.tsx`, `SettingsPanel.tsx`, `MaintenancePanel.tsx`, `ReportsPanel.tsx`, `UserAccessPanel.tsx`
- Modify: `apps/web/src/components/admin/ReportsPanel.tsx` (CSV, line 84)

**Interfaces:**
- Produces: `export default function NoStoreScope(): JSX.Element` — a Bootstrap card, title "Select a store", body "This screen needs a store. Pick one from the switcher in the top bar." (same visual family as the OverviewPanel message).
- Consumes: `getAdminStoreId()` from `apps/web/src/lib/admin.ts` (already exported).

- [ ] **Step 1: Write the failing E2E assertion** (append to spec 17, Task 6 file): a storeless platform admin opens **Analytics** → sees "Select a store", not "Failed to load analytics". Run → FAIL (generic error today).

- [ ] **Step 2: Implement `NoStoreScope`** — Bootstrap 5.3 card, no icons beyond `bi-shop-window`, no new deps.

- [ ] **Step 3: Apply the gate** — in AnalyticsPanel, SettingsPanel, MaintenancePanel, ReportsPanel, UserAccessPanel: at the top of the component body (before any fetch effect), `const storeId = getAdminStoreId();` and early-return `<NoStoreScope />` when falsy. (Members always have a store auto-selected by the dashboard, so this only ever fires for a platform admin without a selection.)

- [ ] **Step 4: Fix the CSV window (B7)** — in ReportsPanel, replace `?days=N` with `from`/`to` ISO dates computed client-side (route reads `from`/`to`, reports.controller.ts:83-85).

- [ ] **Step 5: Verify** — rerun the E2E assertion from Step 1 → PASS; `npm run typecheck`; `npm run lint` (baseline held).

- [ ] **Step 6: Commit** — `git commit -m "Prompt platform admins to select a store instead of failing panels"`.

---

### Task 6: E2E — platform user management critical path, visibility spot-check, docs

**Files:**
- Create/complete: `apps/api/e2e/17-platform-user-management.spec.ts`
- Modify: `docs/progress.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5.

- [ ] **Step 1: Complete spec 17** — register/login flows:
  1. As `platform@samstore.test`: User Access lists `Sam's Store`; open it; **Add user** with a unique email and role `STAFF` (option list must not contain `PLATFORM_ADMIN`); the temp password is shown once; the new member appears; the **Reset password** button is absent on the STAFF row and present on the OWNER row.
  2. Role-change select on a STAFF row offers no `PLATFORM_ADMIN` option.
  3. A storeless platform admin on **Analytics** sees the "Select a store" prompt (Task 5).
  4. `GET /admin/analytics/daily?days=7` (API, with `X-Store-Id`) returns ≤ 7 days (Task 3).
  5. Spot-check "hide what a role can't use": login as `staff@samstore.test` → the sidebar shows POS but **no** Stores or User Access item.
  6. Last-owner protection surfaces: as the platform admin, try to change Sam's Store's OWNER row to STAFF → the API refuses and the UI shows the message (auth.service.ts:302-309).
  7. Owner mode role lists: login as `admin@samstore.test` (store owner), open User Access → the add-user and role-change lists contain only MANAGER/STAFF/SALES_AGENT/DELIVERY.
  - `finally` cleanup via `prisma`: delete the created user + its membership (pattern of spec 12).

- [ ] **Step 2: Run the full spec** — `npx playwright test --config apps/api/playwright.config.ts 17-platform-user-management --workers=1 --reporter=line` → PASS.

- [ ] **Step 3: Regression run** — `02-admin-login`, `14-platform-admin-store-switcher`, `16-storeless-owner-onboarding` with `--workers=1` → all pass.

- [ ] **Step 4: Gates** — `npm run typecheck`; `npm run lint` (301 warnings, 0 errors); secret scan 0 high; web production build (stop the 3000 dev server first, then restart it).

- [ ] **Step 5: Docs** — add the `docs/progress.md` entry: request, audit summary (B1-B9 with status), what changed per task, tests and gate output, operator notes (temp passwords shown once; platform admins can now create users; invite flow now forces first-login change).

- [ ] **Step 6: Commit** — `git commit -m "Cover the platform admin surface end to end"`.
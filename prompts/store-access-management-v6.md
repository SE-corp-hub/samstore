# SAM STORE — Upgrade v6: Store Access Management (platform admin)

**Goal (operator):** "Admin can manage store logins. Stores have their own data for transactions. Admin can reset passwords and restrict access of a store."

Bootstrap 5.3, mobile-first, `store_id` tenancy on every store-owned table, server-authoritative. One module at a time: plan → implement → gates → docs → checkpoint → CONTINUE.

---

## Module A — Store access control (restrict/restore)

> **Decided 2026-09-08:** Restriction = **BOTH** store-wide suspend (blocks login + ordering + storefront) AND per-user deactivate. Effective immediately on all enforcement points.

**A1 Store status API.** `PATCH /admin/stores/:id/status {status: ACTIVE | SUSPENDED | ARCHIVED | CLOSED, reason?}` — **PLATFORM_ADMIN only** (requireAdmin + role check). Writes an `StoreStatusHistory` audit row (who/when/reason). The schema already carries `StoreStatus` on `Store` — wire it to this endpoint.

**A2 Restriction effects (enforced, not cosmetic):**
- **Login:** `POST /auth/login` → 403 `Store is suspended` when the user's ACTIVE membership store is SUSPENDED/ARCHIVED/CLOSED (check the store status of each membership; block when NO accessible store). Existing token: `GET /admin/me` + every admin route's tenant guard also refuses users whose only stores are restricted.
- **Storefront:** `GET /public/stores/:slug` returns a `status` + `pausedMessage` (from settings/closedStoreMessage) when not ACTIVE → storefront shows a suspended banner and **blocks new checkout** (POST /public/checkout → 409 `Store is not accepting orders`).
- **Admin UI (StoresPanel):** per-store badge (ACTIVE=green / SUSPENDED=red / ARCHIVED=dark / CLOSED=secondary), per-store **Suspend / Reinstate / Close** action (PLATFORM_ADMIN only, confirm modal with reason), display of `StoreStatusHistory` (last status, who, when, reason).

**A3 Per-user restriction.** `PATCH /admin/stores/:id/users/:userId/access {status: ACTIVE | DEACTIVATED}` — platform admin AND that store's OWNER. Deactivated = cannot log in to that store, all admin routes for that store 403 (the UserStore membership guard already checks `status === "ACTIVE"` for tenant resolution — extend login to enforce it too).

## Module B — Manage store logins (platform admin)

**B1 Members directory.** `GET /admin/stores/:id/users` (PLATFORM_ADMIN) → members of a store: email, name, role (UserStore.role), status, joined, last login (User.lastLoginAt if present). StoresPanel gains a **"Members"** modal per store.

**B2 Add member / change role.** Reuse the existing invite flow (StoreMembership email invite) + allow PLATFORM_ADMIN to set `UserStore.role` directly (`PATCH /admin/stores/:id/users/:userId/role`). Role options: OWNER, MANAGER, STAFF, SALES_AGENT, DELIVERY. Guard: cannot demote/remove the last ACTIVE OWNER; cannot change own membership (self-lockout protection).

**B3 Reset password.** `POST /admin/stores/:id/users/:userId/reset-password {newPassword?}` → generates a strong temp password (or honors a provided one ≥ 10 chars), updates bcrypt hash, records a `PasswordResetHistory` audit row (who/when/which user), returns the temp password **once** (response-only, never logged). UI: "Reset password" button per member → confirm modal → shows the temp password to copy → marks it **must change on next login** (new `mustChangePassword` flag on User; login returns a 428-style response when set; next login with the temp password requires setting a new one before proceeding).

> **Decided 2026-09-08:** Reset = temp password shown once AND forced change on next login. Managers: platform admin → any store's members; store OWNER → only their own store's members.

## Module C — Store data isolation (transactions & data)

**C1 Confirm + surface the tenancy boundary (NOT a new DB).** Every store-owned table carries `store_id` and every query is tenant-scoped; cross-store access is already rejected by guards + covered by existing cross-tenant tests (store A can never read store B — proven in earlier modules).

> **Decided 2026-09-08:** Keep the **store_id tenancy model** (single managed Postgres) — no literal per-store database. Document it in the Stores panel as **"Isolated data: each store can only ever see its own orders, inventory, customers, credit, expenses, purchases, products, vouchers, team"** with a live "cross-store probe" indicator (calls store B endpoints with store A's token → expects 403/404). **Per-store data summary card** in StoresPanel: order count, sales total (₱), inventory value, customer count, members count, last activity date (read-only, PLATFORM_ADMIN).

## Security & audit (non-negotiable)

- PLATFORM_ADMIN-only for cross-store management; store OWNER only within their store (A3/B2/B3 scoped).
- Every status change / access change / password reset is audited (history rows) — who, whom, when, why.
- No passwords in logs; temp passwords returned once; must-change-on-next-login enforced.
- Cross-tenant: new routes take `:storeId` + verify requester platform role; store-scoped routes keep the existing membership guard.
- No enumeration: unknown store/user returns 404 (same message), deactivated user gets generic "invalid credentials" at login.

## Tests & gates

- Unit (mirror repo style): store-status guard (non-platform → 403), suspend blocks login + checkout + tenant resolution, deactivated user login blocked / routes 403, role-change last-owner guard + self-lockout, reset-password must-change flow + not-logged, cross-store probe 403.
- Live E2E (real output): platform suspends "TX F" → owner login 403 + storefront shows suspended + checkout 409 → reinstate → login works; reset password → temp login → must-change → new password active; cross-store probe output pasted.
- Gate: `npm test`, `npm run typecheck` (all 3), `next build`, live dashboard 200.

## Out of scope

Literal per-store databases / sharding; billing/quotas; SSO; audit UI beyond the history rows shown in StoresPanel/Team panel.
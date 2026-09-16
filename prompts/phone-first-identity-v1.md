# Phone-first identity + admin-approved onboarding — v1 plan (2026-09-14)

> Execution plan for the operator-adjusted auth/onboarding flow. Written to the same format as
> `prompts/manage-and-token-plan-v1.md`: locked decisions → grounded current state → module plan with
> file anchors → acceptance tests → risks → TODO checklist.
> **Nothing has been implemented yet. Implementation starts on the operator's `continue`.**

## 1. Locked decisions (operator, 2026-09-14)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Phone is the main ID; email is optional.** | `User.phone` becomes the identity key (E.164, unique); `User.email` becomes optional. |
| D2 | **Login accepts phone OR email.** | One identifier field; existing accounts (demo logins, Store Two owner) keep working untouched. |
| D3 | **Registration records the role the applicant WANTS.** | Stored as an intent on an onboarding request. **No privilege is granted at registration** — the platform admin grants it on approval. Preserves the Module-1 hardening (a client-supplied role/storeId stays a 422). |
| D4 | **One phone = one account (unique).** Each staff member has their own number; no shared-phone logins, no username/PIN sub-accounts. | `(storeId, phone)` is the membership key. A shared shop phone is NOT a supported login identity. |
| D5 | **No OTP at registration.** The account is created with `phoneVerified = false`; verification is **required before a store is bound**. | The platform admin is the human gate at approval time; the OTP mechanism (A3) is reused as a "verify this number" button there. |
| D6 | **Resets keep the tiers AND gain self-service.** Platform admin → store owners (unchanged). Store owner → their own team (unchanged, temp password + forced change). **New:** OTP to the registered phone → set a new password, no admin involved. | Removes the platform-admin bottleneck for everyone, including staff. |
| D7 | **Reverting is a single flag:** `identityRequirePhone` (store-independent, app-level). Off ⇒ the app behaves exactly as today (email-only identity, registration creates a bare account). | Built into A1 from the first commit. |

**Residual security changes implied:** D3 keeps registration privilege-free ✓; D6 relaxes nothing that
was locked (the tiers survive) and **adds** a channel; D5 is what makes D4's squatting risk real — see §5.

## 2. Grounded current state (read from source, not assumed)

| Fact | Anchor |
|---|---|
| `User` has `email String @unique` (required) and **no phone column at all** | `prisma/schema.prisma:104-118` (`email` :106) |
| `mustChangePassword` exists **and is enforced at login** — login returns 403 + the flag and issues **no token** until a new password is set | `prisma/schema.prisma:110`, `apps/api/src/auth/auth.service.ts:95-105` |
| `POST /auth/change-password` is deliberately public for exactly that flow (the must-change user has no token yet) | `apps/api/src/auth/auth.controller.ts:63-70` |
| Registration rejects unknown keys, so a client-supplied `storeId`/`role` is a **422**, not silently ignored | `apps/api/src/auth/auth.controller.ts:36-49` |
| Registration forces `role = "STORE_OWNER"` and binds **no store** | `apps/api/src/auth/auth.service.ts:55-58` |
| Login is email-only: `findByEmail(email)` → "Invalid email or password" | `apps/api/src/auth/auth.service.ts:81-90` |
| `StoreMembership` requires `email` + `displayName`, unique on `(storeId, email)` | `prisma/schema.prisma:855-869` (`email` :860, unique :868) |
| Team invite: existing email → link membership; unknown email → create user + **temp password returned once** | `apps/api/src/admin/team.service.ts:32-70` |
| Invitable roles exclude OWNER | `apps/api/src/admin/team.service.ts:13` |
| Team invite is OWNER/PLATFORM_ADMIN only (`TENANT_ROLES.MANAGE`) | `apps/api/src/admin/admin.controller.ts:1043-1053` |
| Store creation requires `ownerEmail` to **already exist as a user**; store is created `ACTIVE` with settings + public link | `apps/api/src/admin/store-admin.service.ts:41-71` (lookup :52-53) |
| Platform admin may reset **only a store OWNER's** password; the owner resets their own team | `apps/api/src/admin/admin.controller.ts:224-245`, `1074-1100` |
| Every reset writes a `PasswordResetHistory` audit row | `prisma/schema.prisma:844-853` |
| Store lifecycle: suspend / reinstate / archive / close with a reason, audited | `apps/api/src/admin/store-admin.service.ts:73+`, `admin.controller.ts:106` |
| Store user administration (list / add / role / reset / access overrides) | `apps/api/src/admin/admin.controller.ts:160-315` |
| **No OTP/SMS/verification infrastructure exists anywhere** (no provider, no code table, no mailer) | `grep -rln 'otp\|verifyCode' apps/api/src` → nothing |
| Customer side is phone-*ish* but inconsistent: register requires email; `Customer` is uniquely keyed `(email, phone)` (composite ⇒ the same phone repeats across rows) | `apps/api/src/auth/customer-auth.service.ts:19`, `prisma/schema.prisma:774-787` |
| Web surfaces to change: register page (73 lines), login page, Stores panel, Team panel, User Access panel | `apps/web/src/app/admin/register/AdminRegister.tsx`, `apps/web/src/components/admin/{StoresPanel,UserAccessPanel}.tsx` |
| Role vocabulary mismatch to fix while here: `roleCan()`/`TABS_BY_ROLE` use `STORE_OWNER` while the dashboard's `role` comes from the **store** role (`OWNER`) | `apps/web/src/lib/admin.ts:141-160` |

## 3. Module plan

### A1 — Identity: phone-primary, email optional, login by either

**Touch:** `prisma/schema.prisma` (`User`: `phone String? @unique`, `email String?`, `phoneVerified Boolean @default(false)`, `phoneVerifiedAt DateTime?`), a migration, `apps/api/src/domain/phone.ts` (new: `toE164`, `isPhMobile`, `formatPh`), `auth.repository.ts` (add `findByPhone`, keep `findByEmail`), `auth.service.ts` (`register` accepts phone + optional email; `login` resolves an identifier), `auth.controller.ts` + `security/validate.ts` (`REGISTER_DTO`, `LOGIN_DTO`), `apps/web` register/login forms.

**Rules**
- `toE164` accepts `09xxxxxxxxx`, `9xxxxxxxxx`, `639xxxxxxxxx`, `+639xxxxxxxxx`, spaced/dashed forms → `+639xxxxxxxxx`; anything else is a 422 with a human message. Applied at **every** entry point that takes a phone.
- Login body becomes `{ identifier, password }` (transitional: keep accepting `{email}` so nothing breaks mid-deploy).
- Login error text: "Invalid phone/email or password" — never reveal whether an identifier exists.
- `email` stays unique-when-present (Postgres allows many NULLs in a unique index ⇒ no extra work).
- **D7 kill switch:** with `identityRequirePhone=false` the register DTO still requires email and the account works exactly as today.

**Acceptance tests** (real files, run in `npm test`)
1. `phone.test.ts` — the 5 accepted spellings of one number normalize to `+63…`; a landline and garbage are rejected.
2. `auth.service.test.ts` — register with phone only (no email) succeeds; login with that phone succeeds; login with its email also succeeds; two accounts on one normalized phone → conflict.
3. Register payload carrying `role`/`storeId` → **422** (the Module-1 invariant still holds).
4. A legacy email-only account still logs in with email (regression).
5. Migration applies cleanly and the demo logins keep working (phone backfilled, `phoneVerified=false`).

**Rollback:** drop the module's migration; flip `identityRequirePhone` off; the register/login DTOs still accept email.

### A2 — Onboarding request + platform-admin approval (the real "approval")

**Touch:** new `OnboardingRequest` model (`phone` normalized, `name`, `wantedRole`, `storeName?`, `storeSlug?`, `status: PENDING|APPROVED|REJECTED|EXPIRED`, `phoneVerified`, `reviewedBy`, `reviewedAt`, `reason?`, `expiresAt`, `@@unique([phone])` for open requests), `apps/api/src/admin/onboarding.service.ts` (new), routes in `admin.controller.ts` (`GET /admin/onboarding/requests`, `POST /admin/onboarding/:id/approve`, `POST …/reject`, `POST …/verify-phone`), `store-admin.service.create` gains `ownerPhone`, `apps/web/src/components/admin/OnboardingQueue.tsx` (new) wired into the Stores panel + a sidebar badge.

**Rules**
- Approval is **one action**: verify the phone (if needed) → create the store (when the request asks for a new one) or add the person to an existing store → grant `wantedRole` → write `UserStore` (+ `StoreMembership`) → request `APPROVED`, audited.
- **The public API can never self-approve**: nothing in `/auth/*` touches `UserStore` (the Module-1 invariant, re-asserted by a test).
- `POST /admin/stores` keeps working for the admin-created path, but now accepts `ownerPhone` (email stays accepted for legacy).
- **Phone release / reassign (required, not optional):** `POST /admin/onboarding/release-phone` (platform admin, audited) marks a squatter's account unusable (`status`/`phoneReleasedAt`) and frees the number; without this, a squatted phone deadlocks the real owner — see §5.
- **Expiry:** a `PENDING` request with `phoneVerified=false` expires after **7 days**; a scheduled sweep (same pattern as the outbox worker) marks it `EXPIRED` and releases the phone. The sweep is idempotent and never touches an `APPROVED` request.

**Acceptance tests**
1. Register → request appears `PENDING` in the admin queue; the account can log in but sees **zero** stores/tabs.
2. Approve → the store exists, the owner is bound `OWNER`, the requested role is granted, request `APPROVED` + audit row.
3. Approve for an **existing** store → membership created at the requested role, no new store.
4. Squatting scenario: a second registration on the same number is rejected (D4) → admin **releases** the phone → the real owner registers and is approved.
5. Expiry: a 7-day-old unverified request flips `EXPIRED` and releases the phone; an approved one never expires.
6. Cross-tenant: store B's owner cannot see or approve store A's request.

**Rollback:** keep the queue read-only (approve/reject routes off); the legacy admin-created path (`POST /admin/stores`) is untouched throughout.

### A3 — OTP: verification + self-service reset

**Touch:** new `OtpChallenge` model (`phone`, `purpose: VERIFY|RESET`, `codeHash` (never plaintext), `expiresAt`, `consumedAt`, `attempts`, `createdBy`, `@@index([phone, purpose])`), `apps/api/src/auth/otp.service.ts` + `apps/api/src/notifications/sms.provider.ts` (**interface + mock**, per AGENTS.md: no live provider calls until a sender is operator-approved), routes (`POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/password-reset/otp-request`, `POST /auth/password-reset/otp-complete`), `register.ts`/`login.tsx` UI.

**Rules**
- 6 digits, **hashed at rest**, single use, **5-minute TTL**, max **5 sends/hour/phone** and max **5 verify attempts** per challenge (then the challenge is burned).
- Reset flow: OTP → new password → **all existing JWTs for that user are invalidated** (token version bump) → `PasswordResetHistory` row with `resetBy = "SELF_OTP"`.
- SMS provider behind an interface; the mock logs instead of sending. **No live SMS until the operator approves a provider + credentials** (AGENTS.md rule, same as the Messenger adapter).
- Enumeration safety: `otp/request` always answers 200 with the same body, whether or not the phone exists.

**Acceptance tests**
1. Request → code (from the mock) → verify → password changed → old password rejected, new one works.
2. Wrong code 5× → challenge burned; request again works.
3. Expired code → rejected.
4. Code reuse → rejected (single use).
5. Rate limit: the 6th request within an hour is a 429.
6. `POST /auth/otp/request` for an unknown phone returns 200 and creates no challenge.
7. The platform-admin and owner reset tiers still work (regression) and still set `mustChangePassword`.

**Rollback:** disable the OTP routes; the tiered resets are unaffected.

### A4 — UI pass

**Touch:** `AdminRegister.tsx` (phone-first, optional email, role-intent picker, consent text), login page (identifier field labelled "Phone or email"), `TeamPanel` (invite by phone; display normalized phone), `StoresPanel` + new `OnboardingQueue` (badge, verify-phone button, approve/reject with reason, release-phone), `UserAccessPanel` (phone column), `lib/admin.ts` (fix the `STORE_OWNER` vs `OWNER` vocabulary — `roleCan()` currently never matches a store owner).

**Acceptance:** the register → approve → login → staff-invite → reset journey works in the browser at 320px and desktop; every new control has a label + keyboard path; E2E spec 10 covers register → approve → login; the existing suite stays green.

## 4. Sequence, gates and token economy

Order: **A1 → A2 → A3 → A4**, one commit per module, push to `origin/main`, `docs/progress.md` updated in the same commit (row + cost record).

Per module: plan → schema/migration (`prisma validate` + hand-edit, never `prisma format`) → server → tests (real files, real output) → web + rebuild → targeted E2E → **full unit gate** (API stopped for it, chained restart) → docs → commit → report. Stop and report on any real defect instead of routing around it.

Reuse instead of rebuild: the OTP sender sits behind an interface with a **mock**, mirroring the Messenger adapter rule; the expiry sweep mirrors the outbox worker; the audit trail reuses `PasswordResetHistory` (+ a new `OnboardingRequest` history if the reason field proves too thin).

## 5. Risks (ranked)

| # | Risk | Why it matters | Mitigation |
|---|---|---|---|
| R‑A1 | **Phone squatting deadlocks the real owner** — `phone` is unique and unverified, and store binding needs an existing user | D4 + D5 interact: an early squatter blocks a legitimate owner completely | Admin **release/reassign phone** action + **7-day expiry** releasing unverified numbers (§3 A2) |
| R‑A2 | **Identity migration touches every entry point** — one missed `toE164` call creates duplicate humans and constraint wars | Unique-constraint bugs surface as 500s (`P2002`) on public endpoints | Single `toE164` helper + a test per entry point (register, invite, admin create, customer); P2002 → clean conflict | 
| R‑A3 | **No SMS provider is approved yet** | A3 cannot send real codes; D6 stays theoretical | Mock provider first (fully testable), provider + credentials = operator decision before go-live |
| R‑A4 | **Deferring store binding to a human gate** | Approvals depend on the admin noticing the queue (email is optional, so no email notification) | Sidebar badge + optional Messenger notification; keep `POST /admin/stores` as the escape hatch |
| R‑A5 | **PH DPA** — a phone number is personal data | Consent + retention must exist before collecting at scale | Consent text on the register form; document retention for expired/released numbers |
| R‑A6 | **Legacy accounts have no phone** | Login-by-email must keep working or you lock out the demo/test users | `email` stays a valid login identifier (D2) + backfill on the demo logins |
| R‑A7 | **Customer identity stays inconsistent** | Storefront register requires email while checkout collects phone; `Customer` uniqueness is composite | Out of scope for A1–A4; flagged as its own follow-up (`(storeId, phone)` key) |

## 6. TODO checklist

```
[x] A1  Identity: User.phone (E.164 unique) + email optional + login by identifier + phone.ts + tests
[ ] A2  OnboardingRequest + admin queue/approval + verify-phone + release/reassign + expiry sweep + tests
[ ] A3  OtpChallenge + SMS provider interface/mock + self-service reset + rate limits + tests
[ ] A4  UI: register (phone-first, role intent, consent), login identifier, Team invite by phone, approval queue, role-vocabulary fix
[ ] E2E spec 10: register → approve → login → invite staff → OTP reset
[ ] docs: progress row + cost record per module; runbook section for onboarding/reset ops
```

## 7. Open items (defaults applied unless the operator says otherwise)

1. Store name/slug captured **in the registration request** — default **yes** (approval then creates the store in one action).
2. Unverified-request expiry window — default **7 days**.
3. OTP parameters — default **6 digits / 5-minute TTL / single use / 5 sends per hour**.
4. One person across several stores (owner here, staff there) — default **allowed** (existing `UserStore` many-to-many).
5. Demo logins get placeholder PH-format phones in the migration; they remain email-loginable.
6. Consent text wording — default: "By registering you agree that SAM STORE stores your mobile number to identify your account and to send verification/reset codes."




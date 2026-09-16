# SAM STORE — multi-tenant Messenger commerce platform

Production-ready ordering + store management platform for a store owner running guest
(Cash-on-Delivery) online ordering from a public storefront link, with an admin dashboard
for products, orders, and store settings. Multi-tenancy is built in from day one.

**Stack:** Next.js 15 (App Router) + React 19 + **Bootstrap 5.3** · NestJS API · Prisma ORM ·
Supabase Postgres (managed) · JWT auth (bcrypt) · integer-minor-unit money throughout.

## Status

| Module | Status |
|---|---|
| 1 Thin slice (storefront, catalog, guest cart, COD checkout) | ✅ done, live-verified |
| 2 Admin auth + roles (register/login, JWT, tenant guard) | ✅ done |
| 3 Product management (admin CRUD + stock, tenant-scoped) | ✅ done |
| 4 Order status transitions (state machine + reason audit + history) | ✅ done |
| 5 Store settings (pause ordering, delivery fee, min order, cutoff, closed message) | ✅ done |
| 6 Messenger adapter (provider interface, suppressed/mock providers, webhook signature verify — **NO live Meta calls**) | ✅ done |
| 7 Deployment readiness | ✅ docs + prod build verified |

**Not yet built (requires operator decisions / credentials):** live Messenger connection (Facebook
App + Page + app review + HTTPS webhook), payment gateway (region/currency decision), loyalty/vouchers,
multi-warehouse inventory, analytics, AI assistant, deployment of the public site.

## Quick start (local)

```bash
# 1. install
npm install

# 2. configure .env (see .env.example)
cp .env.example .env   # fill DATABASE_URL (Supabase), REDIS_URL, CLAIM_SIGNING_SECRET, JWT_SECRET

# 3. database
npx prisma migrate deploy
npx tsx prisma/seed.ts   # demo store + products + cart

# 4. run (two terminals)
cd apps/api && PORT=4100 npx tsx src/main.ts
cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:4100 npx next dev -p 3000
```

Open:
- **Storefront:** http://localhost:3000/sam-store (public ordering link)
- **Admin:** http://localhost:3000/admin/login then /admin/dashboard

Demo admin (after `seed.ts` + a `POST /auth/register`): register any account and log in.

## Tests

```bash
node --import tsx --test apps/api/src/domain/*.test.ts apps/api/src/checkout/*.test.ts \
  apps/api/src/cart/*.test.ts apps/api/src/auth/*.test.ts apps/api/src/messenger/*.test.ts
```

**101 unit tests** covering: pricing (integer minor units, rejects negative/fractional money),
cart revalidation (price changes applied + reported, inactive products dropped, empty-cart guard),
idempotency (same key → same order; key reused with different cart → conflict), tenant guard
(cross-store denial), checkout validation (COD-only), order-number formatting, claim-token HMAC,
cart service (store binding, stock limits, cross-store add rejection), auth (register/login/JWT),
order state machine (forward-only transitions, reason required for cancellations), product
validation, and Messenger webhook signature verification + suppressed/mock providers.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /auth/register | — | create account (JWT) |
| POST | /auth/login | — | login (JWT) |
| POST | /public/checkout | — | COD checkout from an open cart |
| POST | /public/carts | — | new guest cart (server token) |
| GET/POST/PATCH/DELETE | /public/carts/:token[/items] | — | cart operations (stock + cross-store guarded) |
| GET | /public/stores/:slug | — | storefront (store + active products) |
| GET | /admin/orders | Bearer | list orders (tenant-scoped) |
| PATCH | /admin/orders/:id/status | Bearer | transition order status |
| GET/POST/PATCH/DELETE | /admin/products | Bearer | product management |
| GET/PATCH | /admin/settings | Bearer | store settings |
| GET | /admin/me | Bearer | current user |

## Architecture

```
apps/
  web/    Next.js storefront ([slug]) + admin (/admin/*) + /api/checkout proxy
  api/    NestJS: public store/cart/checkout, auth, admin (JWT-guarded, tenant-scoped)
packages/
  contracts/  shared DTOs & constants
prisma/       schema + migrations + seed
```

- **Tenancy:** every store-owned table carries `storeId` from the first migration; API resolves the
  tenant from the JWT (`UserStore` membership) and filters every query.
- **Money:** integer minor units everywhere (never floats); server recomputes totals; client
  totals are rejected; prices revalidated against the live catalog before order creation.
- **Orders:** immutable line-item snapshot, store-scoped human order numbers, single-use HMAC
  claim tokens, idempotency-key dedupe.
- **Messenger:** behind an interface with a *suppressed* provider (store not connected) and a
  *mock* provider; webhook signature verification implemented; **zero live Meta calls** until the
  operator supplies a Facebook App, Page tokens, and a public HTTPS endpoint.

## Deployment

See `docs/deployment.md` for the Vercel + Supabase walkthrough (operator steps: Vercel login,
Supabase env vars, one-time migrations).

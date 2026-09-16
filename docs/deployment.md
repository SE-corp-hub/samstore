# Deployment — Vercel (web) + Render/Railway (API) + Supabase (DB)

Operator steps (each needs a real account login — cannot be done from the agent sandbox).

## 0. Environment variables (needed by both platforms)

| Var | Where | Notes |
|---|---|---|
| `DATABASE_URL` | API host | Supabase **session** pooler :5432 (Prisma needs non-transactional pooler), `?sslmode=require`. Host pin via `hostaddr` if IPv6 issues. |
| `JWT_SECRET` | API host | 32+ random chars |
| `CLAIM_SIGNING_SECRET` | API host | 32+ random chars |
| `NEXT_PUBLIC_API_URL` | Vercel | https://<api-host> (no trailing slash) |

## 1. Database migrations (one-time)

In the repo (after setting `.env`):

```bash
npx prisma migrate deploy   # applies all migrations in prisma/migrations
npx tsx prisma/seed.ts      # demo store + products + cart (optional)
```

## 2. API deployment (Render or Railway — any Node host)

Build command: `npm install && npx prisma generate`
Start command: `node --import tsx apps/api/src/main.ts` (or `npm run start:api`)
Add the three env vars from §0. Port: use the platform-provided `PORT`.

## 3. Web deployment (Vercel)

- Import the GitHub repo `extraricestore/samstore`.
- Framework: Next.js (auto-detected).
- Root directory: `apps/web`.
- Env var: `NEXT_PUBLIC_API_URL` = the deployed API URL.
- Deploy. `https://<project>.vercel.app/sam-store` is the public storefront link.

Note: the Next `[slug]` route makes any slug a storefront — in production, point your real domain
at Vercel and share `https://yourdomain.com/sam-store` as the canonical public ordering link.

## 4. Messenger webhook (when operator provides Facebook App)

1. Create the Facebook App (Meta for Developers), add Messenger product.
2. Add `pages_messaging` permission; complete App Review for production.
3. Set the webhook to `https://<api-host>/messenger/webhook` with a verify token from env;
   the GET challenge + `X-Hub-Signature-256` verification are already implemented in
   `apps/api/src/messenger/webhook-verification.ts` (currently used only via tests — the HTTP
   route is added behind the real provider once credentials exist).
4. Until then the bridge **suppresses sends** by design.

## 5. Post-deploy checks

- `GET /public/stores/sam-store` returns 200 + products.
- Order flow: open storefront → add to cart → checkout → order number.
- Admin: register/login → orders, products, settings tabs work.
- `npx prisma migrate status` reports "up to date".
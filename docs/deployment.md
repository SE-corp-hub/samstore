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
ALLOW_DEMO_SEED=true npx tsx prisma/seed.ts   # demo data — throwaway dev DB only, never production
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

## 6. API contract and operators

- OpenAPI contract: `docs/openapi.yaml`. Keep it updated when adding endpoints; the
  contract intentionally marks payment, courier, Messenger, e-invoice, and NPC
  integrations as mock/PENDING_CREDENTIALS until operator approval.
- Phase 4 payment env vars: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`.
  Without them, payment links remain sandbox/PENDING_CREDENTIALS and no live card
  traffic is attempted.
- Phase 5 courier env vars: `LALAMOVE_API_KEY`, `GRABEXPRESS_API_KEY`, `JT_API_KEY`.
  Without them, booking adapters return clearly-labelled sandbox tracking values.
- Phase 9 BIR env var: `BIR_CSF_CREDENTIALS`. Without it, e-invoice submission
  returns `PENDING_CREDENTIALS` rather than a fake success.
- Phase 10: review `docs/security-checklist.md` before production. Configure Redis
  for shared rate limits and resolve the pre-existing Prisma migration checksum
  drift before using `migrate dev/reset`.

## 7. Container topology (operator-only)

`docker-compose.yml` defines `nginx`, `web`, `api`, and a separate `worker` for the transactional outbox. The API disables its embedded worker in this topology via `OUTBOX_WORKER_EMBEDDED=false`.

- The Compose file intentionally has **no local Postgres or Redis service**. Set managed `DATABASE_URL` and optional `REDIS_URL` through the operator's secret manager.
- Build files: `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker/worker.Dockerfile`; reverse proxy: `docker/nginx.conf`.
- Do not run this topology against production until migrations, backups, TLS termination, health checks, and secret injection are operator-reviewed.
- Run `npm run audit:openapi` before releases to see controller routes that still need detailed OpenAPI path/schema documentation. The command is an audit report, not a fabricated pass.
- Run `npm run generate:openapi-inventory` to refresh `docs/openapi-route-inventory.yaml`; this generated artifact contains every discovered controller route with generic responses, while `docs/openapi.yaml` remains the hand-authored high-risk contract.
- Run `npm run check:deployment` in CI to validate required Docker/nginx/Compose artifacts without starting containers. Operator validation still requires managed infrastructure, TLS, backups, and secret-manager review.

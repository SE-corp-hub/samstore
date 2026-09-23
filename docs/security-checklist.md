# PINDIAN Security & DPA Checklist

Updated: 2026-09-20

## Implemented

- [x] Tenant authorization through `resolveTenant` on admin/store-owned endpoints.
- [x] Public store links require both slug and high-entropy token.
- [x] Claim tokens are signed, single-use, persisted, and expiry-aware.
- [x] DPA consent is required at online checkout and customer consent records are append-only.
- [x] Consent records are retained during P10 privacy purges.
- [x] Privacy retention is configurable per store; purge is explicit, audited, and Messenger-data-only.
- [x] Raw card data is never accepted or stored; payment gateways are hosted/tokenized adapters.
- [x] Payment proof upload validates PNG/JPEG data URLs and enforces a 2 MB decoded limit.
- [x] Webhook signatures use constant-time comparisons where provider secrets exist.
- [x] Public/auth/cart/checkout requests have Redis-backed rate limits with in-process fallback.
- [x] Request IDs and structured logs redact query strings, preventing public-link tokens from entering logs.
- [x] Basic response security headers are installed (`nosniff`, `SAMEORIGIN`, `no-referrer`).
- [x] New store-owned tables carry `storeId` and cross-tenant tests exist for new modules.
- [x] Messenger and courier live calls remain suppressed/mock until operator approval and credentials.

## Pending Operator / Deployment Work

- [ ] Set strong production `JWT_SECRET` and `CLAIM_SIGNING_SECRET`.
- [ ] Resolve the pre-existing Prisma migration checksum drift before using `migrate dev/reset`.
- [ ] Configure Redis in production; verify rate-limit behavior across multiple API instances.
- [ ] Add a production CSP and verify CORS origin allowlisting (development currently allows origin reflection).
- [ ] Add CSRF protection if cookie-authenticated browser mutations are introduced; current admin auth is bearer-token based.
- [ ] Configure object storage for payment proofs; current proof storage is database-backed base64 for the sandbox.
- [ ] Complete NPC breach-notification hooks, incident runbook, and data-subject deletion workflow.
- [ ] Operator-approve Meta/PayMongo/courier/SMS credentials and public HTTPS webhooks before enabling live providers.
- [ ] Run the two-store PH E2E scenario and perform a production-readiness/WCAG/mobile review.

## Review Cadence

- Re-run `npm test` with isolated managed test data before release; residual full-suite failures are tracked as shared-pool/test-fixture isolation work.
- Review audit-log coverage whenever a new destructive or financial endpoint is added.
- Never place API keys, page tokens, webhook secrets, database URLs, or customer PII in commits, prompts, or logs.

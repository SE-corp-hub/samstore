# Production Readiness Checklist

Phase 12 requires operator-run infrastructure and credentials. This checklist is
deliberately explicit: skipped/manual checks are not represented as passing.

## Automated Gates

- [x] API/web typecheck.
- [x] Web production build.
- [x] Unit and DB-backed module tests.
- [x] Playwright critical-path specs exist under `apps/api/e2e/`.
- [ ] Full Playwright suite against deployed API + web.
- [ ] Required two-store PH scenario (`10-two-store-ph-scenario.spec.ts`).

Fixture helper:

```cmd
call npm.cmd run prepare:phase12
```

This creates two disposable stores with separate catalogs and writes tokenized E2E
URLs to `.phase12.env.local` (gitignored). It never deletes existing data.

## Operator Environment

- [ ] Managed Postgres backup/restore drill completed.
- [ ] Managed Redis configured and shared rate limits verified.
- [ ] `JWT_SECRET` and `CLAIM_SIGNING_SECRET` are production-strength.
- [ ] `DATABASE_URL` points to the intended production/sandbox database.
- [ ] `API_DOCS_ENABLED` reviewed before exposing `/docs` publicly.
- [ ] TLS termination and security headers verified at the edge.
- [ ] CORS origin allowlist replaces development reflection.

## Provider Approvals

- [ ] Meta App/Page, webhook URL, Page token, and App Secret approved.
- [ ] PayMongo sandbox/production credentials approved.
- [ ] Courier credentials approved (Lalamove/GrabExpress/J&T).
- [ ] BIR CSF/e-invoice credentials approved.
- [ ] SMS/email credentials approved.

## Product/Compliance Review

- [ ] Two separate stores cannot read or mutate one another's data.
- [ ] Guest checkout, pickup, delivery-zone coverage, voucher, loyalty, payment proof, and refund paths reviewed.
- [ ] BIR receipt, Sales Journal, Cash Receipts Journal, VAT, tax-exempt, and statutory-discount output reviewed.
- [ ] DPA consent, retention, incident, audit-log, and breach runbooks reviewed.
- [ ] Mobile viewport and WCAG keyboard/contrast pass completed.
- [ ] Messenger sends remain suppressed until operator approval is recorded.

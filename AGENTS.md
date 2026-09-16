# SAM STORE — Agent Operating Rules

Multi-tenant Messenger commerce platform. One module at a time. Verify, then report. Wait for `CONTINUE`.

## Architecture

- Monorepo: `apps/web` (admin dashboard + customer storefront in one Next.js app or clearly separated areas), `apps/api`, `packages/contracts`, `packages/ui`, `prisma`, `docs`, `tests`.
- **Bootstrap 5.3 is mandatory.** No Tailwind, Material UI, Ant Design, or copied dashboard designs.
- **Tenancy from the first migration.** Every store-owned table carries `store_id`. Retrofitting later is the most expensive mistake available.
- Managed cloud Postgres (Prisma) + managed Redis. **No local Docker.**
- Orders: server-authoritative pricing, immutable order snapshot, idempotency key, atomic stock reservation.
- Public store link: human-readable slug + high-entropy token. Never sequential IDs.

## Security

- Secrets (API keys, DB strings, Meta tokens, .env) **never** in repo, commits, logs, or prompts.
- Server-side validation on every input. Reject client-supplied totals.
- Tenant authorization on every query: store A must never read store B's data. Cross-tenant test required.
- Order claim links: single-use, signed, OTP where applicable.
- Destructive ops (DB drops, force-push, deploy, credential changes) need explicit operator approval.

## Testing & delivery

- Failing tests before implementation where practical.
- A gate passes only with **real command output pasted** — never asserted.
- Stubs are stubs: label mocks and unimplemented branches explicitly.
- One module per loop: plan → implement → format/lint/typecheck/test/build → update `docs/progress.md` → git checkpoint → report → stop.
- Report blockers instead of routing around them.

## Messenger

- Adapter behind an interface + mock provider + tests only. **No live Graph/Send API calls** until a Facebook App, Page tokens, and a public HTTPS webhook are operator-approved.
- Website→Messenger bridge defaults to suppress-send with portal status; never guess a token.

## Models

Tiered routing (fastest + cheapest to ship; keep the tiers separate):

- **Tier 1 — reasoning/risk** (schema, authorization, commerce invariants, module planning): `deepseek/deepseek-v4-flash-0731` (OpenRouter). Fallbacks: `z-ai/glm-5.3-flash`, then `z-ai/glm-5.2:free` (last resort).
- **Tier 2 — boilerplate volume** (CRUD scaffolding, read-only report screens, mechanical edits in established patterns): `inclusionai/ling-3.0-flash` ($0.021/$0.063, `response_format` supported).
- Never route gate runs through `:free` variants (rate limits restart the whole gate — the retry costs more than the paid tier).
- `cohere/north-mini-code:free` is NOT in the chain (no `response_format`).
- `anthropic/claude-sonnet-5` review tier: operator-initiated only.
- No secrets/PII/customer data to free endpoints, ever.
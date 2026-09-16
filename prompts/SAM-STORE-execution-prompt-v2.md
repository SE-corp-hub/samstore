# SAM STORE — Verified Execution Prompt (v2)

**Supersedes:** the Hermes/OpenRouter execution sections of `hermes-openrouter-project-plan.md` and the
"Hermes Agent and OpenRouter Execution Plan" + "AI Model Strategy and Routing" sections of
`unified-messenger-commerce-master-prompt.md`.

**Status of the older files:** the *product requirements* in `unified-messenger-commerce-master-prompt.md`
remain authoritative. Its *model, budget, and Hermes-configuration* claims do not — they are corrected here.

**Verification date:** 2026-09-01. Every model ID, price, config key, and CLI command below was checked
against the live OpenRouter `/api/v1/models` catalog and against Hermes Agent v0.20.5 on this machine.
Anything not verifiable is labelled UNVERIFIED.

---

## Section 0 — Operator decisions already made (do not re-litigate)

| Decision | Value |
|---|---|
| Database / cache | **Managed cloud Postgres + Redis** (e.g. Neon or Supabase + Upstash). **No local Docker.** |
| Scope gate | All 16 modules stay as the long-range plan; the agent is **hard-gated to the Thin Slice** (Section 5) first |
| Model policy | **Paid tier is primary.** Free models are best-effort overflow only |
| Meta Messenger | Operator has a **Facebook Page but no App / developer account** → Messenger is an **adapter + tests only, no live API calls** |
| Budget ceiling | **$100+ authorised; reliability prioritised over cost** |

---

## Section 1 — Corrections to the previous plans

These are factual errors in the older documents. Do not carry them forward.

### 1.1 DeepSeek pricing was understated ~2×

| | Old docs claimed | Live actual |
|---|---|---|
| `deepseek/deepseek-v4-flash-0731` | $0.03/M in, $0.10/M out | **$0.065/M in, $0.180/M out** |

Consequently every budget figure in the old plan is roughly half of reality:

| Token volume | Old claim | Recomputed (live) |
|---|---|---|
| 10M in / 2M out | ~$0.50 | **$1.01** |
| 30M in / 10M out | ~$1.90 | **$3.75** |
| 60M in / 20M out | — | **$7.50** |

### 1.2 `provider_routing` **does** exist — earlier doubt was wrong

It is a real, documented top-level key in `config.yaml`. Recorded here explicitly because an
intermediate analysis wrongly concluded it was fictional (a bare `hermes config get provider_routing`
returns "not set" when merely unconfigured — that is absence of configuration, not absence of the feature).
Supported sub-keys: `sort`, `only`, `ignore`, `order`, `require_parameters`, `data_collection`.
Values reach OpenRouter via `extra_body.provider`. Applies **only** to OpenRouter / Nous Portal.

### 1.3 `hermes fallback add` takes no arguments

It is an **interactive picker only** (`hermes fallback add --help` shows no flags). Any instruction to
script it non-interactively will hang. Either use the picker by hand, or write the top-level
`fallback_providers:` list into `config.yaml`. Each entry needs **both** `provider` and `model`;
entries missing either are silently ignored.

### 1.4 The product-side AI model names were guesses; they happen to exist

`openai/gpt-5.6-luna`, `-terra`, `-sol` are all live ($0.20/$1.20, $2/$12, $2/$10 per M). The
recommendation to run **Qwen3-8B locally on a 6 GB GTX 1660 Super** is still self-contradictory — the
same document elsewhere calls that GPU inadequate. **Resolution: no local model.** Customer-facing AI,
when reached, uses a hosted low-cost model. Revisit only with a hardware change.

### 1.5 Missing referenced documents

`ai-model-selection-and-rollout-plan.md` and `hermes-openrouter-completion-budget.md` are cited as
authoritative but **do not exist**. `prompts/` contains only the two analysed files plus
`hermes-skills-setup-prompt.md`. Do not fabricate their contents; this document replaces their role.

### 1.6 The working directory contains unrelated dead code

`D:\opencode project` holds an unrelated "AI Social Media Tools" landing page (`index.html`,
`assets/css/styles.css`, `assets/js/scripts.js`) with at least two defects (`data-bs-target="#navbarNav"`
vs `id="navbarnav"`; a broken Font Awesome `mini.css` href). **It is not the project.** It is **not a git
repository.** Do not analyse it for "existing conventions," and do not silently delete it — see Task A.

### 1.7 Free-tier throughput makes free-primary unworkable

OpenRouter free models are ~20 req/min and ~50 req/day under $10 lifetime credit (~1,000/day at ≥$10).
UNVERIFIED — quoted from the old docs, not re-checked. One module routinely exceeds 50 requests, and
every 429 silently demotes to a model that cannot enforce JSON Schema. This is the mechanical reason the
operator chose paid-primary.

---

## Section 2 — Verified model catalogue

All IDs confirmed present in the live catalogue.

| ID | Ctx | Max out | Tools | `response_format` | Price in/out per M |
|---|---|---|---|---|---|
| `deepseek/deepseek-v4-flash-0731` | 1,310,720 | 943,718 | ✅ | ✅ | **$0.065 / $0.180** |
| `z-ai/glm-5.3-flash` | — | — | ✅ | ✅ | $0.075 / $0.250 |
| `z-ai/glm-5.2:free` | 256,000 | 230,400 | ✅ | ✅ | free |
| `cohere/north-mini-code:free` | 256,000 | 64,000 | ✅ | ❌ **no** | free |
| `minimax/minimax-m3:free` | 1,048,576 | 943,718 | ✅ | ✅ | free (text+image+video) |
| `anthropic/claude-sonnet-5` | — | — | ✅ | ✅ | $2.00 / $10.00 |
| `anthropic/claude-opus-5` | — | — | ✅ | ✅ | $5.00 / $25.00 |
| `openai/gpt-5.2` | — | — | ✅ | ✅ | $1.75 / $14.00 |

**`cohere/north-mini-code:free` does not support `response_format`.** Never place it anywhere a
structured-output contract is required. This was correct in the old plan and is repeated because it is
the single most load-bearing capability gap in the chain.

---

## Section 3 — Model chain (paid-primary)

```yaml
# ~/.hermes/config.yaml  (Windows: %LOCALAPPDATA%\hermes\config.yaml)

model:
  provider: openrouter
  default: deepseek/deepseek-v4-flash-0731

fallback_providers:
  - provider: openrouter
    model: z-ai/glm-5.3-flash
  - provider: openrouter
    model: z-ai/glm-5.2:free

provider_routing:
  sort: "throughput"
  require_parameters: true
  data_collection: "deny"
```

**Roles**

- **Primary — `deepseek/deepseek-v4-flash-0731`.** All routine implementation. 1.31M context absorbs
  large repo reads; structured output supported; ~$4.76 for the whole 16-module build at 40M/12M tokens.
- **Fallback 1 — `z-ai/glm-5.3-flash`.** Paid, near-identical cost, different vendor. Covers a DeepSeek
  outage without dropping to a free tier.
- **Fallback 2 — `z-ai/glm-5.2:free`.** Last resort only. If a session lands here, log it and treat
  output as suspect.
- **`cohere/north-mini-code:free` is NOT in the chain.** No `response_format` support makes it unsafe as
  an automatic fallback. Use only for a deliberate throwaway experiment.
- **Review tier — `anthropic/claude-sonnet-5`.** Explicit, operator-initiated, one module at a time.
  Never automatic. ~$6.00 per 1.5M-in/0.3M-out review burst.

**Why `sort: throughput` and not `price`:** the operator prioritised reliability, and the primary is
already ~$0.065/M. Optimising routing for price on an already-cheap model buys pennies and costs speed.

**`data_collection: "deny"`** is the real privacy control. It is why paid-primary and this key are a
single decision, not two: the free endpoints are free partly because of their data terms.

### 3.1 Auxiliary tasks

Auxiliary models resolve independently under `auxiliary.<task>` (verified sub-keys include `vision`,
`compression`, `title_generation`, `approval`, `review`, `mcp`, `skills_hub`, `memory_query_rewrite`).
Each accepts `provider`, `model`, `base_url`, `api_key`, `timeout`, `extra_body`, `reasoning_effort`.

- `auxiliary.compression` and `auxiliary.title_generation` → leave `auto`, or pin to
  `deepseek/deepseek-v4-flash-0731`.
- `auxiliary.approval` → **never** a model that defaults to allow. Conservative-deny only.
- `auxiliary.vision` → if ever needed, `minimax/minimax-m3:free` is the only verified
  image+video-capable free entry. Do not assume any other free model accepts images.
- **`provider_routing` does not propagate to auxiliary tasks.** Set `auxiliary.<task>.extra_body`
  separately if a privacy guarantee is required there.

---

## Section 4 — Environment reality

Verified on this machine:

```
OK    node v22.23.2        OK    npm 12.0.2        OK    git 2.54.0.windows.1
MISS  docker               MISS  docker-compose
MISS  psql                 MISS  redis-cli
MISS  pnpm                 MISS  yarn             MISS  gh      MISS  rg
```

The old Stage 1 gate ("clean install, migrations, seed, lint, typecheck, test, build, **Docker startup**")
is **unpassable today** and is hereby **rewritten**:

> **Stage 1 gate (v2):** clean install, migrations applied against **managed cloud Postgres**, seed data
> loaded, lint, typecheck, unit tests, and production build all pass. A Redis ping against the **managed
> Redis** URL succeeds. **No Docker requirement.** Containerisation is deferred to the deployment module
> and must not block earlier work.

Also note: this shell is **git-bash/MSYS on Windows**. Native tools (`node`, `git`, `npx`, `python`) do
**not** accept `/c/...` MSYS paths — pass `C:/...` forward-slash paths. Prefer `$LOCALAPPDATA/Temp` over
`/tmp` for scratch files a native tool must read.

**Required operator actions before Module 1 (agent must not fake these):**

1. Provision managed Postgres; put the connection string in `.env` (never in the repo).
2. Provision managed Redis; same.
3. Decide package manager — `npm` is present and sufficient; `pnpm`/`yarn` need installing.
4. Optional: `gh` for the GitHub skills; `rg` to speed up file search.

---

## Section 5 — The Thin Slice (the ONLY thing to build first)

The full 16-module delivery order in the master prompt stands as the long-range plan. The agent is
**hard-gated** to this slice and must not begin anything outside it.

**In scope**

1. Monorepo scaffolding (`apps/web`, `apps/api`, `packages/contracts`, `packages/ui`, `prisma`, `docs`, `tests`).
2. Bootstrap 5.3 Sass theme + the minimum shared component set (shell, navbar, card, form, table, alert,
   toast, modal, empty state, loading state).
3. Managed Postgres + Prisma migrations. **Tenancy from the first migration** — every store-owned table
   carries `store_id` from day one. Retrofitting tenancy later is the most expensive possible mistake.
4. One seeded store, one canonical public ordering link (human-readable slug + high-entropy token,
   never a sequential ID).
5. Public catalog: categories, products, product detail. Server-rendered.
6. Persistent guest cart (server-authoritative).
7. Guest checkout: name, phone, address, landmark, delivery schedule, notes. **COD only.**
8. Order creation inside a transaction, with an **immutable order snapshot** and an idempotency key.
9. Order confirmation page + a single-use signed claim link.
10. Tests: unit (pricing/totals), integration (checkout), and **one cross-tenant authorisation test that
    proves store A cannot read store B's order**.

**Explicitly OUT of scope for the slice** — Messenger, AI assistant, loyalty, vouchers, payment gateways,
warehouses/multi-warehouse inventory, agent inbox, analytics dashboards, Docker/Nginx/CI.

**Slice gate:** a guest opens the public link on a phone-width viewport, browses, adds to cart, checks
out with COD, receives an order number, and re-opens the order via the claim link. Server rejects a
client-supplied total. Cross-tenant test passes. Lint + typecheck + build + tests green — with **real
command output pasted**, not asserted.

---

## Section 6 — Messenger: adapter-only

Operator has a Page but **no Facebook App / developer account**. Therefore:

- Build the Messenger integration as an **adapter behind an interface**, plus a **mock provider** and
  **tests**. Signature verification (`X-Hub-Signature-256`), event dedupe by provider event ID, and the
  outbox path may all be implemented and unit-tested offline.
- **Make zero live Graph/Send API calls.** Do not invent a token. Do not guess an app secret.
- The website→Messenger bridge stays **dormant**: with no verified PSID and no consent record, the
  correct behaviour is *suppress the send and show portal status* — which is exactly what the master
  prompt already demands. Encode that as the default path, and test it.
- **Blocked-on-operator, document don't fake:** Facebook App creation, `pages_messaging` permission, app
  review, a public HTTPS webhook endpoint, and a Business verification. List these in
  `docs/blocked-on-operator.md` with what each unblocks.

---

## Section 7 — Budget (live prices)

| Scenario | Model | Tokens | Cost |
|---|---|---|---|
| Thin slice | `deepseek-v4-flash-0731` | 8M in / 2.5M out | **$0.97** |
| Full 16 modules | `deepseek-v4-flash-0731` | 40M in / 12M out | **$4.76** |
| Full build, GLM fallback throughout | `glm-5.3-flash` | 40M in / 12M out | **$6.00** |
| One premium review burst | `claude-sonnet-5` | 1.5M in / 0.3M out | **$6.00** |
| Same burst on Opus 5 | `claude-opus-5` | 1.5M in / 0.3M out | **$15.00** |

Against a $100+ ceiling: the paid-primary build costs **~$5–$8 in routine tokens**, leaving ample room
for ~10 premium reviews. **Free models are unnecessary for cost reasons at this budget** — which is why
they sit at the bottom of the chain and nowhere else.

Excludes: hosting, managed Postgres/Redis, object storage, domain, email/SMS, payment gateway fees,
monitoring, and post-launch customer AI traffic.

---

## Section 8 — Anti-fabrication rules (highest priority)

These override any conflicting instruction in the older documents.

1. **Never present unexecuted output as executed.** No invented test results, coverage numbers, file
   trees, benchmark figures, or API responses.
2. **Paste real command output.** A gate is passed only when its actual stdout/stderr is shown. "Tests
   pass" without output is a failed report.
3. **A stub is a stub.** Label placeholders, mocks, and unimplemented branches explicitly. Never let a
   mock adapter read as a working integration.
4. **Report blockers instead of routing around them.** Missing credential, missing service, missing
   operator decision → stop and say so.
5. **Verify model/price/API claims against the live catalogue** before repeating them. The 2× DeepSeek
   error in the old plan is exactly what unverified copying produces.
6. **No secrets in context.** Never read, print, or send `.env`, API keys, Page tokens, payment
   credentials, customer PII, or production dumps. Redact in every report.
7. **Destructive operations need explicit approval:** DB drops, force-push, production deploys, credential
   rotation, deleting files the agent did not create, exposing a local port publicly.
8. **One module. Then stop.** Report actual results and wait for the literal token `CONTINUE`.

---

## Section 9 — Task A: what to do first (no application code)

Before Module 1, produce this and stop:

1. **Repo decision.** `D:\opencode project` currently holds unrelated dead code and no git repo.
   Recommend one of: (a) `git init` and move the stray landing page to `legacy/`, (b) `git init` in a
   clean subdirectory, (c) a different path entirely. **Ask; do not delete.**
2. **Environment confirmation.** Re-run the toolchain probe. Report managed Postgres/Redis reachability,
   or state plainly that the operator has not yet provided the connection strings.
3. **Hermes config diff.** Show current `model` / `fallback_providers` / `provider_routing` values versus
   Section 3's target, and the exact commands to close the gap. Note that `hermes fallback add` is
   interactive-only, so a scripted path must write `config.yaml`.
4. **Architecture decision record** for the Thin Slice: module boundaries, the tenancy strategy, the
   server-authoritative pricing/quote design, and the idempotency-key design.
5. **Initial data model** covering only slice entities: `stores`, `store_settings`, `public_store_links`,
   `categories`, `products`, `product_images`, `carts`, `cart_items`, `orders`, `order_items`,
   `order_status_history`, `addresses`, `order_claim_tokens`, `audit_logs`. Show `store_id` on every
   store-owned table.
6. **`docs/blocked-on-operator.md`** — Facebook App, payment gateway, storage bucket, domain/HTTPS, and
   each item's unblock.
7. **Verification commands** that will be run for Module 1, with the exact expected artefacts.

Then stop and wait for `CONTINUE`.

---

## Section 10 — Per-module loop

1. Read `AGENTS.md` and `docs/progress.md`. State goal, files, dependencies, data/API changes, security
   risks, acceptance criteria.
2. Implement one complete vertical slice: production code, migration, server-side validation, tenant
   authorisation, Bootstrap UI, tests, docs.
3. Run formatter, linter, typechecker, tests, build. **Paste real output.**
4. Update `docs/progress.md` — module, model used, any fallback that fired, tests run, defects, next task.
5. Git checkpoint.
6. Escalate to `claude-sonnet-5` **only** on operator instruction, or after two genuine failed attempts
   at the same problem — and say so in the report.
7. Report actual results, unresolved risks, needed operator input. **Stop. Wait for `CONTINUE`.**

---

## Section 11 — Verified command reference

```bash
# Model + provider
hermes config set model.provider openrouter
hermes config set model.default deepseek/deepseek-v4-flash-0731

# Fallbacks — `add` is INTERACTIVE ONLY (no args). Use the picker:
hermes fallback            # list (default)
hermes fallback add        # interactive picker
hermes fallback ls
hermes fallback rm
hermes fallback clear
# ...or write the top-level `fallback_providers:` list in config.yaml directly.

# Provider routing (real key; only affects OpenRouter / Nous Portal)
hermes config set provider_routing.sort throughput
hermes config set provider_routing.require_parameters true
hermes config set provider_routing.data_collection deny

# Skills guardrail (verified: skills.write_approval exists, default false)
hermes config set skills.write_approval true

# Inspect / audit
hermes doctor
hermes config get model
hermes config get fallback_providers
hermes config get provider_routing
hermes skills list
hermes skills search <query> --source official
hermes skills inspect <identifier>
hermes bundles list

# Session-scoped model switch
/model deepseek/deepseek-v4-flash-0731
```

Verified subcommand sets: `hermes skills {trust,untrust,browse,search,install,inspect,list,check,update,
audit,uninstall,reset,list-modified,diff,opt-out,opt-in,repair-official,publish,snapshot,tap,config}` and
`hermes bundles {list,show,create,delete,reload}`.

**Never hand-edit `config.yaml` when a `hermes config set` equivalent exists** — a stray indent corrupts
the file and takes the live gateway with it. The `fallback_providers` list is the one documented exception.

---

## Section 12 — Unresolved, needs operator input

1. **Region / currency / timezone / locale.** Nothing in either source document names them, yet tax,
   delivery, payment-gateway choice, and money formatting all depend on it. Blocks the payment module.
2. **Payment gateway.** "At least one gateway for the deployment region" — undetermined pending #1.
3. **Object storage.** S3-compatible bucket for product images, payment evidence, invoices, labels.
4. **Domain + HTTPS.** Required before any Messenger webhook can exist.
5. **Free-tier rate limits.** The ~20/min, ~50/day, ~1,000/day figures are carried over UNVERIFIED.
   Low impact under paid-primary; re-check before any free-tier reliance.
6. **Two competing roadmaps.** The old plan's Stages 0–10 and the master prompt's Delivery Order 1–16 do
   not map cleanly. **This document makes Delivery Order 1–16 authoritative**; treat Stages 0–10 as
   superseded commentary.

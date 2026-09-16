# Hermes Agent and OpenRouter Project Plan

This plan is for building the Messenger commerce platform with Hermes Agent using OpenRouter. It is designed for a low budget while preserving a reliable path to higher-quality models when a free model reaches a limit or produces an unacceptable result.

## Final Recommendation

Use this model chain:

1. Free quality-first default: `z-ai/glm-5.2:free`.
2. Free coding and tool-use fallback: `cohere/north-mini-code:free`.
3. Very low-cost paid fallback: `deepseek/deepseek-v4-flash-0731`.
4. Paid quality review for difficult security, architecture, or debugging work: `anthropic/claude-sonnet-5` or the current OpenAI flagship available to the account.

Use the exact model IDs above, not `openrouter/free`, for the main Hermes session. The `openrouter/free` router randomly selects among available free models, so behavior, tool calling, and output quality can change between requests.

## Model Comparison

| Model ID | Cost | Best use | Important limitation |
| --- | --- | --- | --- |
| `z-ai/glm-5.2:free` | Free | Main project planning, coding, long tasks, tool calling | Free endpoint is rate limited and availability can change |
| `cohere/north-mini-code:free` | Free | Coding, terminal work, patches, tests, tool calls | Does not enforce JSON Schema `response_format`; test Hermes tool behavior |
| `minimax/minimax-m3:free` | Free | Long context, multimodal or document tasks | Free capacity and structured-output behavior can vary |
| `deepseek/deepseek-v4-flash-0731` | About $0.03/M input and $0.10/M output | Reliable low-cost implementation and fallback | Still requires OpenRouter credits and provider/data-policy review |
| `z-ai/glm-5.3-flash` | About $0.075/M input and $0.25/M output | Fast paid coding fallback | Discounts and pricing may be temporary |
| `anthropic/claude-sonnet-5` | About $2/M input and $10/M output | Difficult review, security, architecture, and debugging | Use sparingly for a low budget |

OpenRouter currently describes GLM 5.2 as a long-horizon project software-engineering and tool-use model. North Mini Code is specifically described as an agentic coding model trained to generalize across coding harnesses, including OpenCode and SWE-Agent. DeepSeek V4 Flash 0731 is listed as a coding and tool-calling model with many provider endpoints, automatic failover, and structured output support.

No free model is guaranteed to match a frontier paid model on every task. The quality target must be measured on this project's own tasks, languages, tools, tests, and security requirements.

## Hermes Configuration

Hermes stores configuration under `~/.hermes/`. Put the OpenRouter key in `~/.hermes/.env`, never in the repository, prompt, `AGENTS.md`, or a commit.

Configure the provider using:

```shell
hermes model
```

Select OpenRouter, enter the key, and choose the exact model. You can also switch an existing session with:

```text
/model openrouter:z-ai/glm-5.2:free
```

Or use the CLI form when supported by the installed Hermes version:

```shell
hermes chat --provider openrouter --model z-ai/glm-5.2:free
```

Set the fallback chain with:

```shell
hermes fallback
```

Recommended fallback order:

```yaml
model:
  provider: openrouter
  default: z-ai/glm-5.2:free

fallback_providers:
  - provider: openrouter
    model: cohere/north-mini-code:free
  - provider: openrouter
    model: deepseek/deepseek-v4-flash-0731
```

For requests that use tools, require providers to support the parameters Hermes sends:

```yaml
provider_routing:
  sort: price
  require_parameters: true
```

For private source code, credentials, customer records, or production logs, use only OpenRouter providers whose current data policy is acceptable. Configure `data_collection: deny` or `zdr: true` where supported, and use a paid provider if the free endpoint cannot satisfy that requirement:

```yaml
provider_routing:
  sort: price
  require_parameters: true
  data_collection: deny
```

Do not send `.env` files, API keys, payment data, Messenger tokens, customer PII, or production database dumps to a free endpoint. Free endpoints may have provider-specific logging or training terms.

## Free-Model Limits and Reliability

Free OpenRouter variants are useful for development but are not a production SLA. Current OpenRouter documentation describes free-model limits of approximately 20 requests per minute and 50 requests per day when the account has purchased less than $10 in credits. Accounts with at least $10 in purchased credits may receive up to approximately 1,000 free-model requests per day. Limits and policies can change.

Implement these protections:

- Keep the free model as the first choice for development.
- Allow Hermes to fall back to North Mini Code, then paid DeepSeek, on rate limit, capacity, invalid response, or tool failure.
- Keep a positive OpenRouter balance and set a small per-key spending limit.
- Monitor `GET https://openrouter.ai/api/v1/key` or the OpenRouter dashboard for credits, daily usage, weekly usage, and monthly usage.
- Use exponential backoff and honor `Retry-After`.
- Do not retry a failed mutation blindly; inspect whether the tool or command already ran.
- Pin or exclude providers when privacy or reliability requires it.
- Record the model, provider, response status, token usage, and fallback reason for every session.

## Auxiliary Hermes Models

Do not waste the main model on every auxiliary task. Configure cheap models for compression, titles, approval classification, and summaries after confirming that their output is safe:

- Context compression: `cohere/north-mini-code:free` or paid DeepSeek.
- Session title and simple summaries: `cohere/north-mini-code:free`.
- Command approval classification: a cheap model with conservative deny behavior, never an automatic allow for sensitive commands.
- Vision or PDF analysis: a current OpenRouter vision-capable model; do not assume every free model supports images.
- Final review: run an explicit one-time paid model review only for high-risk modules.

Auxiliary fallbacks must be configured separately when the installed Hermes version supports task-specific fallback chains. Keep the primary session fallback chain independent from auxiliary jobs.

## Hermes Safety and Workspace Setup

Before implementation:

- Put the master product prompt in project documentation, not in a secret file.
- Create an `AGENTS.md` with concise coding rules, architecture decisions, test commands, and the requirement to implement one module at a time.
- Keep a `docs/progress.md` file with completed modules, current work, tests, known defects, and the next task.
- Create a Git branch or checkpoint for every module.
- Use Hermes checkpoints or normal Git commits before large changes.
- Use Hermes Docker terminal isolation if Docker Desktop is available. Otherwise review every command before allowing it to run locally.
- Never allow the agent to run destructive commands, expose local ports publicly, delete databases, rotate production credentials, or deploy without explicit approval.
- Keep production credentials outside the working tree and outside model context.
- Use synthetic data for development and evaluation.

The user's GTX 1660 Super is not used for OpenRouter inference. Hermes runs the tools locally, while OpenRouter runs the selected model remotely. A local Qwen model can be used as an optional private experiment, but it should not be the primary Hermes model on this hardware because tool-enabled Hermes sessions need a large context and the GPU has only 6 GB VRAM.

## Project Progress Plan

Do not ask Hermes to build the entire platform in one session. Complete one vertical slice, verify it, checkpoint it, and start the next module only after the previous gate passes.

### Stage 0: Project Discovery and Controls

Deliver:

- Repository assessment.
- Architecture decision record.
- Final workspace structure.
- `AGENTS.md`, `docs/progress.md`, and `.env.example`.
- Hermes/OpenRouter configuration.
- Bootstrap 5.3 theme plan.
- Docker development environment.
- Git branch and checkpoint rules.

Quality gate: Hermes can inspect the repository, run the chosen test command, and explain how secrets and tenant data are protected.

### Stage 1: Foundation

Deliver:

- Next.js, React, TypeScript, and Bootstrap 5.3 application shell.
- NestJS API, workers, Redis, PostgreSQL, Prisma migrations, and health checks.
- Shared types and error format.
- Logging, correlation IDs, configuration validation, and basic CI.

Quality gate: clean install, migrations, seed data, lint, type check, unit test, build, and Docker startup.

### Stage 2: Identity and Multi-Tenancy

Deliver:

- Platform administrator, store owner, staff, agent, and customer roles.
- Authentication, sessions, password reset, verification, MFA path, and RBAC.
- Stores, memberships, tenant guards, audit logs, invitations, and owner onboarding.
- Customer approval queue with approve, reject, suspend, reason, notification, and audit history.

Quality gate: automated cross-tenant authorization tests prove that one store cannot access another store's records.

### Stage 3: Store Management and Public Link

Deliver:

- Store profile, branding, business hours, holidays, tax, delivery, payment, and policy settings.
- One canonical shareable ordering link per store.
- Link preview, QR code, revoke, rotate, rate limit, and campaign attribution.
- Mobile Bootstrap storefront shell.

Quality gate: a guest can open the link, see only that store, and order without login. A revoked link cannot create a new session.

### Stage 4: Catalog, Cart, and Pricing

Deliver:

- Categories, products, images, variants, modifiers, add-ons, SKUs, availability, and stock display.
- Persistent guest and customer carts.
- Server-side pricing quote, taxes, delivery fee, vouchers, promotions, and loyalty preview.
- Cart expiry, re-pricing, concurrency controls, and abandoned-cart state.

Quality gate: stale prices, unavailable products, invalid vouchers, and concurrent cart updates are handled without trusting the browser.

### Stage 5: Checkout, Orders, and Inventory

Deliver:

- Guest checkout and optional account creation.
- Name, phone, address, landmark, delivery schedule, payment method, and notes.
- Order number, immutable order snapshot, order state machine, cancellation, and claim token.
- Warehouses, reservations, deductions, releases, movements, low-stock alerts, and fulfillment assignment.

Quality gate: concurrent checkout cannot oversell or create duplicate orders. Cancellation releases stock exactly once.

### Stage 6: Payments, Delivery, and Notifications

Deliver:

- Cash on delivery, bank transfer, payment links, and one gateway adapter.
- Signed callbacks, payment reconciliation, receipts, invoices, and refunds.
- Delivery zones, rates, tracking, labels, ETA, and manual provider.
- Outbox, worker retries, customer notifications, preferences, and fallback channels.

Quality gate: a forged or duplicated callback cannot mark a payment paid, charge twice, or create duplicate notifications.

### Stage 7: Messenger and Website-to-Messenger Bridge

Deliver:

- Meta Login, Page connection, encrypted tokens, webhook verification, event deduplication, and event queue.
- Welcome, menu, postbacks, quick replies, templates, carousels, attachments, locations, receipts, and handoff.
- Messenger-originated identity linking.
- Explicit website `Get updates in Messenger` flow.
- Website order events routed through the official Messenger Send API only after verified identity and consent.

Quality gate: direct-link guests are not messaged automatically. Messenger-originated or explicitly linked customers receive eligible status updates with delivery and read receipts.

### Stage 8: CRM and Human Agents

Deliver:

- Customer timeline, tags, notes, purchase history, lifetime value, favorite products, assignment, and approval state.
- Real-time inbox, agent assignment, take-over, release-to-AI, canned responses, internal notes, and WebSocket events.

Quality gate: agents see only authorized store conversations and customers. Internal notes never reach Messenger.

### Stage 9: Loyalty, Vouchers, and AI Assistant

Deliver:

- Percentage or fixed loyalty earning rules.
- Point ledger, expiry, reversal, redemption into store-owner-configured vouchers, and anti-double-spend controls.
- Percentage and fixed-value vouchers, limits, dates, scope, stacking, and audit history.
- AI Gateway, model registry, routing, store RAG, authorized tools, memory, moderation, handoff, and cost limits.

Quality gate: AI cannot invent an order fact, expose another customer's order, change a payment, or bypass loyalty and voucher rules.

### Stage 10: Analytics, Security, Testing, and Release

Deliver:

- Sales, revenue, conversion, abandoned carts, products, customers, AOV, response time, agents, inventory, orders, loyalty, vouchers, delivery, and campaign attribution.
- Unit, integration, E2E, Messenger, payment, inventory concurrency, accessibility, load, and security tests.
- OpenAPI, ER diagram, manuals, Docker, Nginx, HTTPS, backups, monitoring, and CI/CD.
- Requirements traceability matrix and release checklist.

Quality gate: all release tests pass, backups restore successfully, secrets are absent from Git, and production rollback is documented.

## Per-Module Hermes Workflow

Use one Hermes session or clearly summarized checkpoint per module. Give Hermes this structure:

```text
Read the master product prompt, AGENTS.md, and docs/progress.md.

Work only on Module: <module name>

First inspect the repository and state:
- current relevant files
- dependencies
- data and API changes
- security risks
- acceptance criteria

Then implement one complete vertical slice with:
- production code
- migrations
- validation and authorization
- Bootstrap UI where applicable
- tests
- documentation

Run the relevant formatter, linter, type checker, tests, and build.
Do not start another module. Report actual results, failures, changed files, and next steps.
Wait for CONTINUE.
```

Use the free model for normal implementation. Escalate to paid DeepSeek when the free model fails twice on the same issue, cannot follow tool schemas, or produces incomplete patches. Use Claude Sonnet or another premium model only for final review of security, payments, Messenger, tenancy, concurrency, and deployment.

## Evaluation Before Full Build

Run a small model bake-off before committing to a main model. Give every candidate the same 20 tasks:

- Inspect and explain the empty repository.
- Create a Bootstrap responsive page.
- Add a PostgreSQL migration with tenant scope.
- Implement an authorized NestJS endpoint.
- Write a cart total test.
- Fix a failing test.
- Handle a concurrent inventory reservation.
- Design an idempotent webhook handler.
- Implement a Messenger signature check.
- Explain a payment security risk.
- Refactor a multi-file change.
- Run and interpret the test suite.
- Produce an OpenAPI schema.
- Write a Docker health check.
- Reject a prompt-injection attempt.
- Refuse an unauthorized order lookup.
- Create a customer approval workflow.
- Implement a voucher usage limit.
- Summarize progress without losing acceptance criteria.
- Recover from a tool or provider failure.

Score each result on compile or test success, correct tool use, security, tenant isolation, patch completeness, instruction following, latency, and cost. Keep a failed-task log. Do not promote a model because it produced one impressive answer.

## Budget Plan

Use free models for discovery, routine implementation, documentation, tests, and low-risk refactors. Keep OpenRouter credits for the paid fallback and high-risk review.

Current OpenRouter pricing pages list DeepSeek V4 Flash 0731 at approximately $0.03 per million input tokens and $0.10 per million output tokens. At that rate:

- 10 million input and 2 million output tokens is about $0.50.
- 30 million input and 10 million output tokens is about $1.90.
- A premium review using 1 million input and 200,000 output tokens at $2/$10 is about $4.00.

These are model-token estimates only. Retries, long tool results, provider changes, auxiliary models, paid premium models, and other services can increase the bill. Keep a small initial OpenRouter budget, set a key limit, and review usage after every project stage.

## Definition of Done

The project is progressing correctly when every stage has a committed or checkpointed vertical slice, passing verification results, a documented known-risk list, and an updated `docs/progress.md`. The free model may accelerate the work, but no feature is accepted until the code, tests, security checks, and actual runtime behavior pass the stage gate.

## References

- Hermes AI providers: https://hermes-agent.nousresearch.com/docs/integrations/providers
- Hermes model configuration: https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models
- Hermes fallback providers: https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers
- Hermes provider routing: https://hermes-agent.nousresearch.com/docs/user-guide/features/provider-routing
- OpenRouter free models: https://openrouter.ai/collections/free-models
- OpenRouter coding models: https://openrouter.ai/collections/programming
- OpenRouter tool-calling models: https://openrouter.ai/collections/tool-calling-models
- OpenRouter provider routing: https://openrouter.ai/docs/provider-routing
- GLM 5.2 free: https://openrouter.ai/z-ai/glm-5.2:free
- North Mini Code free: https://openrouter.ai/cohere/north-mini-code:free
- DeepSeek V4 Flash 0731: https://openrouter.ai/deepseek/deepseek-v4-flash-0731

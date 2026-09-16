# Hermes Agent Skills Setup Prompt

Copy and paste this entire prompt into Hermes Agent after starting it from the project root.

---

## Role

Act as a senior developer-experience engineer, security engineer, QA lead, and Hermes Agent skills administrator. Prepare Hermes Agent with the smallest trustworthy set of skills and tools needed to build the multi-store Messenger commerce platform described in `unified-messenger-commerce-master-prompt.md`.

Do not start implementing the application until the skills audit and setup report are complete. Do not claim a skill is installed or working until you verify it.

## Project Context

The project is a production-ready, multi-tenant commerce platform with:

- Platform administrator managing multiple stores.
- Store owners, staff, sales agents, and customer approval workflows.
- Bootstrap 5.3 admin dashboard, customer portal, and mobile public ordering link.
- Guest ordering without login, carts, checkout, payments, inventory, shipping, CRM, loyalty, vouchers, analytics, and AI.
- Official Meta Messenger integration and the website-to-Messenger notification bridge.
- Hermes Agent using OpenRouter with this model chain:
  - `z-ai/glm-5.2:free`
  - `cohere/north-mini-code:free`
  - `deepseek/deepseek-v4-flash-0731`
- One-module-at-a-time implementation with tests, checkpoints, and `CONTINUE` approval.

Read these files if they exist:

- `unified-messenger-commerce-master-prompt.md`
- `hermes-openrouter-project-plan.md`
- `ai-model-selection-and-rollout-plan.md`
- `hermes-openrouter-completion-budget.md`

If any file is missing, report it and continue with the files that exist. Do not recreate or simplify the master requirements without approval.

## Non-Negotiable Safety Rules

- Inspect installed, bundled, official optional, and community skills before installing anything.
- Prefer bundled or official skills. Do not install a community skill automatically.
- Inspect the source, license, commands, dependencies, required environment variables, and security scan result before every optional or community install.
- Never use `--force` to override a dangerous skill verdict. Ask the operator about caution or warning findings.
- Enable skill-write approval before allowing Hermes to create or modify skills when supported:

```shell
hermes config set skills.write_approval true
```

- Keep API keys and secrets in `~/.hermes/.env` or an approved secret manager. Never put them in the repository, skills, prompts, logs, or commits.
- Never send `.env` files, payment information, Messenger tokens, customer PII, production logs, or production database dumps to free OpenRouter models or community skills.
- Use synthetic data during development and evaluation.
- Use Docker terminal isolation if Docker Desktop is available. Do not expose local services or Ollama to the public Internet.
- Never run destructive commands, delete databases, change production credentials, push with force, deploy, or send external messages without explicit operator approval.
- Do not use scraping, stealth browsing, unofficial Facebook automation, jailbreak skills, credential-harvesting skills, or tools intended to bypass access controls.
- The official Meta Messenger integration must be implemented from current Meta documentation. Do not guess a skill name such as `facebook-messenger`, `meta-messenger`, or `pancake` and do not install an unverified skill for it.

## Step 1: Audit Hermes

Run safe, read-only diagnostics and report actual output:

```shell
hermes doctor
hermes config get model
hermes config get terminal
hermes tools
hermes skills list
hermes skills list --source hub
hermes bundles list
hermes mcp catalog
```

Also check:

- Hermes version and update status.
- Active OpenRouter model and fallback chain.
- Active terminal backend and whether Docker is available.
- Whether Git, Node.js, npm or pnpm, Docker, PostgreSQL client, Redis client, and GitHub CLI are available.
- Whether the project is a Git repository.
- Whether `AGENTS.md`, `docs/progress.md`, and `docs/skill-inventory.md` exist.

Do not expose secret values in the report. Redact keys, tokens, passwords, connection strings, and private paths where appropriate.

## Step 2: Required Skill Inventory

Use exact installed skill names. These are the recommended capability groups; if a named skill is not installed, search for the current exact equivalent rather than inventing a path.

### Project planning and engineering

Use these bundled skills for every module as applicable:

- `plan`
- `codebase-inspection`
- `test-driven-development`
- `systematic-debugging`
- `requesting-code-review`
- `simplify-code`
- `spike`
- `node-inspect-debugger`
- `sdlc-review`
- `hermes-agent-skill-authoring` only when a missing project-specific workflow must be turned into a reviewed skill.

Purpose:

- Plan one vertical slice before coding.
- Inspect the repository and existing conventions.
- Write failing tests before implementation where practical.
- Debug root causes instead of guessing.
- Review changes before a checkpoint.
- Remove unnecessary complexity after a feature works.
- Validate risky integrations with a small spike.
- Diagnose NestJS and Node runtime issues.
- Review module handoffs and release readiness.

### GitHub and source control

Use these bundled skills when GitHub is used:

- `github-auth`
- `github-repo-management`
- `github-issues`
- `github-code-review`
- `github-pr-workflow`

Use them to authenticate safely, create or manage the repository, maintain issues, review diffs, create branches, and report actual CI status. Never commit secrets.

### Documentation and source material

Use these bundled skills for the supplied PDFs and project documentation:

- `pdf`
- `ocr-and-documents`
- `architecture-diagram`
- `grounded-citations`

Use them to inspect, extract, cite, and diagram requirements. Preserve source meaning without copying protected code, branding, UI, or proprietary assets.

### Web, API, and user-interface quality

Use these built-in capabilities and skills when available:

- Built-in `web` and `browser` toolsets for official documentation and local browser testing.
- `rest-graphql-debug` for API status, schemas, authentication, and reproducible failures.
- `dogfood` for exploratory testing of the running website.
- `adversarial-ux-test` for hostile-user UX checks on staging only.

The website must use Bootstrap 5.3 as required by the master prompt. Do not install or use skills that replace Bootstrap with Tailwind, Material UI, Ant Design, or copied dashboard designs.

### Infrastructure and release

Install these official optional skills only after inspecting them:

- `official/devops/docker-management`
- `official/software-development/subagent-driven-development`
- `official/software-development/rest-graphql-debug`
- `official/dogfood/adversarial-ux-test`
- `official/security/web-pentest`

Use `web-pentest` only against an owned, isolated staging environment with written authorization. It must not be used against Meta, payment providers, random public systems, or any system without permission.

### AI and retrieval evaluation

Use these only if the related work is reached:

- `evaluating-llms-harness` for model comparison and regression evaluation.
- `qmd` for local hybrid search over project notes and documentation if the repository needs it.
- `chroma` or `qdrant` only if the implementation explicitly selects that vector store; do not introduce a second vector database without an architecture decision.
- `huggingface-hub` only for inspecting approved model artifacts or licenses.
- `llama-cpp` or `serving-llms-vllm` only for an approved local-model experiment; OpenRouter remains the primary Hermes provider.

Do not install fine-tuning skills such as Axolotl, Unsloth, PEFT, or TRL for the initial product. Fine-tuning is not required for the first release and would consume budget without fixing missing tools, data, or authorization.

### Optional integrations

Install only if a later module needs them:

- `official/mcp/mcporter` or `official/mcp/fastmcp` only when the project has a specific MCP server requirement.
- `maps` for delivery-zone geocoding or route experiments when the chosen provider and privacy policy are approved.
- `official/productivity/shopify` only if an explicit Shopify integration is added; it is not part of the initial platform requirement.

Do not add external integrations just to increase the tool count.

## Step 3: Discover and Install

For every missing capability, search first:

```shell
hermes skills search <keyword>
hermes skills search <keyword> --source official
hermes skills browse --source official
hermes skills inspect <exact-identifier>
```

Install only the approved official optional skills that are actually missing:

```shell
hermes skills install official/devops/docker-management
hermes skills install official/software-development/subagent-driven-development
hermes skills install official/software-development/rest-graphql-debug
hermes skills install official/dogfood/adversarial-ux-test
hermes skills install official/security/web-pentest
```

If an identifier or command does not exist in the installed Hermes version:

1. Record it as unavailable.
2. Search the current catalog for an equivalent.
3. Do not install a random community replacement without operator approval.
4. Continue with built-in tools or an explicit documented manual procedure.

After installation, run:

```shell
hermes skills list
hermes skills check
hermes skills audit
```

Report skill provenance, version, license, scanner result, dependencies, and whether it is bundled, official, trusted, or community.

## Step 4: Create Skill Bundles

Create bundles only from skills that are installed and verified. Missing skills must be reported, not silently substituted.

Create these bundles when the installed Hermes version supports bundles:

### `commerce-foundation`

Use for planning and normal implementation:

- `plan`
- `codebase-inspection`
- `test-driven-development`
- `requesting-code-review`
- `systematic-debugging`

Bundle instruction:

```text
Inspect the repository and current progress first. Work on one module only. Use tests, server-side validation, tenant authorization, Bootstrap UI conventions, and a Git checkpoint. Report actual verification results and wait for CONTINUE.
```

### `commerce-git`

Use for source control and review:

- `github-auth`
- `github-repo-management`
- `github-issues`
- `github-code-review`
- `github-pr-workflow`

Bundle instruction:

```text
Never commit secrets. Show the active branch, diff, tests, and CI result. Never force-push or merge without explicit approval.
```

### `commerce-qa`

Use for running and testing features:

- `dogfood`
- `rest-graphql-debug`
- `node-inspect-debugger`
- `systematic-debugging`

Bundle instruction:

```text
Reproduce failures before changing code. Capture steps, expected behavior, actual behavior, logs, screenshots where useful, root cause, fix, and regression test.
```

### `commerce-docs`

Use for requirements and deliverables:

- `pdf`
- `ocr-and-documents`
- `architecture-diagram`
- `grounded-citations`

Bundle instruction:

```text
Use official and verifiable sources, cite them, preserve requirement traceability, and create original diagrams and documentation.
```

### `commerce-release`

Use before a release:

- `sdlc-review`
- `requesting-code-review`
- `dogfood`
- `github-pr-workflow`
- `docker-management` if installed

Bundle instruction:

```text
Run the release checklist, security checks, migrations, backups, health checks, responsive QA, and rollback review. Do not claim production readiness with failing or skipped checks.
```

Use `hermes bundles list` and `hermes bundles show <bundle>` to verify every bundle. If bundle creation fails because a skill is missing, report the exact missing name and create no misleading partial bundle unless explicitly allowed.

## Step 5: Configure Tools and MCP Carefully

Use only the minimum toolsets needed for the current stage:

- `terminal`
- `file`
- `todo`
- `clarify`
- `delegation` only after reviewing parallel write conflicts
- `web` for official documentation
- `browser` for local staging UX tests
- `memory` and `session_search` for durable project progress
- `skills` for loading approved skills

Prefer Hermes built-in GitHub skills and the `gh` CLI over an unnecessary GitHub MCP server. If an MCP server is required:

1. Inspect the catalog manifest or official source.
2. Enable only the tools required for the current module.
3. Exclude destructive tools such as delete, purge, refund, or production mutation unless the operator explicitly authorizes them.
4. Set timeouts, tool filters, and environment variables explicitly.
5. Keep MCP credentials in the supported secret store.
6. Test with a read-only call first.

Do not add a database MCP server that gives the model unrestricted write access. Application migrations and domain services remain the authority.

## Step 6: Create Project Operating Files

If they do not exist, create these files in the project repository:

- `AGENTS.md`: concise rules for architecture, Bootstrap, security, testing, secrets, and one-module delivery.
- `docs/progress.md`: completed module, current module, model used, fallback usage, tests, known defects, and next task.
- `docs/skill-inventory.md`: installed skill, source, version, license, purpose, scanner result, and approved use.
- `docs/skills-and-tools.md`: bundles, toolsets, MCP servers, environment requirements, and operator approval requirements.
- `docs/ai-evaluation.md`: model bake-off cases and pass/fail results.
- `docs/security-boundaries.md`: protected paths, credentials, database, Meta tokens, provider data policy, and deployment boundaries.

Keep the documents short enough for progressive disclosure. Do not paste every skill's full text into `AGENTS.md`.

## Step 7: Verify the Setup

Perform safe verification:

- List every installed skill and bundle.
- Load the `commerce-foundation` bundle without modifying application code.
- Ask the planning skill to produce a plan for Module 1 and verify it saves the expected plan file.
- Run a read-only repository inspection.
- Run the project's existing lint, type check, test, and build commands if they exist.
- Verify Git status and confirm no secrets are tracked.
- Verify Docker availability without stopping or removing existing containers.
- Verify browser tooling against a local test page only if a server exists.
- Verify `hermes doctor`, `hermes skills check`, `hermes skills audit`, and `hermes bundles list`.

If a check is unavailable because the repository is empty, report `not applicable` rather than fabricating success.

## Final Setup Report

Return a concise but complete report containing:

- Hermes version and active profile.
- OpenRouter primary model and fallback models, with secrets redacted.
- Installed skills grouped by bundled, official optional, trusted, and community.
- Skills installed during this run and why.
- Skills deliberately not installed and why.
- Created bundles and their exact skill members.
- Enabled toolsets and MCP servers with dangerous tools excluded.
- Docker, Git, Node, package manager, PostgreSQL, Redis, and browser readiness.
- Security findings and operator actions required.
- Estimated OpenRouter budget impact.
- Files created or changed.
- Commands used and actual verification results.
- The recommended first implementation module.

Do not begin application Module 1 in this response. End with:

```text
Skills setup complete. Waiting for CONTINUE before implementing Module 1.
```

---

## Operator Reference Links

- Hermes skills: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- Hermes bundled skills catalog: https://hermes-agent.nousresearch.com/docs/reference/skills-catalog
- Hermes optional skills catalog: https://hermes-agent.nousresearch.com/docs/reference/optional-skills-catalog
- Hermes MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- Hermes security: https://hermes-agent.nousresearch.com/docs/user-guide/security
- Hermes tools: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools

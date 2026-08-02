# OpenRouter and Autumn Billing Design

Status: draft
Last reviewed against vendor docs: 2026-07-08
Last reviewed against codebase: 2026-07-08
Business spec: embedded below (from the private billing spec, 2026-07-08)

## Goal

Move Jina review model execution to OpenRouter, let users connect their own
OpenRouter credentials from the dashboard, persist exact model usage and cost
for every review, and bill everything through a single org-level **Jina
Credits** meter with Autumn as the billing and entitlement layer.

## Vendor Facts To Build Around

OpenRouter:

- OpenRouter is OpenAI-compatible at `https://openrouter.ai/api/v1`.
- Codex CLI supports an `openrouter` model provider with `base_url` and
  `env_key = "OPENROUTER_API_KEY"`.
- OpenRouter OAuth PKCE redirects the user back with a `code`; exchanging it at
  `https://openrouter.ai/api/v1/auth/keys` returns a user-controlled API key.
- Manual API keys are Bearer tokens and can have optional OpenRouter-side
  credit limits.
- OpenRouter responses include usage data automatically, including prompt,
  completion, total, cached, reasoning, and cost fields. The old
  `usage: { include: true }` and streaming `include_usage` flags are deprecated.
  Because the entire telemetry design rests on this and Codex CLI will never
  send the flag itself, the capture proxy still injects
  `usage: { include: true }` into JSON request bodies defensively and the
  staging reconciliation step confirms cost fields actually arrive.
- If a response has to be audited later, the generation id can be used with the
  generation stats endpoint.
- The optional request `user` field should contain a stable internal identifier,
  never email or other PII.

Autumn:

- Autumn models billing as features, plans, plan items, subscriptions, and
  balances.
- Autumn is a layer on top of Stripe: it connects to a Stripe account and
  drives subscriptions, checkout, and invoicing through it. Jina already has
  a Stripe account, used today for hand-created charges with no dashboard or
  code surface (no Stripe code exists in this repo). Connect Autumn to that
  account instead of writing any direct Stripe integration, and link the
  existing hand-billed Stripe customers by id when creating their Autumn
  customers.
- Runtime access is enforced with `check`; usage is recorded with `track`.
- Consumable features support monthly included balances and purchasable
  top-ups, which is exactly the included-credits + overage-credits shape below.
- `trackTokens` can convert token pools into AI credit usage, but Jina computes
  credit amounts itself from OpenRouter's returned cost; Autumn only holds
  balances, plans, and events.

Primary docs:

- https://openrouter.ai/docs/cookbook/coding-agents/codex-cli
- https://openrouter.ai/docs/guides/overview/auth/oauth
- https://openrouter.ai/docs/cookbook/administration/usage-accounting
- https://openrouter.ai/docs/cookbook/administration/user-tracking
- https://docs.useautumn.com/documentation/concepts/overview
- https://docs.useautumn.com/documentation/getting-started/gating
- https://docs.useautumn.com/documentation/modelling-pricing/usage-based-pricing
- https://docs.useautumn.com/documentation/external-providers/openrouter
- https://docs.useautumn.com/api-reference/balances/trackTokens

## Codebase Facts To Build Around

These are the seams this plan hooks into, verified against the current code:

- Reviews are dispatched from the API webhook path (`api/src/github.ts` via
  `api/src/trigger.ts`), gated by the staged allowlist in
  `api/src/review-task-routing.ts` (`reviewTaskTriggerControl`, currently
  `enabled: false` with one allowed repository). Manual triggers share the
  payload shape via `api/src/pr-trigger.ts`.
- The `review` Trigger task (`trigger/src/trigger/review.ts`) creates the run
  through `/internal/reviews/prepare`, fans out to two child stages
  (`summary`, `runtime`), and completes through
  `/internal/reviews/:id/complete`. `completeReviewRun` returns
  `updated: false` when the run is already terminal — that flag is the
  idempotency hook for the per-run infra charge.
- Each stage creates its own Daytona sandbox (`createReviewSession` in
  `trigger/src/daytona/review-session.ts`) and runs exactly one foreground
  command per phase (`npx tsx runner.ts`). There is no long-lived service slot
  in the sandbox; anything that must run alongside the worker has to be
  spawned and torn down by the runner itself.
- The summary stage makes zero LLM calls today — it is codegraph plus git diff
  (`trigger/src/review/summary-stage.ts`, `trigger/src/review/codex-review.ts`).
  All Codex calls happen in the runtime stage as three operations — planner,
  agent (investigation), mental trace — via `codex exec --model <model> -c
  model_reasoning_effort=<effort> ...` in
  `trigger/src/runtime-review/index.ts` (`callCodexJson` / `callCodexText`).
  There is no `config.toml`; auth flows through `CODEX_API_KEY` /
  `OPENAI_API_KEY` env (`codexEnv()` in `trigger/src/shared/utils.ts`).
- Model defaults live in `trigger/src/shared/utils.ts`:
  `REVIEW_CODEX_MODEL` (`gpt-5.5`), `RUNTIME_PLANNER_MODEL` (`gpt-5.5`),
  `RUNTIME_AGENT_MODEL` (`gpt-5.4`), `RUNTIME_MENTAL_TRACE_MODEL`
  (`gpt-5.4-mini`). These are OpenAI-native names, set globally by env. The
  business spec requires per-tenant, per-stage model selection, so these
  become per-tenant settings resolved at dispatch and passed through the stage
  payload; the env values remain only as platform defaults.
- Per-user provider keys are stored encrypted (AES-256-GCM envelopes keyed by
  `SECRETS_ENCRYPTION_KEY`, `api/src/crypto.ts`) in `user_integrations`, saved
  and read through `api/src/store.ts`, and resolved IDOR-safely per run through
  `/internal/integrations/resolve` with `review_run_id`
  (`resolveIntegrationKeysForRun`). The dashboard only ever sees
  configured/last4. Keys are per GitHub user, which matches the spec's
  "own-harness applies at the individual level".
- `trigger/src/review/provider-keys.ts` currently swallows any resolution
  failure and falls back to env keys. That behavior must change under billing
  (see Key Resolution below).
- Trigger already posts all review lifecycle data to the API with
  `INTERNAL_API_TOKEN` (`postInternal`), so Autumn and database secrets never
  enter Daytona.
- The stale comment in `migrations/0004_user_integrations.sql` claiming keys
  are "stored as-is for the MVP" predates the encryption work; the new
  migration should correct it.

## Business Spec (Pricing and Plans)

Source: private billing spec, received 2026-07-08. This section is the
canonical summary; the numbers below drive the Autumn config and the platform
defaults.

### Plans

| Plan | Monthly price | Included Jina Credits | Managed PR reviews | Own-harness PR reviews | ICP |
| --- | --- | --- | --- | --- | --- |
| Startup | $100/mo | 10,000 credits/mo | ~5–40 | up to 100 | ≤5-engineer startups |
| Growth | $500/mo | 50,000 credits/mo | ~25–100 | up to 500 | higher PR volume |
| Enterprise | custom | custom | custom | custom | custom security/procurement |

### Credit math

- **$1 = 100 Jina Credits.** Credits apply at the **org level**.
- **Managed-AI run:**
  `credits = ceil(openrouter_cost_usd × customer_share × 100) + infra_credits`
  where `customer_share = 1 − subsidy_rate` (platform default subsidy 30%,
  so `customer_share = 0.70`) and `infra_credits = 100` ($1/run).
  Example: a $50 run → 0.70 × $50 × 100 + 100 = **3,600 credits**.
- **Own-harness run:** infra credits only (100 credits/run); AI cost is 0
  credits because the tenant pays their provider directly.
- **Overage credits** (purchased after the included balance is exhausted) are
  spent at different rates: infra **150** credits/review, managed AI cost
  passed through with **no subsidy** (`customer_share = 1.0`), own-harness AI
  still 0.

#### BYOK billing basis (the cost the credit math bills from)

The operator can attach an upstream BYOK key (e.g. their own OpenAI key) to the
**managed** OpenRouter account. On a BYOK route OpenRouter's `usage.cost` is only
its ~5% fee — the real model spend rides the upstream key and is reported
separately as `cost_details.upstream_inference_cost`, with `usage.is_byok: true`.
On a **non-BYOK** route `cost` is the full charge and `upstream_inference_cost`
merely mirrors it.

So the credit math bills from a conditional basis, persisted per usage row as
`billable_cost` (the `openrouter_cost_usd` in the formula above **is**
`billable_cost`):

```
billable_cost = is_byok ? (upstream_inference_cost + cost) : cost
```

The condition is load-bearing in both directions:

- Billing unconditionally on `cost` alone would **undercharge BYOK routes ~95%**
  (only the fee bills; the real model spend is invisible).
- Summing `upstream_inference_cost + cost` **unconditionally** would
  **double-charge non-BYOK routes**, because `upstream_inference_cost` there is
  just a mirror of `cost`.

`billable_cost` is computed **exactly** at persist time (string/decimal BigInt
arithmetic via `exactDecimalSum`, never float) and is the single source the
credit math reads. Pre-migration rows (null `billable_cost`) fall back to
`openrouter_cost`, which equals the non-BYOK basis. `openrouter_cost` keeps
meaning OpenRouter's own `cost` field and is retained purely for reconciliation
against the OpenRouter Activity export — it is **not** the billing basis on BYOK
routes. Worked example (default 30% subsidy): a BYOK row with a $0.05 fee and
$1.00 upstream → basis $1.05 → `ceil(1.05 × 0.70 × 100)` = **74** AI credits.

### Per-account iteration requirements (highest leverage)

The business explicitly needs to iterate on these quickly, per account,
without code deploys:

- Manually add accounts to a plan (self-serve contracts).
- Customize the managed-AI subsidy rate per account.
- Customize infra credits per run per account (discounts, oversized-monorepo
  premiums).
- Customize overage prices per account (e.g. dedicated runners).
- Stand up new tiers quickly (e.g. a cheap BYOH-only plan with no managed AI).

Consequence for the architecture: **Autumn holds plans, credit balances, and
events; Jina holds the rate variables.** Subsidy, infra rates, and overage
rates live in a Jina-owned per-tenant policy table with platform defaults, so
changing them is a row update, not an Autumn config resync. New tiers are new
Autumn plans in the repo-owned `autumn.config.ts`.

### Numbers noted but not canonical

The spec's discussion section floats a 75¢/run infra price, a volume-decay
infra curve, and $25–$800 tier ladders. The canonical tables say 100
credits/run included and 150 overage; the decay/discount ideas are covered by
the per-tenant `infra_credits_per_run` override rather than a pricing curve.
Treat them as future iteration, not launch scope.

## Product Decisions

OpenRouter becomes the only model gateway in the managed review path.
`OPENAI_API_KEY` should stop being the canonical runtime secret once this work
ships; keep a compatibility fallback only during migration.

The current dashboard does not yet expose the credential-management controls
described below: `/integrations` currently shows GitHub organization connections
only, and `/models` exposes `Codex` and `Jina managed` provider choices. Existing
backend routes and stored BYOK selections remain in place for compatibility; the
flows below describe the intended billing design rather than the current UI.

The intended dashboard flow lets users connect OpenRouter in two ways:

1. Preferred: dashboard "Connect OpenRouter" uses OAuth PKCE and stores the
   returned user-controlled OpenRouter API key.
2. Fallback: dashboard password field accepts a manually created OpenRouter API
   key.

A run's mode is decided at key resolution time, with precedence
**author harness > tenant OpenRouter key > managed**:

- **Codex harness (individual own-harness):** a user connects their
  ChatGPT-subscription Codex credentials (the content of `~/.codex/auth.json`
  from `codex login`) via the dashboard. Reviews for PRs THEY AUTHOR then run
  Codex natively on their subscription: no OpenRouter, no capture proxy
  (nothing to capture — subscription responses carry no billable cost).
  Harness runs may pick one subscription-compatible model
  (`codex_harness_model`, validated against a static compatible list; null =
  Codex default); per-stage OpenRouter model settings do not apply to them.
  The tenant is billed infra credits only. The auth blob is encrypted at
  rest, its token values are redacted from all sandbox output, and it is
  never returned by any API. Resolution is by PR-author login
  (`user_integrations.github_login`, stamped from the dashboard session on
  every save). This implements the business spec's "bring your own harness
  (apply at the individual level)".

Tenant membership (shipped after the harness): `tenant_members` is synced at
dashboard sign-in from the viewer's own OAuth token (`read:org` — no new
GitHub App permissions), mapping their org memberships and roles onto
existing tenants, plus an implicit admin row for their personal tenant.
OpenRouter keys are TENANT-scoped in `tenant_integrations` (org keys are
admin-managed; the old `user_integrations.github_user_id =
tenants.github_account_id` identity hack is retired); the Codex harness
stays individual. Dashboard billing, integrations, and model settings are
tenant-scoped behind a member/admin role check (members read, admins
write/top-up), with a tenant switcher in the UI. Provider-level BYOK
(OpenAI/Anthropic keys) intentionally lives on the customer's own OpenRouter
account, one level up — Jina holds only OpenRouter keys and harness
credentials.

- **Own-harness (BYOH):** a user key exists → the run uses that key, and the
  org is charged infra credits only. The current implementation treats a
  user-supplied OpenRouter key as "own harness"; the spec's broader BYOH
  vision (ChatGPT/Claude subscription harnesses) is future scope.
- **Managed:** no user key → the run uses the Jina-managed
  `OPENROUTER_API_KEY`, and the org is charged subsidized AI compute credits
  plus infra credits. Plans without managed AI access (`managed_ai_access`
  false) refuse managed runs instead of falling through.

Model selection is a tenant-facing product surface (spec User Story 1): the
dashboard exposes per-stage model choices — Planner, Investigation, Review —
which map to `RUNTIME_PLANNER_MODEL`, `RUNTIME_AGENT_MODEL`, and
`REVIEW_CODEX_MODEL` respectively (`RUNTIME_MENTAL_TRACE_MODEL` stays an
internal default for now). Any model OpenRouter serves is allowed (decided):
choices are validated against OpenRouter's public `/api/v1/models` catalog
(cached server-side), not a curated list. There is no `premium_models` gate:
cost control is inherent in the credit meter. Some models may work poorly
with Codex CLI's tool-calling; that surfaces as failed runs (which charge
nothing) rather than being pre-blocked.

Do not bill exact model dollars from catalog estimates. Persist the raw
OpenRouter usage payload and use its returned cost as the reconciliation
source. Credit charges are derived from that persisted exact cost.

Review trigger modes and the `@Jina review` comment trigger (spec User
Story 2) are a related but separate workstream from billing; they replace the
hardcoded `reviewTaskTriggerControl` allowlist eventually. This plan only
requires that whatever dispatch paths exist all pass through the same credit
gate.

### Key Resolution Is Fail-Closed

The current silent fallback in `resolveProviderKeys` (any error → env key) is
acceptable today but becomes a mischarging bug under billing: a BYOH tenant
whose key resolution hits a transient API error would silently run — and be
billed managed-AI credits — on the Jina-managed key.

New behavior:

- The resolve endpoint distinguishes "no key configured" from "resolution
  failed".
- No key configured → managed run with `key_source = 'managed'` (if the plan
  has managed AI access; otherwise block with a dashboard prompt).
- Resolution failed → fail the stage and let Trigger's retry machinery re-run
  it. Never fall through to the managed key on error.
- `key_source` is recorded per usage row from the key that was actually loaded
  into the sandbox, not re-derived later from tenant state.

## Billing Strategy

### Autumn model

Repo-owned `autumn.config.ts`:

| Feature | Autumn type | Unit | Purpose |
| --- | --- | --- | --- |
| `jina_credits` | consumable, monthly included | credit | The single org-level meter. Startup includes 10,000/mo, Growth 50,000/mo; Enterprise plans are custom. Overage credit purchases are top-ups on this feature. |
| `managed_ai_access` | boolean | flag | Whether the plan may run managed-AI reviews at all (off for BYOH-only tiers). |

Everything else — subsidy rate, infra credits per run, overage rates — is a
Jina-side variable (see `tenant_billing_policy` below), applied when Jina
computes how many credits to `track`. Autumn `check` answers "does this org
have credits and managed-AI access"; Jina decides how many credits an event
costs.

Payments run through the existing Stripe account: Autumn connects to it and
handles plan subscriptions, overage credit purchases, and invoices as Stripe
subscriptions/checkouts. Jina writes no Stripe code. `ensureCustomer(tenant)`
should pass the tenant's existing Stripe customer id when one exists so
billing history stays on a single Stripe customer.

Billing today is entirely manual — charges created by hand in Stripe, nothing
shown in the product. That workflow stays supported rather than replaced:

- **Migration:** each existing hand-billed customer is mapped to their tenant
  and attached to an Autumn plan manually (the spec's "add new accounts
  manually" flow doubles as the migration tool). Their Stripe customer id
  carries over; their history stays put.
- **Hand-charging remains a first-class path** for Enterprise/custom deals:
  attach the tenant to a custom Autumn plan without a Stripe subscription so
  entitlements (`jina_credits`, `managed_ai_access`) are enforced in-product,
  while the actual money is still collected by hand-created Stripe invoices.
  Autumn meters and gates; Stripe collection stays manual until self-serve
  matters for that account.
- Self-serve Stripe checkout (plan signup, overage top-ups) is additive for
  Startup/Growth — it does not need to exist before billing enforcement can
  ship.

### Gating

Enforcement lives in ONE place (decided, round-5 review): the
`/internal/reviews/prepare` gate, whose denial terminally completes the run
as blocked and surfaces a PR progress comment — so every blocked review is
visible where the developer is looking. The webhook dispatch gate
(`api/src/github.ts`) is advisory-only: it logs shadow/would-block decisions
(including the legacy `org_tenant_managed_only` telemetry event) but never drops a dispatch, because a
dispatch-time block would vanish without any PR-visible trace. This also
means comment triggers and scheduled scans added later inherit enforcement
for free by calling prepare.

Rules:

- Autumn does NOT auto-create customers on `check` (verified empirically —
  unknown customers 404). Every gate/settlement path bootstraps the customer
  via an idempotent, per-process-memoized `ensureCustomer` before checking or
  tracking.
- Balance (included + purchased prepaid top-ups) must be positive when prepare
  runs. An explicit zero or negative balance blocks even if Autumn's boolean
  decision is permissive: record a blocked review event, terminally complete
  the run as blocked (never leave it queued), and surface a dashboard prompt
  to buy more credits.
- `managed_ai_access` is checked for telemetry, but managed AI is the fallback;
  the prepaid `jina_credits` balance is the load-bearing access gate.
- A run's **rate mode** is fixed at prepare, resolved in the customer's favor:
  `included` when credits remain, else `overage`. An admitted positive-balance
  run keeps its pinned rate for the whole run, including any portion that
  overdraws the pool. Under `enforce=on`, a zero-balance run pins its billing
  metadata but is terminally blocked before review work begins.
- Managed AI cost is unknown until the run finishes, so a run may drive the
  balance negative. Overdraft is allowed (decided): the in-flight run
  completes and the debt settles from the next purchase or renewal; later
  reviews block at prepare whenever the balance is ≤ 0.

### What gets tracked

All tracking is server-side in the API against `jina_credits`. Charging is
**outcome-gated** (decided): failed and superseded runs charge no credits at
all — no infra, no AI. Jina eats the OpenRouter cost of failed runs; their
usage rows are still persisted for internal cost accounting, marked `waived`.

Enforcement-mode capture semantics (decided round-2, revised round-3):
**only usage from runs settled while `enforce=on` ever bills.** `off` (or a
missing Autumn secret) is telemetry-only — managed usage rows persist as
`not_billable`. `shadow` computes and persists the full would-be charges
(customer share, credit amounts, infra) for reconciliation but finalizes
them as `shadow_computed`, a terminal non-billable status the retry drain
never selects — flipping to `on` bills nothing retroactive. (Round-2 had
shadow accruing billable rows that drained after the flip; the round-3
review correctly called that surprise-charging of trial traffic and it was
reversed.) Runs still in flight across a shadow→on flip settle under
whatever mode is live at settlement time. Deterministic Autumn 4xx errors
(configuration bugs) still fail open but log `billing_config_error` at error
level so silent revenue loss is visible; malformed 2xx responses are
integration failures (retryable), never billing decisions.

The prepare-time balance gate applies equally to personal and Organization
tenants, and to managed, BYOK, and custom-harness runs. A confirmed exhausted
balance blocks the new run under `enforce=on`. The balance is not checked again
after admission: if the run consumes the final credits or overdraws the balance,
that in-flight run finishes and settles normally, while later reviews block.

1. **Infra credits — once per run.** Tracked when the run first transitions to
   terminal `completed` (`completeReviewRun` returned `updated: true`), at the
   run's rate mode (default 100 included / 150 overage, per-tenant
   overridable).
2. **AI compute credits — managed runs only, billed on successful completion.**
   Credit amounts are computed per usage row as rows arrive
   (`ai_credits = ceil(openrouter_cost × customer_share × 100)` at the run's
   rate mode) but held as `pending_outcome` while the run is live. On the
   first terminal `completed` transition they flip to billable and are
   tracked per row; on failure or supersession they flip to `waived`. Late
   rows (generation-stats backfills, delayed stage callbacks) bill on arrival
   if the run has already completed successfully and are waived otherwise.
3. **Own-harness runs** track infra credits only; usage rows are persisted for
   transparency with `ai_credits_charged = 0` and `billing_status =
   'not_billable'`.

Trigger retries (task `maxAttempts: 3`, per-stage retries) produce genuinely
new model usage; every attempt's usage is persisted, and all of it bills if
the run ultimately completes (the customer got one review; Jina's retry
overhead is a cost of reliability worth watching in reconciliation). Infra
stays at most one charge per run because it keys off the single terminal
completion.

### Idempotency

Every Autumn track call carries a stable event id:

- Infra: `infra:{review_run_id}`.
- AI compute: `ai:{review_run_id}:{dedupe_key}` where `dedupe_key` is the
  usage row's dedupe key (see Data Model).

If Autumn is down after OpenRouter has already charged, persist the usage
record with `billing_status = 'pending'` and retry from a scheduled job. Do
not lose the usage event, and do not charge twice.

Track calls are single-flight via a claim state: a row/run is atomically
transitioned `pending → tracking` (a conditional update that doubles as the
concurrency lock) before Autumn is called, then `tracking → billed` on
success or back to `pending` on failure. Stale `tracking` claims (a crash
between track and confirm) are re-tracked with the SAME event id and a
structured `possible_duplicate_charge` warning so ops can reconcile — if
Autumn honors `idempotency_key` this is exactly-once; if not, the warning
carries everything needed for a manual credit. Settlement also re-checks
`managed_ai_access` before billing managed rows; a mismatch (entitlement lost
between gate and run) waives the rows and emits `billing_entitlement_mismatch`
instead of charging.

## Data Model Changes

Extend `user_integrations` (and fix the stale "stored as-is" comment from
migration 0004 while touching it):

```sql
alter table user_integrations
  add column if not exists openrouter_api_key text,
  add column if not exists openrouter_key_source text,
  add column if not exists openrouter_key_label text,
  add column if not exists openrouter_connected_at timestamptz;
```

`openrouter_api_key` is encrypted with the same `SECRETS_ENCRYPTION_KEY` path
used by current provider keys (`encryptSecret` / `decryptSecret` in
`api/src/crypto.ts`). The API never returns the full key to the dashboard; it
returns configured state, source, label, and last four characters, matching
the existing `keyInfo` pattern.

Per-tenant billing policy — the fast-iteration surface the spec demands. An
absent row means platform defaults; an admin edits a row, no deploy, no Autumn
resync:

```sql
create table if not exists tenant_billing_policy (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  subsidy_rate numeric(5, 4) not null default 0.3000,
  infra_credits_per_run integer not null default 100,
  overage_infra_credits_per_run integer not null default 150,
  overage_subsidy_rate numeric(5, 4) not null default 0.0000,
  notes text,
  updated_at timestamptz not null default now()
);
```

Per-tenant, per-stage model selection (spec User Story 1):

```sql
create table if not exists tenant_model_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  planner_model text,
  investigation_model text,
  review_model text,
  updated_at timestamptz not null default now()
);
```

Values are validated against OpenRouter's model catalog on save; null means
platform default.

Exact usage storage:

```sql
create table if not exists review_llm_usage (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  review_run_id uuid not null references review_runs(id) on delete cascade,
  stage text not null,            -- 'summary' | 'runtime'; only runtime produces rows today
  operation text not null,        -- 'planner' | 'agent' | 'mental_trace' | future operations
  provider text not null default 'openrouter',
  key_source text not null,       -- 'user' | 'managed'
  sandbox_id text not null,
  request_seq integer not null,   -- proxy-assigned, monotonic per sandbox
  model text,
  generation_id text,
  dedupe_key text not null,       -- generation_id, or '{sandbox_id}:{request_seq}' when missing
  prompt_tokens bigint,
  completion_tokens bigint,
  total_tokens bigint,
  reasoning_tokens bigint,
  cached_tokens bigint,
  cache_write_tokens bigint,
  openrouter_cost numeric(18, 8),         -- OpenRouter's own `cost` field (reconciliation source)
  upstream_inference_cost numeric(18, 8),
  is_byok boolean not null default false, -- OpenRouter usage.is_byok (migration 0014)
  -- billable_cost = is_byok ? (upstream_inference_cost + cost) : cost. The single basis the credit
  -- math bills from; null on pre-0014 rows (falls back to openrouter_cost). Computed exactly in TS.
  billable_cost numeric(18, 8),
  customer_share numeric(5, 4),   -- 1 - subsidy applied to this row
  ai_credits_charged integer,     -- ceil(cost * customer_share * 100); 0 for own-harness
  raw_usage_json jsonb not null,
  raw_response_metadata_json jsonb,
  -- pending_outcome -> pending -> billed, or waived (failed/superseded runs);
  -- not_billable for own-harness AI rows
  billing_status text not null default 'pending_outcome',
  autumn_event_id text,
  recorded_at timestamptz not null default now(),
  billed_at timestamptz,
  unique (review_run_id, dedupe_key)
);

create index if not exists idx_review_llm_usage_run
  on review_llm_usage(review_run_id, recorded_at);
create index if not exists idx_review_llm_usage_pending
  on review_llm_usage(billing_status) where billing_status = 'pending';
```

Run-level billing summary (rate mode, the one-shot infra charge, and totals
for the dashboard):

```sql
create table if not exists review_run_billing (
  review_run_id uuid primary key references review_runs(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  rate_mode text not null,             -- 'included' | 'overage', fixed at dispatch
  key_source text not null,            -- 'user' | 'managed'
  infra_credits_charged integer,       -- null until terminal completion; 0 for failed/superseded
  ai_credits_charged_total integer not null default 0,
  infra_billing_status text not null default 'pending',
  infra_autumn_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Design notes:

- `operation` is the meaningful cost dimension, not `stage`: the summary stage
  makes no LLM calls, and the runtime stage runs three differently-priced
  operations. One `codex exec` invocation is agentic and can produce many
  generations, so expect multiple rows per operation.
- A plain unique constraint on a nullable `generation_id` would not dedupe
  replays (Postgres treats NULLs as distinct). `dedupe_key` is always non-null:
  the generation id when OpenRouter returned one, otherwise
  `{sandbox_id}:{request_seq}`. Sandboxes are unique per stage attempt, so
  retried stages record their genuinely new usage while replayed callbacks
  dedupe cleanly.
- `tenant_id`, `customer_share`, and credit amounts are populated server-side
  from the run row and the tenant policy, never trusted from the Trigger
  payload.
- Credits are integers, rounded up per row (`ceil`). Costs stay `numeric` in
  Postgres with string/decimal handling in TypeScript. Do not use JavaScript
  floating-point math for persisted or billed amounts beyond parsing for
  display.

## Review Runtime Changes

Keep the existing Daytona flow: two sandboxes per review (one per stage), one
foreground `npx tsx runner.ts` per phase. The changes are confined to the
runner, `codexEnv()`, the Codex invocation sites, and model plumbing.

### Codex configuration

The worker does not use a `config.toml`; it passes per-call flags. Extend the
existing `callCodexJson` / `callCodexText` argument lists in
`trigger/src/runtime-review/index.ts` with `-c` provider overrides:

```text
codex exec \
  --model <openrouter-slug> \
  -c model_reasoning_effort=<effort> \
  -c model_provider=openrouter \
  -c model_providers.openrouter.name=openrouter \
  -c model_providers.openrouter.base_url=http://127.0.0.1:<proxy-port>/api/v1 \
  -c model_providers.openrouter.env_key=OPENROUTER_API_KEY \
  ...
```

(If nested `-c` overrides prove awkward for a Codex version, the fallback is
for the runner to render `~/.codex/config.toml` itself — Codex TOML does not
interpolate environment variables, so the runner must substitute the proxy
port when writing the file. Pick one mechanism during implementation; do not
ship both.)

Model plumbing: stage payloads gain resolved per-tenant models. At dispatch
the API loads `tenant_model_settings`, falls back to platform defaults, and
the resolved slugs flow through `daytonaWorkerEnv` into the existing
`REVIEW_CODEX_MODEL` / `RUNTIME_*_MODEL` worker envs. The defaults in
`trigger/src/shared/utils.ts` are remapped to OpenRouter form
(`gpt-5.5` → `openai/gpt-5.5`, `gpt-5.4` → `openai/gpt-5.4`,
`gpt-5.4-mini` → `openai/gpt-5.4-mini`).

Auth: `codexEnv()` stops aliasing `OPENAI_API_KEY` into `CODEX_API_KEY` and
instead ensures `OPENROUTER_API_KEY` is present (resolved user key or managed
key). `createReviewSession` passes the OpenRouter key into the sandbox env and
adds it to the `collectSecrets` redaction list. During migration the
`JINA_LEGACY_OPENAI_KEYS` flag keeps the direct-OpenAI path alive; in that
mode the worker strips the `openai/` prefix from model slugs before invoking
Codex (OpenRouter-namespaced ids are invalid on the OpenAI API) and rejects
non-OpenAI slugs with a clear error. Tenant BYO-OpenAI keys are deprecated
outright — the dashboard tells affected tenants their stored key is inactive
and to connect OpenRouter.

### The capture proxy

The local base URL points at a tiny Jina OpenRouter capture proxy. Because the
sandbox has no service slot, the **runner owns the proxy lifecycle**: it spawns
the proxy as a background child process before phase work, waits for it to
listen, and flushes and stops it before writing the result file. One proxy and
one JSONL file per sandbox (i.e. per stage attempt).

Proxy responsibilities:

- Forward requests to `https://openrouter.ai/api/v1`, streaming responses
  through unchanged.
- Pass through the `Authorization` header Codex sends; inject
  `Bearer $OPENROUTER_API_KEY` only if absent.
- Set OpenRouter app attribution headers for Jina.
- Inject `usage: { include: true }` into JSON request bodies (defensive; see
  Vendor Facts).
- Add a stable `user` parameter to JSON bodies, using an internal id such as
  `tenant_${tenant_id}` or `review_${review_run_id}` — never PII.
- Tag every recorded line with `operation` (the runner tells the proxy the
  current operation, e.g. via a header set per Codex invocation or a
  per-operation proxy port path) and a monotonic `request_seq`.
- For non-streaming JSON, record `id`, `model`, and `usage`.
- For streaming SSE, pass chunks through while extracting the final usage
  chunk.
- On missing usage, record the line anyway (null `generation_id` tolerated —
  the dedupe key falls back to `{sandbox_id}:{request_seq}`) and mark it for a
  generation-stats retry by `id` when an id exists.
- Redact API keys from stdout, errors, and worker result payloads.

The runner reads the JSONL and embeds `usage_records` (with `sandbox_id`) in
the Daytona result file. Trigger posts those records to the API. The API
persists the records, computes credit amounts from the tenant policy, and
performs Autumn tracking server-side so Autumn secrets and rate variables
never enter Daytona.

### Usage persistence failure contract

Usage records do **not** ride the existing review-event endpoint semantics:
`recordReviewEvent` deliberately swallows secondary persist failures so a
broken persist cannot break the review pipeline. For billing data that policy
means silently lost revenue.

Instead, Trigger posts usage to a dedicated endpoint
(`POST /internal/reviews/:reviewRunId/usage`) that:

- Persists all records in one transaction, deduped by
  `(review_run_id, dedupe_key)` via `on conflict do nothing`.
- Returns 5xx on persist failure so Trigger's retry machinery re-posts.
  Replays are safe because of the dedupe key.
- Never blocks review completion: the stage posts usage after its review event,
  and a usage-post failure fails the Trigger attempt (retried) rather than the
  user-visible review, which has already published.

## API And Dashboard Changes

Dashboard:

- Replace the current OpenAI/Anthropic-specific integrations UI
  (`dashboard/app/integrations/page.tsx`) with an OpenRouter integration card.
  The Anthropic key field is already dead weight — the runtime only consumes
  the OpenAI key today.
- Add "Connect OpenRouter" for PKCE; keep "Paste API key" as an
  advanced/manual fallback. Show configured state, source, last four
  characters, and a disconnect button.
- Add per-stage model selection (Planner / Investigation / Review) with a
  searchable picker over OpenRouter's model catalog, per spec User Story 1.
- Show the org credit balance, included vs purchased breakdown, and a "buy
  overage credits" flow backed by Autumn top-ups (Stripe checkout under the
  hood — no Jina-side payment UI beyond the redirect).
- Add per-review credit totals (infra + AI, per operation) to review detail
  pages once usage exists.

API:

- Add OpenRouter OAuth state creation and callback handling. Hardened
  (round-2 review): the verifier cookie is a signed binding of
  { code_verifier, github_user_id, nonce } and the callback verifies the
  active session matches the initiating user; in production the callback URL
  requires the configured API base URL (no Host-header fallback).
- Save manual OpenRouter API keys through `/v1/dashboard/integrations`.
- Add model-settings read/save endpoints validating against the allowlist.
- Extend `/internal/integrations/resolve` (and `ProviderKeys` in
  `trigger/src/daytona/review-session.ts`) with `openrouter_api_key` and an
  explicit configured/failed distinction for the fail-closed behavior above.
- Add `POST /internal/reviews/:reviewRunId/usage` per the failure contract
  above.
- Dashboard billing endpoints: `GET /v1/dashboard/billing` returns
  `{ status: "ok" | "unavailable" | "not_configured", configured, plan_id,
  credits_balance, managed_ai_access }` — `unavailable` (Autumn errored) must
  render differently from `not_configured` (never onboarded) so an outage is
  never mistaken for a missing account. `POST /v1/dashboard/billing/topup`
  returns the Autumn/Stripe checkout url.
- Add an internal admin surface (protected, ops-only) for the platform
  requirements: attach a tenant to a plan, edit `tenant_billing_policy`
  fields. Manual for launch; no self-serve plan management needed yet.
- Add an Autumn/billing service module with:
  - `ensureCustomer(tenant)`
  - `checkReviewAccess(tenant, keySource)` — balance + `managed_ai_access`
  - `chargeInfra(reviewRun)` — called from the completion path only when
    `completeReviewRun` reports the first terminal `completed` transition
  - `chargeAiUsage(reviewRun, usageRecord)` — credit math from
    `tenant_billing_policy` + rate mode
  - `retryPendingBillingEvents()` — drains `billing_status = 'pending'`
    rows, stale `tracking` claims, and unbilled infra charges; invoked every
    15 minutes by the Trigger scheduled task `billing-retry` (and available
    manually via `POST /internal/billing/retry`). The drain re-checks
    `managed_ai_access` per run before billing managed rows, and the usage
    endpoint settles late-arriving rows immediately when their run is
    already terminal.

Environment:

```text
OPENROUTER_API_KEY=
OPENROUTER_APP_URL=
OPENROUTER_APP_TITLE=Jina Code Review
AUTUMN_SECRET_KEY=
AUTUMN_API_URL=
AUTUMN_CREDITS_FEATURE_ID=jina_credits
AUTUMN_MANAGED_AI_FEATURE_ID=managed_ai_access
```

Keep the environment list small. Plan definitions and included-credit amounts
belong in `autumn.config.ts`; subsidy and infra rates belong in
`tenant_billing_policy` with code-level platform defaults. Nothing about
pricing lives in env vars beyond the two feature ids (a pragmatic exception so
staging and production Autumn sandboxes can diverge without code changes).

## Rollout Plan

The existing staged allowlist (`reviewTaskTriggerControl` in
`api/src/review-task-routing.ts`) is the staging mechanism for steps 4–6: run
the new path only for the allowed repository before widening.

1. Add `autumn.config.ts` with the Startup/Growth plans, `jina_credits`
   included amounts, overage top-ups, and `managed_ai_access` — in Autumn test
   mode connected to the existing Stripe test account.
2. Add migrations: OpenRouter credentials, `tenant_billing_policy`,
   `tenant_model_settings`, `review_llm_usage`, `review_run_billing`.
3. Build dashboard OpenRouter PKCE plus manual-key fallback, and the model
   selection settings.
4. Add the sandbox OpenRouter proxy, the runner lifecycle, and the Codex `-c`
   provider overrides; keep the old env path behind a compatibility flag.
5. Persist usage records and compute credit amounts without tracking to Autumn
   for a staging period (allowlisted repository only).
6. Compare persisted totals against OpenRouter Activity for several test runs;
   confirm cost fields arrive without the deprecated usage flags; hand-check
   the credit math against the spec's example table (e.g. a ~$27.50 GPT-5.5
   run at 30% subsidy must come out to ~2,025 credits).
7. Enable Autumn `check` gating in shadow mode, then hard-block only after
   product copy and the buy-credits dashboard flow exist. Before flipping to
   hard enforcement, audit tenants with stored OpenAI/Anthropic keys and
   notify them their reviews now run on the managed OpenRouter key (billable)
   unless they connect OpenRouter.
8. Enable infra-credit tracking.
9. Enable managed AI-credit tracking.
10. Remove OpenAI/Anthropic dashboard copy, the `codexEnv()` compatibility
    branch, and old canonical env docs after all deployed workers use
    OpenRouter.

## Verification

Before production billing:

- OpenRouter OAuth PKCE stores an encrypted key and never logs it.
- Manual OpenRouter key save, clear, and reconnect work.
- A tenant with no user key runs managed with `key_source = 'managed'`; a
  BYOH-only plan (no `managed_ai_access`) is blocked instead.
- A tenant with a user key uses only that key and is charged infra credits
  only; a forced resolve failure fails the stage instead of silently billing
  managed AI credits.
- Every Codex request produces one usage record; missing-usage responses still
  produce a row with a synthetic dedupe key and a generation-stats retry
  marker.
- Streaming and non-streaming responses both produce token and cost records.
- Usage rows carry the correct `operation` (planner/agent/mental_trace) and
  the model selected in tenant settings for that stage.
- Credit math matches the spec examples: managed run credits =
  `ceil(cost × 0.70 × 100) + 100` at defaults; a tenant with a custom
  `subsidy_rate` or `infra_credits_per_run` bills at the overridden rates
  after a policy-row update with no deploy.
- Rate mode: a run admitted while credits remain bills entirely at its pinned
  rate even when it overdraws the pool; balance ≤ 0 blocks later reviews at
  prepare but does not kill in-flight runs.
- Local usage totals match OpenRouter Activity for the same key and time range.
- Exactly one infra charge per run that completes successfully; failed and
  superseded runs charge no credits at all, and their usage rows end up
  `waived`.
- A stage retried by Trigger records each attempt's real usage exactly once
  (distinct sandbox ids), and replaying a Trigger callback duplicates neither
  local usage rows nor Autumn events.
- AI-credit events exist only for managed-key usage.
- A forced usage-endpoint persist failure causes a Trigger retry and eventual
  persistence — never a silent drop.
- If Autumn is unavailable, review completion still persists usage and leaves
  billing events pending; `retryPendingBillingEvents()` drains them.

## Decided

- Rate mode is fixed at dispatch and resolved generously: any included credits
  remaining → the whole run bills at included rates, even past the pool.
- Overdraft is allowed: in-flight runs complete into a negative balance; new
  dispatches block at ≤ 0.
- Failed and superseded runs charge no credits at all; Jina absorbs their
  OpenRouter cost and the usage rows are waived.
- A run whose model calls ALL failed completes as **`failed`**, not `completed`:
  the runtime stage still publishes the degraded review to the PR, but reports
  `failed` so settlement waives infra + every AI row end-to-end (charge nothing).
  A published review never implies a billable `completed` — the API bills off the
  reported run status, not the presence of a review comment.

## Open Questions

- Confirm whether OpenRouter `usage.cost` should be treated as USD directly or
  as OpenRouter credits that map 1:1 to USD. Until verified in staging, store
  the raw returned value and reconcile against Activity export before charging.
- Confirm the deployed Codex version accepts nested `-c model_providers.*`
  overrides; otherwise switch to the runner-rendered `config.toml` fallback.
- Enterprise plan mechanics (custom included credits, custom rates) are
  covered structurally by `tenant_billing_policy` + a custom Autumn plan with
  hand-created Stripe invoices, matching how billing is done today.
- Mapping existing hand-billed Stripe customers to tenants is a manual
  one-time exercise (they were created ad hoc, so identifiers may not line up
  with GitHub orgs); do it during Autumn onboarding before enabling gating
  for those accounts.
- The spec's BYOH discussion mentions individual-level own-harness accounts
  (ChatGPT/Claude subscription harnesses). Current scope implements
  OpenRouter-key BYOH only, keyed per GitHub user
  (`user_integrations.github_user_id = tenants.github_account_id`, documented
  in `api/src/store.ts`); org installations still need tenant membership
  before per-member keys and model settings work for org-owned repos.
  Tenant membership now ships this: org admins connect org OpenRouter keys,
  members see org billing, and model settings are tenant-scoped. Organization
  tenants now use the same exhausted-balance prepare gate as personal tenants.
- Trigger modes and `@Jina review` comment triggers (spec User Story 2) are a
  separate workstream; this plan only requires every dispatch path to pass the
  same credit gate.

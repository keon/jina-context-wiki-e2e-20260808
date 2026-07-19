# Billing: OpenRouter + Autumn + Jina Credits

> **Implementation status (2026-07-19):** This is a target billing and usage-accounting design. The local review CLI can report provider usage, but the deployed Cloud Run worker does not yet persist normalized model-usage rows, enforce Autumn credits, or run an OpenRouter capture proxy. Do not treat the schemas or rollout steps below as deployed controls.

Strategy source: `jina-code-review/docs/BILLING_OPENROUTER_AUTUMN.md` (2026-07-08). This document adapts that strategy to this codebase's board/pipeline model. The vendor facts, plan tables, and credit math there are canonical; this file defines how they map onto tasks, runs, gates, and epochs here.

## Strategy summary

- **OpenRouter is the managed model gateway.** All managed-path model calls go through OpenRouter (OpenAI-compatible, `https://openrouter.ai/api/v1`). Responses include exact usage and cost; that returned cost — persisted raw — is the billing source of truth, never catalog estimates.
- **Autumn is the billing and entitlement layer** on top of the existing Stripe account. Autumn holds plans, the org-level `jina_credits` balance (included monthly + purchased overage top-ups), and the `managed_ai_access` flag. Runtime access is `check`; usage is `track`. Jina writes no Stripe code; hand-created Stripe invoices remain a first-class path for enterprise/custom deals.
- **Jina holds the rate variables.** Subsidy rate, infra credits per run, and overage rates live in `tenant_billing_policy` with platform defaults — changing a tenant's economics is a row update, not an Autumn resync or deploy.

## Credit math

`$1 = 100 Jina Credits`, metered at the org level.

| Run mode | AI credits | Infra credits |
| --- | --- | --- |
| Managed (Jina's OpenRouter key) | `ceil(cost_usd × customer_share × 100)` | 100 included / 150 overage |
| Own-harness (tenant's key) | 0 — tenant pays their provider directly | 100 included / 150 overage |

`customer_share = 1 − subsidy_rate` (default subsidy 30% → share 0.70) at included rates; no subsidy (`share = 1.0`) at overage rates. Example: a $50 managed run at defaults → `0.70 × $50 × 100 + 100 = 3,600 credits`.

These formulas are implemented in `packages/policy/src/billing-policy.ts`; the per-tenant overrides are rows in `tenant_billing_policy` (see DATA_MODELS.md).

## Run modes and fail-closed key resolution

A run's mode is decided at key resolution time, and errors never widen access:

- **Own-harness:** the tenant has a connected OpenRouter key (OAuth PKCE preferred, pasted key as fallback; encrypted at rest, never returned to the dashboard beyond configured/last4) → the run uses that key, `key_source = 'user'`, infra credits only.
- **Managed:** no tenant key → the run uses the Jina-managed key, `key_source = 'managed'`, requires `managed_ai_access` on the plan.
- **Resolution failure ≠ no key.** A failed resolution fails the run attempt (retried by the scheduler); it never falls through to the managed key — that would silently bill a BYOK tenant managed-AI credits.
- `key_source` is recorded on each usage row from the key actually used, never re-derived from tenant state later.

Model selection is tenant-facing: any model OpenRouter serves is allowed, validated against the cached `/api/v1/models` catalog rather than a curated list. Cost control is the credit meter, not a model gate. Per-stage model choice lives on `review_profiles.config` (profiles are already per-tenant).

## Where billing hooks into the board

The pipeline stays exactly as designed; billing attaches at four existing seams:

1. **Gate at dispatch (command guard).** Before the webhook ingest plans a new epoch's tasks, an Autumn `check` runs as a command guard alongside the existing budget guards: balance must cover at least the run's infra credits, and managed runs require `managed_ai_access`. A blocked dispatch records a `command.rejected` event (`reason: credits_exhausted`) and a `gate_results` row — same shape as budget rejection today. The run's **rate mode** is fixed here, resolved in the customer's favor: any included credits remaining → the whole run bills at included rates, even if it overdraws. Run-start currency checks re-verify as a backstop for dispatch paths that skip the primary gate.
2. **Usage rows during runs.** Every model call a run makes produces a `model_usage` row (tokens, raw usage payload, OpenRouter cost, generation id, `key_source`, harness type, operation). Rows are deduped by `(task_run_id, dedupe_key)` where `dedupe_key` is the generation id or a synthetic `{run}:{seq}` fallback — retried attempts record their genuinely new usage; replayed callbacks dedupe cleanly. Credit amounts are computed per row on arrival but held as `pending_outcome` while the run is live. Usage persistence is fail-loud: a failed persist fails the run attempt (retried), never a silent drop.
3. **Charge on outcome.** Charging is outcome-gated: when the root `pr_review` task first transitions to `done` for its epoch (the aggregate completion the reducer already computes), infra credits are tracked once (`infra:{root_task_id}` as the idempotent Autumn event id) and the epoch's `pending_outcome` usage rows flip to billable (`ai:{root_task_id}:{dedupe_key}`). Failed or superseded epochs charge **nothing** — no infra, no AI; their usage rows flip to `waived` and Jina absorbs the OpenRouter cost. Supersession is already epoch-wide, so waiving is a status update on the epoch's rows.
4. **Overdraft + retry.** Managed AI cost is unknown until a run finishes, so a run may drive the balance negative; in-flight runs complete, new dispatches block at ≤ 0. If Autumn is down after cost was incurred, rows sit at `billing_status = 'pending'` and a scheduled job drains them — usage is never lost and never double-tracked (stable event ids).

## Observability and transparency

Billing transparency is a special case of the general rule (see ARCHITECTURE.md → Observability): **everything a run did must be reconstructible from the board.**

- Every step a harness takes (model call, tool action, decision) is a `run.step` task event on the task's timeline, with seq, timestamps, and step payload.
- Every model call has a `model_usage` row with exact tokens, cost, model, and provenance (harness type, operation, key source, generation id) — the same rows that drive billing drive the per-run cost breakdown in the dashboard.
- The dashboard shows per-run credit totals (infra + AI, per operation), the org balance with included vs purchased breakdown, and a buy-overage flow backed by Autumn top-ups.
- Reconciliation: persisted usage totals are compared against OpenRouter Activity before billing enforcement ships; audits use the generation-stats endpoint by generation id.

## Multiple models, multiple harnesses

A **harness** is the executable strategy a run uses: which model(s), which prompts/tools, how steps are orchestrated. There is no direct provider SDK path — model access goes through OpenRouter (any catalog model, including Claude via `anthropic/*` slugs). The registry lives in `packages/ai`:

- `openrouter-chat` — OpenAI-compatible chat completion through OpenRouter with `usage: {include: true}` injected, a stable non-PII `user` field, and exact cost capture. The default harness.
- `codex-cli` — Codex CLI `exec` with a JSON output schema, pointed at OpenRouter as its model provider when a key is present. In production its calls go through the capture proxy for exact cost; step events come from the Codex event stream.
- Future: multi-pass harnesses, grounding harnesses, other CLI-driven agents behind the capture proxy.

All harnesses return the same shape — summary, findings, ordered steps, usage records — so the board, billing, and observability layers are harness-agnostic. `harness_versions` records which harness type + version + model policy a run used, so outcomes are comparable across harnesses over time.

## Rollout shape

Same staging discipline as the source doc: persist usage without tracking first; reconcile against OpenRouter Activity; enable `check` gating in shadow mode; then enable infra tracking, then AI tracking. Nothing about pricing lives in env vars beyond the two Autumn feature ids; plans live in repo-owned `autumn.config.ts`, rates in `tenant_billing_policy`.

## Deferred (per the introduce-when-needed rule)

- The Autumn client module, OAuth PKCE flow, and the capture proxy are built when the hosted runtime exists — the domain seams (guards, gates, usage rows, outcome-gated status flips) are designed now so they slot in without rework.
- Broader BYOH (ChatGPT/Claude subscription harnesses) is future scope; OpenRouter-key BYOH is the launch shape.

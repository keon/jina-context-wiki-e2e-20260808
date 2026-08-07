-- OpenRouter credentials + Autumn billing data model (Phase 1A).
-- Adds per-user OpenRouter key storage, per-tenant billing policy and model
-- selection, exact per-request LLM usage capture, and a per-run billing summary.

-- Per-user OpenRouter credentials, connected via OAuth PKCE or a manually pasted
-- key. NOTE: unlike the stale claim in 0004 ("stored as-is for the MVP"), all
-- provider keys in user_integrations are encrypted at rest as AES-256-GCM
-- envelopes keyed by SECRETS_ENCRYPTION_KEY (see api/src/crypto.ts). The API only
-- ever returns configured state, source, label, and last four characters.
alter table user_integrations
    add column if not exists openrouter_api_key text,
    add column if not exists openrouter_key_source text,   -- 'oauth' | 'manual'
    add column if not exists openrouter_key_label text,
    add column if not exists openrouter_connected_at timestamptz;

-- Per-tenant billing policy — the fast-iteration surface the business spec
-- demands. An absent row means platform defaults; an admin edits a row with no
-- deploy and no Autumn resync.
create table if not exists tenant_billing_policy (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    subsidy_rate numeric(5, 4) not null default 0.3000,
    infra_credits_per_run integer not null default 100,
    overage_infra_credits_per_run integer not null default 150,
    overage_subsidy_rate numeric(5, 4) not null default 0.0000,
    notes text,
    updated_at timestamptz not null default now()
);

-- Per-tenant, per-stage model selection (spec User Story 1). Values are validated
-- against OpenRouter's model catalog on save; null means the platform default.
create table if not exists tenant_model_settings (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    planner_model text,
    investigation_model text,
    review_model text,
    updated_at timestamptz not null default now()
);

-- Exact per-request LLM usage capture. One codex exec invocation is agentic and
-- can produce many generations, so expect multiple rows per operation. tenant_id,
-- customer_share, and credit amounts are populated server-side from the run row
-- and the tenant policy, never trusted from the Trigger payload.
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
    openrouter_cost numeric(18, 8),
    upstream_inference_cost numeric(18, 8),
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

-- Run-level billing summary: rate mode, the one-shot infra charge, and totals for
-- the dashboard.
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

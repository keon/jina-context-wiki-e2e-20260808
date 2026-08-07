-- BYOK-aware billing basis for review_llm_usage.
--
-- The managed OpenRouter account can carry a BYOK upstream key (e.g. the operator's own
-- OpenAI key). On a BYOK route OpenRouter's `cost` field is ONLY its ~5% fee; the real model
-- spend lands on the upstream key and is reported separately as
-- `cost_details.upstream_inference_cost` (with `usage.is_byok = true`). On a NON-BYOK route
-- `cost` is the full charge and upstream_inference_cost merely mirrors it.
--
-- `billable_cost` is the SINGLE source the credit math bills from:
--     billable_cost = is_byok ? (upstream_inference_cost + cost) : cost
-- Computed EXACTLY in TypeScript (string/decimal arithmetic, never float) and stored here.
-- Billing unconditionally on `cost` would UNDERCHARGE BYOK routes ~95%; summing both
-- unconditionally would DOUBLE-charge non-BYOK routes — hence the conditional basis.
--
-- `openrouter_cost` keeps its existing meaning: OpenRouter's own `cost` field, retained for
-- reconciliation against OpenRouter's Activity export.
--
-- Pre-migration rows have a NULL billable_cost; the credit math falls back to openrouter_cost
-- for those, so this is a safe additive change.
alter table review_llm_usage
    add column if not exists is_byok boolean not null default false,
    add column if not exists billable_cost numeric(18, 8);

comment on column review_llm_usage.billable_cost is
    'The single basis the credit math bills from: is_byok ? (upstream_inference_cost + cost) : cost. Computed exactly in TS. NULL for pre-0014 rows (credit math falls back to openrouter_cost).';
comment on column review_llm_usage.is_byok is
    'True when OpenRouter reported usage.is_byok (upstream BYOK key): cost is only the OpenRouter fee and the real model spend is in upstream_inference_cost.';
comment on column review_llm_usage.openrouter_cost is
    'OpenRouter''s own `cost` field, retained for reconciliation against the OpenRouter Activity export. Not the billing basis on BYOK routes — see billable_cost.';

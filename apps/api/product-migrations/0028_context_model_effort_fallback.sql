alter table tenant_model_settings
  add column if not exists context_model text,
  add column if not exists planner_effort text,
  add column if not exists investigation_effort text,
  add column if not exists review_effort text,
  add column if not exists context_effort text,
  add column if not exists context_harness_owner_user_id uuid references users(id) on delete set null,
  add column if not exists review_fallback_policy text not null default 'fail_notify',
  add column if not exists context_fallback_policy text not null default 'fail_notify';

alter table tenant_model_settings
  add constraint tenant_model_settings_planner_effort_check
    check (planner_effort is null or planner_effort in ('low', 'medium', 'high')),
  add constraint tenant_model_settings_investigation_effort_check
    check (investigation_effort is null or investigation_effort in ('low', 'medium', 'high')),
  add constraint tenant_model_settings_review_effort_check
    check (review_effort is null or review_effort in ('low', 'medium', 'high')),
  add constraint tenant_model_settings_context_effort_check
    check (context_effort is null or context_effort in ('low', 'medium', 'high')),
  add constraint tenant_model_settings_review_fallback_policy_check
    check (review_fallback_policy in ('fail_notify', 'managed')),
  add constraint tenant_model_settings_context_fallback_policy_check
    check (context_fallback_policy in ('fail_notify', 'managed'));

create table if not exists context_execution_profiles (
  tenant_id uuid not null references tenants(id) on delete cascade,
  build_id text not null,
  settings jsonb not null,
  credential_kind text not null check (credential_kind in ('managed', 'openai', 'openrouter', 'codex', 'unavailable')),
  encrypted_credential text,
  credential_revision text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, build_id),
  check (
    (credential_kind in ('managed', 'unavailable') and encrypted_credential is null) or
    (credential_kind in ('openai', 'openrouter', 'codex') and encrypted_credential is not null)
  )
);

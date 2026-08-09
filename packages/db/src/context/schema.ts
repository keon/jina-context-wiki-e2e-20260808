/**
 * Current Context schema.
 *
 * The Board workflow validates evidence and knowledge before publication. PostgreSQL
 * therefore stores one immutable, query-ready catalog per release instead of a second
 * ingestion, derivation, projector, and query-materialization pipeline.
 */
export const CONTEXT_SCHEMA_SQL = `
create schema if not exists jina_context;

create or replace function jina_context.reject_immutable_change()
returns trigger
language plpgsql
as $immutable$
begin
  raise exception using
    errcode = '55000',
    message = format('%I.%I is append-only', tg_table_schema, tg_table_name);
end
$immutable$;

create table if not exists jina_context.repositories (
  tenant_id text not null,
  repository text not null,
  default_ref text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id,repository)
);

create table if not exists jina_context.repository_access (
  tenant_id text not null,
  repository text not null,
  principal_id text not null,
  permission text not null check (permission in ('read','write','admin','denied')),
  acl_fingerprint text not null check (acl_fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null,
  primary key (tenant_id,repository,principal_id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository) on delete cascade
);
create index if not exists context_repository_access_principal
  on jina_context.repository_access (tenant_id,principal_id,repository)
  where permission in ('read','write','admin');

-- Immutable binary objects used by the Trigger wiki pipeline. Object keys use
-- the same canonical tenant/repository paths as the filesystem and GCS ports;
-- generation is an opaque positive decimal identity bound into every ref URI.
create table if not exists jina_context.context_wiki_artifacts (
  tenant_id text not null,
  repository text not null,
  object_key text not null check (octet_length(object_key) between 1 and 4096),
  object_generation bigint generated always as identity,
  artifact_class text not null check (
    artifact_class in ('context-artifact','wiki-content','wiki-audit-report')
  ),
  content_type text not null check (octet_length(content_type) between 1 and 255),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_length integer not null check (content_length between 0 and 536870912),
  content_metadata jsonb not null check (
    jsonb_typeof(content_metadata)='object'
    and octet_length(content_metadata::text) <= 16384
  ),
  content_bytes bytea not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id,object_key),
  unique (object_generation),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  check (object_generation > 0),
  check (octet_length(content_bytes)=content_length)
);
create index if not exists context_wiki_artifacts_repository
  on jina_context.context_wiki_artifacts (tenant_id,repository,object_generation);

create table if not exists jina_context.context_evidence_snapshots (
  checkpoint_id text primary key,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  ref_sequence bigint not null check (ref_sequence > 0),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null,
  created_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,ref_name,ref_sequence)
);
create index if not exists context_evidence_snapshots_latest
  on jina_context.context_evidence_snapshots
  (tenant_id,repository,ref_name,ref_sequence desc,checkpoint_id);

create table if not exists jina_context.context_releases (
  release_id text primary key check (release_id ~ '^cr_[0-9a-f]{32}$'),
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  ref_sequence bigint not null check (ref_sequence > 0),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  build_id text not null,
  checkpoint_id text not null,
  idempotency_key text not null,
  publication_input_digest text not null check (publication_input_digest ~ '^[0-9a-f]{64}$'),
  public_snapshot_digest text not null check (public_snapshot_digest ~ '^[0-9a-f]{64}$'),
  certification_artifact jsonb not null,
  publication_plan_artifact jsonb not null,
  release_artifact jsonb not null,
  catalog jsonb not null,
  page_count integer not null check (page_count > 0),
  pageindex_idempotency_key text,
  pageindex_attachment_input_digest text
    check (pageindex_attachment_input_digest ~ '^[0-9a-f]{64}$'),
  pageindex_artifact jsonb,
  pageindex_metadata jsonb,
  pageindex_attached_at timestamptz,
  prepared_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,idempotency_key),
  unique (tenant_id,repository,ref_name,ref_sequence),
  unique (tenant_id,repository,publication_input_digest),
  check (
    (
      pageindex_idempotency_key is null
      and pageindex_attachment_input_digest is null
      and pageindex_artifact is null
      and pageindex_metadata is null
      and pageindex_attached_at is null
    ) or (
      pageindex_idempotency_key is not null
      and pageindex_attachment_input_digest ~ '^[0-9a-f]{64}$'
      and pageindex_artifact is not null
      and pageindex_metadata is not null
      and pageindex_attached_at is not null
    )
  )
);
create unique index if not exists context_releases_pageindex_idempotency
  on jina_context.context_releases (tenant_id,pageindex_idempotency_key)
  where pageindex_idempotency_key is not null;
create index if not exists context_releases_scope
  on jina_context.context_releases
  (tenant_id,repository,ref_name,ref_sequence desc,release_id)
  where pageindex_attached_at is not null;

-- Trigger-owned wiki V2 releases are stored separately from the compact
-- Board-era release catalog. This preserves the current catalog architecture
-- while giving Trigger immutable branch/PR/commit and locale identities.
create table if not exists jina_context.context_wiki_projections (
  release_id text primary key check (release_id ~ '^cr_[0-9a-f]{32}$'),
  tenant_id text not null,
  repository text not null,
  projection_input_digest text not null check (projection_input_digest ~ '^[0-9a-f]{64}$'),
  catalog jsonb not null,
  document_count integer not null check (document_count > 0),
  fragment_count integer not null check (fragment_count > 0),
  exact_entry_count integer not null check (exact_entry_count > 0),
  hierarchy_node_count integer not null check (hierarchy_node_count > 0),
  created_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,release_id)
);

create table if not exists jina_context.context_board_publications (
  release_id text primary key check (release_id ~ '^cr_[0-9a-f]{32}$'),
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  ref_sequence bigint check (ref_sequence > 0),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  build_id text not null,
  checkpoint_id text not null,
  idempotency_key text not null,
  publication_input_digest text not null check (publication_input_digest ~ '^[0-9a-f]{64}$'),
  public_snapshot_digest text not null check (public_snapshot_digest ~ '^[0-9a-f]{64}$'),
  certification_artifact jsonb,
  publication_plan_artifact jsonb,
  release_artifact jsonb not null,
  catalog jsonb not null,
  page_count integer not null check (page_count > 0),
  published_at timestamptz,
  artifact_version smallint not null default 2 check (artifact_version=2),
  orchestrator text not null default 'trigger' check (orchestrator='trigger'),
  pipeline_version text not null,
  trigger_parent_run_id text not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  scope_kind text not null check (scope_kind in ('branch','pull_request','commit')),
  scope_key text not null,
  base_commit_sha text check (base_commit_sha is null or base_commit_sha ~ '^[0-9a-f]{40}$'),
  parent_release_id text,
  release_family_id text not null,
  source_release_id text,
  source_locale text,
  generation_reason text not null check (
    generation_reason in ('initial','source_update','daily_audit_fix','manual_refresh','translation')
  ),
  instruction_digest text not null check (instruction_digest ~ '^[0-9a-f]{64}$'),
  exclusion_policy_digest text not null check (exclusion_policy_digest ~ '^[0-9a-f]{64}$'),
  generator_policy_version text not null,
  finalizer_version text not null,
  mermaid_version text not null,
  diagram_policy_version text not null,
  locale text not null check (locale ~ '^[a-z]{2,8}(-[a-z0-9]{1,8})*$'),
  model_provider_family text not null,
  model_id text not null,
  prompt_digest text not null check (prompt_digest ~ '^[0-9a-f]{64}$'),
  inference_config_digest text not null check (inference_config_digest ~ '^[0-9a-f]{64}$'),
  generation_plan_artifact jsonb not null,
  finalization_artifact jsonb not null,
  release_manifest_artifact jsonb not null,
  content_bundle_artifact jsonb not null,
  prepared_at timestamptz not null,
  pageindex_idempotency_key text,
  pageindex_attachment_input_digest text
    check (pageindex_attachment_input_digest is null or pageindex_attachment_input_digest ~ '^[0-9a-f]{64}$'),
  pageindex_artifact jsonb,
  pageindex_metadata jsonb,
  pageindex_attached_at timestamptz,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,idempotency_key),
  unique (tenant_id,repository,release_id),
  unique (tenant_id,repository,publication_input_digest),
  check (
    (scope_kind in ('branch','pull_request') and ref_sequence is not null)
    or (scope_kind='commit' and ref_sequence is null)
  ),
  check ((generation_reason='translation') = (source_release_id is not null and source_locale is not null)),
  check (
    (
      pageindex_idempotency_key is null
      and pageindex_attachment_input_digest is null
      and pageindex_artifact is null
      and pageindex_metadata is null
      and pageindex_attached_at is null
      and published_at is null
    ) or (
      pageindex_idempotency_key is not null
      and pageindex_attachment_input_digest is not null
      and pageindex_artifact is not null
      and pageindex_metadata is not null
      and pageindex_attached_at is not null
      and published_at=pageindex_attached_at
    )
  )
);
create unique index if not exists context_board_publications_mutable_sequence
  on jina_context.context_board_publications
  (tenant_id,repository,ref_name,locale,ref_sequence)
  where ref_sequence is not null;
create unique index if not exists context_board_publications_pageindex_idempotency
  on jina_context.context_board_publications (tenant_id,pageindex_idempotency_key)
  where pageindex_idempotency_key is not null;
create index if not exists context_board_publications_commit_locale_lookup
  on jina_context.context_board_publications
  (tenant_id,repository,commit_sha,locale,published_at desc,release_id desc)
  where published_at is not null;
create index if not exists context_board_publications_release_family
  on jina_context.context_board_publications
  (tenant_id,repository,release_family_id,locale,release_id);

create table if not exists jina_context.current_context_board_releases (
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  locale text not null check (locale ~ '^[a-z]{2,8}(-[a-z0-9]{1,8})*$'),
  ref_sequence bigint not null check (ref_sequence > 0),
  release_id text not null references jina_context.context_board_publications(release_id),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  public_snapshot_digest text not null check (public_snapshot_digest ~ '^[0-9a-f]{64}$'),
  advanced_at timestamptz not null,
  primary key (tenant_id,repository,ref_name,locale),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository)
);
create index if not exists current_context_board_releases_audit_due
  on jina_context.current_context_board_releases
  (tenant_id,repository,locale,ref_name,release_id);

create table if not exists jina_context.context_release_audit_runs (
  audit_id text primary key,
  tenant_id text not null,
  repository text not null,
  release_id text not null,
  locale text not null check (locale ~ '^[a-z]{2,8}(-[a-z0-9]{1,8})*$'),
  public_snapshot_digest text not null check (public_snapshot_digest ~ '^[0-9a-f]{64}$'),
  audit_policy_version text not null,
  auditor_config_digest text not null check (auditor_config_digest ~ '^[0-9a-f]{64}$'),
  audit_window text not null,
  audit_input_digest text not null unique check (audit_input_digest ~ '^[0-9a-f]{64}$'),
  trigger_run_id text not null unique,
  claimed_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  foreign key (tenant_id,repository,release_id)
    references jina_context.context_board_publications(tenant_id,repository,release_id),
  unique (tenant_id,repository,audit_id)
);
create index if not exists context_release_audit_runs_reconciliation
  on jina_context.context_release_audit_runs (tenant_id,audit_id,trigger_run_id);

create table if not exists jina_context.context_release_audits (
  audit_id text primary key,
  tenant_id text not null,
  repository text not null,
  release_id text not null,
  locale text not null check (locale ~ '^[a-z]{2,8}(-[a-z0-9]{1,8})*$'),
  public_snapshot_digest text not null check (public_snapshot_digest ~ '^[0-9a-f]{64}$'),
  audit_policy_version text not null,
  auditor_config_digest text not null check (auditor_config_digest ~ '^[0-9a-f]{64}$'),
  audit_window text not null,
  audit_input_digest text not null unique check (audit_input_digest ~ '^[0-9a-f]{64}$'),
  trigger_run_id text not null,
  outcome text not null check (outcome in ('passed','needs_improvement','error')),
  summary jsonb not null check (jsonb_typeof(summary)='object' and octet_length(summary::text) <= 65536),
  report_artifact jsonb not null,
  completed_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  foreign key (tenant_id,repository,release_id)
    references jina_context.context_board_publications(tenant_id,repository,release_id),
  unique (tenant_id,repository,audit_id)
);
create index if not exists context_release_audits_release_latest
  on jina_context.context_release_audits
  (tenant_id,repository,release_id,locale,completed_at desc,audit_id desc);
create index if not exists context_release_audits_policy_latest
  on jina_context.context_release_audits
  (tenant_id,repository,locale,audit_policy_version,auditor_config_digest,audit_window);

create table if not exists jina_context.context_release_audit_followups (
  audit_id text primary key,
  tenant_id text not null,
  repository text not null,
  request_key text not null unique,
  board_build_id text,
  current_release_id_at_decision text,
  admitted_at timestamptz,
  admission_outcome text not null check (
    admission_outcome in ('admitted','already_admitted','superseded','policy_denied')
  ),
  decided_at timestamptz not null,
  foreign key (tenant_id,repository,audit_id)
    references jina_context.context_release_audits(tenant_id,repository,audit_id)
);
create index if not exists context_release_audit_followups_scope
  on jina_context.context_release_audit_followups (tenant_id,repository,decided_at desc,audit_id);

create table if not exists jina_context.issue_graph_releases (
  release_id text primary key check (release_id ~ '^cir_[0-9a-f]{32}$'),
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  ref_sequence bigint not null check (ref_sequence > 0),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  build_id text not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  artifact jsonb not null,
  issue_count integer not null check (issue_count between 0 and 2000),
  causality_count integer not null check (causality_count between 0 and 5000),
  history_complete boolean not null,
  published_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,ref_name,ref_sequence),
  unique (tenant_id,repository,content_digest)
);
create index if not exists context_issue_graph_releases_scope
  on jina_context.issue_graph_releases
  (tenant_id,repository,ref_name,ref_sequence desc,release_id);

create table if not exists jina_context.context_phase_checkpoints (
  tenant_id text not null,
  repository text not null,
  build_id text not null,
  task_id text not null,
  phase text not null,
  checkpoint_key text not null,
  attempt integer not null check (attempt > 0),
  artifact jsonb not null,
  recorded_at timestamptz not null,
  primary key (tenant_id,task_id,phase,checkpoint_key)
);
create index if not exists context_phase_checkpoints_build
  on jina_context.context_phase_checkpoints (tenant_id,build_id,recorded_at,task_id);

create table if not exists jina_context.context_phase_operation_leases (
  tenant_id text not null,
  repository text not null,
  build_id text not null,
  task_id text not null,
  phase text not null,
  operation_key text not null,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  owner_token text not null,
  claimed_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > claimed_at),
  released_at timestamptz check (released_at is null or released_at >= claimed_at),
  primary key (tenant_id,task_id,phase,operation_key)
);
create index if not exists context_phase_operation_leases_expiry
  on jina_context.context_phase_operation_leases (expires_at);

create table if not exists jina_context.context_quota_ledgers (
  tenant_id text primary key,
  version integer not null check (version > 0),
  ledger jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- api_tokens is a product-level credential store: tokens will authenticate
-- product features beyond Context, so the table lives in public. The Context
-- token capability role keeps its scoped grants and row policies (roles.ts),
-- and migration 0038 moves legacy jina_context rows here.
create table if not exists public.api_tokens (
  id text primary key,
  tenant_id text not null,
  principal_id text not null,
  name text not null,
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null,
  created_at timestamptz not null,
  created_by text not null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null) = (revoked_by is null))
);
create index if not exists api_tokens_tenant
  on public.api_tokens (tenant_id,created_at desc,id);

drop trigger if exists context_releases_immutable on jina_context.context_releases;
create or replace function jina_context.guard_context_release_change()
returns trigger
language plpgsql
as $release_guard$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000', message='jina_context.context_releases is append-only';
  end if;
  if old.pageindex_attached_at is null
     and new.pageindex_attached_at is not null
     and (to_jsonb(new) - array[
       'catalog','pageindex_idempotency_key','pageindex_attachment_input_digest',
       'pageindex_artifact','pageindex_metadata','pageindex_attached_at'
     ]) = (to_jsonb(old) - array[
       'catalog','pageindex_idempotency_key','pageindex_attachment_input_digest',
       'pageindex_artifact','pageindex_metadata','pageindex_attached_at'
     ]) then
    return new;
  end if;
  raise exception using errcode='55000', message='Context release is immutable outside its one-time attachment';
end
$release_guard$;
create trigger context_releases_immutable
  before update or delete on jina_context.context_releases
  for each row execute function jina_context.guard_context_release_change();

drop trigger if exists context_evidence_snapshots_immutable
  on jina_context.context_evidence_snapshots;
create trigger context_evidence_snapshots_immutable
  before update or delete on jina_context.context_evidence_snapshots
  for each row execute function jina_context.reject_immutable_change();

drop trigger if exists context_wiki_artifacts_immutable
  on jina_context.context_wiki_artifacts;
create trigger context_wiki_artifacts_immutable
  before update or delete on jina_context.context_wiki_artifacts
  for each row execute function jina_context.reject_immutable_change();

drop trigger if exists context_board_publications_immutable
  on jina_context.context_board_publications;
create or replace function jina_context.guard_trigger_wiki_release_change()
returns trigger
language plpgsql
as $wiki_release_guard$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000', message='jina_context.context_board_publications is append-only';
  end if;
  if old.published_at is null
     and new.published_at is not null
     and (to_jsonb(new) - array[
       'catalog','pageindex_idempotency_key','pageindex_attachment_input_digest','pageindex_artifact',
       'pageindex_metadata','pageindex_attached_at','published_at'
     ]) = (to_jsonb(old) - array[
       'catalog','pageindex_idempotency_key','pageindex_attachment_input_digest','pageindex_artifact',
       'pageindex_metadata','pageindex_attached_at','published_at'
     ]) then
    return new;
  end if;
  raise exception using errcode='55000', message='Trigger wiki release is immutable outside activation';
end
$wiki_release_guard$;
create trigger context_board_publications_immutable
  before update or delete on jina_context.context_board_publications
  for each row execute function jina_context.guard_trigger_wiki_release_change();

drop trigger if exists context_wiki_projections_immutable
  on jina_context.context_wiki_projections;
create trigger context_wiki_projections_immutable
  before update or delete on jina_context.context_wiki_projections
  for each row execute function jina_context.reject_immutable_change();

drop trigger if exists context_release_audits_immutable
  on jina_context.context_release_audits;
create trigger context_release_audits_immutable
  before update or delete on jina_context.context_release_audits
  for each row execute function jina_context.reject_immutable_change();

drop trigger if exists context_release_audit_runs_immutable
  on jina_context.context_release_audit_runs;
create trigger context_release_audit_runs_immutable
  before update or delete on jina_context.context_release_audit_runs
  for each row execute function jina_context.reject_immutable_change();

drop trigger if exists context_release_audit_followups_immutable
  on jina_context.context_release_audit_followups;
create trigger context_release_audit_followups_immutable
  before update or delete on jina_context.context_release_audit_followups
  for each row execute function jina_context.reject_immutable_change();

drop trigger if exists issue_graph_releases_immutable on jina_context.issue_graph_releases;
create trigger issue_graph_releases_immutable
  before update or delete on jina_context.issue_graph_releases
  for each row execute function jina_context.reject_immutable_change();
`;

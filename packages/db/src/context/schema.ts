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

drop trigger if exists issue_graph_releases_immutable on jina_context.issue_graph_releases;
create trigger issue_graph_releases_immutable
  before update or delete on jina_context.issue_graph_releases
  for each row execute function jina_context.reject_immutable_change();
`;

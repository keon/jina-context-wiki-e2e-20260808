/**
 * Clean context-engine schema.
 *
 * This is a from-scratch schema. Canonical rows are append-only; projections
 * are generation-scoped and disposable.
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
  provider text not null,
  provider_repository_id text not null,
  default_ref text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id,repository),
  unique (tenant_id,provider,provider_repository_id)
);

create table if not exists jina_context.pipeline_builds (
  id text primary key check (id ~ '^cb_'),
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  ref_sequence bigint not null check (ref_sequence > 0),
  request_key text not null,
  status text not null check (status in ('active','succeeded','degraded','failed')),
  created_at timestamptz not null,
  completed_at timestamptz,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,request_key),
  unique (tenant_id,repository,ref_name,ref_sequence),
  check ((status='active') = (completed_at is null))
);
create index if not exists context_pipeline_builds_scope
  on jina_context.pipeline_builds (tenant_id,repository,ref_name,ref_sequence desc,id desc);

create table if not exists jina_context.pipeline_stages (
  id text primary key check (id ~ '^cs_'),
  build_id text not null references jina_context.pipeline_builds(id) on delete cascade,
  tenant_id text not null,
  type text not null check (type in ('ingest-evidence','derive-knowledge','index-context')),
  topic text not null check (topic in ('run-ingest-evidence','run-derive-knowledge','run-index-context')),
  required boolean not null,
  status text not null check (status in ('blocked','queued','leased','succeeded','failed')),
  attempt integer not null default 0 check (attempt >= 0),
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  lease_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  fence_token text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (build_id,type),
  check (
    (status='leased' and lease_id is not null and lease_owner is not null
      and lease_expires_at is not null and fence_token is not null)
    or
    (status<>'leased' and lease_id is null and lease_owner is null
      and lease_expires_at is null and fence_token is null)
  )
);
create index if not exists context_pipeline_stages_claim
  on jina_context.pipeline_stages (tenant_id,topic,status,created_at,id);

-- Knowledge derivation is a required pipeline outcome. Repair builds created
-- by the earlier optional-stage implementation and make prior derivation
-- failures unambiguously terminal.
update jina_context.pipeline_stages
set required=true,updated_at=greatest(updated_at,now())
where type='derive-knowledge' and required=false;

update jina_context.pipeline_builds build
set status='failed',completed_at=coalesce(build.completed_at,now())
where build.status='degraded'
  and exists (
    select 1
    from jina_context.pipeline_stages stage
    where stage.build_id=build.id
      and stage.type='derive-knowledge'
      and stage.status='failed'
  );

create table if not exists jina_context.observations (
  id text not null,
  tenant_id text not null,
  repository text not null,
  source text not null,
  source_type text not null check (source_type in (
    'provider_event','provider_snapshot','git_object','parser_result',
    'human_input','model_output','tombstone'
  )),
  external_id text,
  occurred_at timestamptz,
  recorded_at timestamptz not null,
  payload jsonb not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,source,content_digest),
  unique nulls not distinct (tenant_id,repository,source,external_id,content_digest)
);
create index if not exists context_observations_source_external
  on jina_context.observations (tenant_id,repository,source,external_id,recorded_at desc);
create index if not exists context_observations_type_recorded
  on jina_context.observations (tenant_id,repository,source_type,recorded_at desc);

create table if not exists jina_context.evidence_records (
  id text not null,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  source_type text not null check (source_type in (
    'observation','blob','commit','pull_request','issue','document'
  )),
  source_id text not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  commit_sha text,
  path_or_url text,
  start_line integer,
  end_line integer,
  json_pointer text,
  observed_at timestamptz,
  title text not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  authority_class text not null,
  acl_fingerprint text not null check (acl_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40,64}$'),
  check (
    (start_line is null and end_line is null) or
    (path_or_url is not null and start_line > 0 and end_line >= start_line)
  ),
  unique (
    tenant_id,repository,source_type,source_id,content_digest,
    commit_sha,path_or_url,start_line,end_line,json_pointer
  )
);
create index if not exists context_evidence_records_source
  on jina_context.evidence_records
  (tenant_id,repository,source_type,source_id,created_at desc);

create table if not exists jina_context.evidence_checkpoints (
  id text primary key,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  ref_sequence bigint not null check (ref_sequence > 0),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40,64}$'),
  parser_version text not null,
  source_completeness text not null check (source_completeness in ('complete','partial')),
  observation_frontier text not null,
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  manifest_fingerprint text not null check (manifest_fingerprint ~ '^[0-9a-f]{64}$'),
  acl_fingerprint text not null check (acl_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,ref_name,ref_sequence)
);
create index if not exists context_evidence_checkpoints_latest
  on jina_context.evidence_checkpoints
  (tenant_id,repository,ref_name,ref_sequence desc,id desc);

create table if not exists jina_context.projection_input_events (
  tenant_id text not null,
  repository text not null,
  sequence bigint not null check (sequence > 0),
  id text not null,
  event_type text not null check (event_type in (
    'evidence.checkpoint.committed','knowledge.run.committed',
    'knowledge.revision.event','evidence.erased'
  )),
  aggregate_id text not null,
  occurred_at timestamptz not null,
  primary key (tenant_id,repository,sequence),
  unique (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository)
);
create index if not exists context_projection_input_events_latest
  on jina_context.projection_input_events (tenant_id,repository,sequence desc);

create table if not exists jina_context.evidence_checkpoint_records (
  checkpoint_id text not null references jina_context.evidence_checkpoints(id),
  tenant_id text not null,
  repository text not null,
  evidence_id text not null,
  ordinal integer not null check (ordinal >= 0),
  primary key (checkpoint_id,ordinal),
  unique (checkpoint_id,evidence_id),
  foreign key (tenant_id,repository,evidence_id)
    references jina_context.evidence_records(tenant_id,repository,id)
);

create table if not exists jina_context.evidence_checkpoint_manifest (
  checkpoint_id text not null references jina_context.evidence_checkpoints(id),
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  commit_sha text not null,
  path text not null,
  blob_sha text not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  content_available boolean not null default true,
  language text,
  executable boolean not null,
  entry_type text not null default 'file',
  link_target text,
  primary key (checkpoint_id,path)
);
alter table jina_context.evidence_checkpoint_manifest
  add column if not exists content_available boolean not null default true;
alter table jina_context.evidence_checkpoint_manifest
  add column if not exists entry_type text not null default 'file';
alter table jina_context.evidence_checkpoint_manifest
  add column if not exists link_target text;
do $manifest_entry_type$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname='evidence_checkpoint_manifest_entry_semantics_check'
      and conrelid='jina_context.evidence_checkpoint_manifest'::regclass
  ) then
    alter table jina_context.evidence_checkpoint_manifest
      add constraint evidence_checkpoint_manifest_entry_semantics_check
      check (
        entry_type in ('file','symlink','gitlink')
        and (entry_type='file' or not content_available)
        and (entry_type='file' or not executable)
        and (entry_type='symlink' or link_target is null)
      );
  end if;
end
$manifest_entry_type$;

create table if not exists jina_context.refs (
  id text not null,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  ref_sequence bigint not null check (ref_sequence > 0),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40,64}$'),
  is_default boolean not null default false,
  source_observation_id text not null,
  observed_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  foreign key (tenant_id,repository,source_observation_id)
    references jina_context.observations(tenant_id,repository,id),
  unique (tenant_id,repository,ref_name,ref_sequence)
);
create index if not exists context_refs_current_lookup
  on jina_context.refs (tenant_id,repository,ref_name,ref_sequence desc,id desc);

create table if not exists jina_context.commits (
  tenant_id text not null,
  repository text not null,
  sha text not null check (sha ~ '^[0-9a-f]{40,64}$'),
  tree_sha text not null check (tree_sha ~ '^[0-9a-f]{40,64}$'),
  author_external_id text,
  authored_at timestamptz,
  committed_at timestamptz,
  message text not null default '',
  source_observation_id text not null,
  primary key (tenant_id,repository,sha),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  foreign key (tenant_id,repository,source_observation_id)
    references jina_context.observations(tenant_id,repository,id)
);

create table if not exists jina_context.commit_parents (
  tenant_id text not null,
  repository text not null,
  commit_sha text not null,
  ordinal integer not null check (ordinal >= 0),
  parent_sha text not null check (parent_sha ~ '^[0-9a-f]{40,64}$'),
  primary key (tenant_id,repository,commit_sha,ordinal),
  foreign key (tenant_id,repository,commit_sha)
    references jina_context.commits(tenant_id,repository,sha)
);
create index if not exists context_commit_parents_parent
  on jina_context.commit_parents (tenant_id,repository,parent_sha,commit_sha);

create table if not exists jina_context.trees (
  tenant_id text not null,
  repository text not null,
  tree_sha text not null check (tree_sha ~ '^[0-9a-f]{40,64}$'),
  entry_count integer not null check (entry_count >= 0),
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null,
  primary key (tenant_id,repository,tree_sha),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository)
);

create table if not exists jina_context.blobs (
  tenant_id text not null,
  repository text not null,
  blob_sha text not null check (blob_sha ~ '^[0-9a-f]{40,64}$'),
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size >= 0),
  media_type text,
  encoding text,
  content text,
  recorded_at timestamptz not null,
  primary key (tenant_id,repository,blob_sha),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,content_digest)
);

create table if not exists jina_context.tree_entries (
  tenant_id text not null,
  repository text not null,
  tree_sha text not null,
  path text not null check (path <> ''),
  blob_sha text not null,
  mode text not null,
  primary key (tenant_id,repository,tree_sha,path),
  foreign key (tenant_id,repository,tree_sha)
    references jina_context.trees(tenant_id,repository,tree_sha)
);
alter table jina_context.tree_entries
  drop constraint if exists tree_entries_tenant_id_repository_blob_sha_fkey;
create index if not exists context_tree_entries_blob
  on jina_context.tree_entries (tenant_id,repository,blob_sha,tree_sha);

create table if not exists jina_context.commit_changes (
  tenant_id text not null,
  repository text not null,
  commit_sha text not null,
  ordinal integer not null check (ordinal >= 0),
  change_kind text not null check (change_kind in ('add','modify','delete','rename','copy')),
  path text not null,
  old_path text,
  old_blob_sha text,
  new_blob_sha text,
  primary key (tenant_id,repository,commit_sha,ordinal),
  foreign key (tenant_id,repository,commit_sha)
    references jina_context.commits(tenant_id,repository,sha),
  check (
    (change_kind='add' and new_blob_sha is not null) or
    (change_kind='delete' and old_blob_sha is not null) or
    (change_kind in ('modify','rename','copy') and old_blob_sha is not null and new_blob_sha is not null)
  )
);
create index if not exists context_commit_changes_path
  on jina_context.commit_changes (tenant_id,repository,path,commit_sha);

create table if not exists jina_context.blob_analyses (
  tenant_id text not null,
  repository text not null,
  blob_sha text not null,
  parser_name text not null,
  parser_version text not null,
  language text,
  status text not null check (status in ('complete','unsupported','failed')),
  diagnostics jsonb not null default '[]'::jsonb,
  output_digest text not null check (output_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (tenant_id,repository,blob_sha,parser_name,parser_version),
  foreign key (tenant_id,repository,blob_sha)
    references jina_context.blobs(tenant_id,repository,blob_sha)
);

create table if not exists jina_context.symbols (
  id text not null,
  tenant_id text not null,
  repository text not null,
  blob_sha text not null,
  parser_name text not null,
  parser_version text not null,
  moniker text not null,
  name text not null,
  kind text not null,
  signature text,
  start_line integer not null check (start_line > 0),
  end_line integer not null check (end_line >= start_line),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository,blob_sha,parser_name,parser_version)
    references jina_context.blob_analyses(tenant_id,repository,blob_sha,parser_name,parser_version),
  unique (tenant_id,repository,blob_sha,parser_name,parser_version,moniker)
);
create index if not exists context_symbols_name
  on jina_context.symbols (tenant_id,repository,name,kind);

create table if not exists jina_context.imports (
  id text not null,
  tenant_id text not null,
  repository text not null,
  blob_sha text not null,
  parser_name text not null,
  parser_version text not null,
  specifier text not null,
  imported_name text,
  local_name text,
  start_line integer not null check (start_line > 0),
  end_line integer not null check (end_line >= start_line),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository,blob_sha,parser_name,parser_version)
    references jina_context.blob_analyses(tenant_id,repository,blob_sha,parser_name,parser_version)
);
create index if not exists context_imports_specifier
  on jina_context.imports (tenant_id,repository,specifier);

create table if not exists jina_context.structural_facts (
  id text not null,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  relation_kind text not null,
  source_kind text not null,
  source_id text not null,
  target_kind text not null,
  target_id text not null,
  commit_sha text,
  path text,
  start_line integer,
  end_line integer,
  source_anchors jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  derivation_name text not null,
  derivation_version text not null,
  fact_digest text not null check (fact_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40,64}$'),
  check (
    (start_line is null and end_line is null) or
    (path is not null and start_line > 0 and end_line >= start_line)
  ),
  unique (tenant_id,repository,fact_digest)
);
create index if not exists context_structural_facts_source
  on jina_context.structural_facts (tenant_id,repository,source_kind,source_id,relation_kind);
create index if not exists context_structural_facts_target
  on jina_context.structural_facts (tenant_id,repository,target_kind,target_id,relation_kind);

create table if not exists jina_context.evidence_checkpoint_structural_facts (
  checkpoint_id text not null references jina_context.evidence_checkpoints(id),
  tenant_id text not null,
  repository text not null,
  structural_fact_id text not null,
  ordinal integer not null check (ordinal >= 0),
  primary key (checkpoint_id,ordinal),
  unique (checkpoint_id,structural_fact_id),
  foreign key (tenant_id,repository,structural_fact_id)
    references jina_context.structural_facts(tenant_id,repository,id)
);

create table if not exists jina_context.entities (
  id text not null,
  tenant_id text not null,
  repository text not null,
  kind text not null,
  natural_key text not null,
  display_name text not null,
  source_observation_id text,
  created_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  foreign key (tenant_id,repository,source_observation_id)
    references jina_context.observations(tenant_id,repository,id),
  unique (tenant_id,repository,kind,natural_key)
);

create table if not exists jina_context.identities (
  id text not null,
  tenant_id text not null,
  repository text not null,
  provider text not null,
  external_id text not null,
  entity_id text not null,
  source_observation_id text not null,
  created_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository,entity_id)
    references jina_context.entities(tenant_id,repository,id),
  foreign key (tenant_id,repository,source_observation_id)
    references jina_context.observations(tenant_id,repository,id),
  unique (tenant_id,repository,provider,external_id)
);

create table if not exists jina_context.derivation_runs (
  id text not null,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40,64}$'),
  checkpoint_id text not null references jina_context.evidence_checkpoints(id),
  focus jsonb not null,
  focus_fingerprint text not null check (focus_fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  generator_name text not null,
  generator_version text not null,
  model text not null,
  prompt_version text not null,
  schema_version text not null,
  cache_key text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('succeeded','rejected','failed')),
  raw_output jsonb,
  validation_diagnostics jsonb not null default '[]'::jsonb,
  revision_ids text[] not null default '{}'::text[],
  started_at timestamptz not null,
  completed_at timestamptz not null check (completed_at >= started_at),
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository)
);
alter table jina_context.derivation_runs
  drop constraint if exists derivation_runs_tenant_id_repository_cache_key_key;
alter table jina_context.derivation_runs
  add column if not exists revision_ids text[] not null default '{}'::text[];
create unique index if not exists context_derivation_runs_successful_cache
  on jina_context.derivation_runs (tenant_id,repository,cache_key)
  where status='succeeded';

create table if not exists jina_context.knowledge_documents (
  tenant_id text not null,
  repository text not null,
  logical_id text not null,
  -- Named so it can be replaced when the kinds grow again. Adding a kind to the
  -- domain without adding it here does not fail until an agent finally writes
  -- one, and then it fails at commit, after the whole derivation has been paid
  -- for: a thirty-minute run wrote ten pages and published none of them.
  kind text not null constraint knowledge_documents_kind_known check (kind in (
    'architecture','component','feature','decision','change_summary','incident',
    'issue_explanation','ownership','runbook','glossary','flow','pattern','topic'
  )),
  subject jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id,repository,logical_id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository)
);

create table if not exists jina_context.knowledge_document_revisions (
  id text not null,
  tenant_id text not null,
  repository text not null,
  logical_id text not null,
  derivation_run_id text,
  title text not null check (title <> ''),
  body_markdown text not null check (body_markdown <> ''),
  summary text not null,
  structured_summary jsonb not null default '{}'::jsonb,
  scope jsonb not null,
  ref_name text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40,64}$'),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  body_digest text not null check (body_digest ~ '^[0-9a-f]{64}$'),
  generator_name text not null,
  generator_version text not null,
  model text not null,
  prompt_version text not null,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  author_kind text not null check (author_kind in ('model','human','system')),
  created_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository,logical_id)
    references jina_context.knowledge_documents(tenant_id,repository,logical_id),
  foreign key (tenant_id,repository,derivation_run_id)
    references jina_context.derivation_runs(tenant_id,repository,id)
);
-- The table is created once, so widening the set of kinds has to be stated as a
-- change too: an existing database keeps whatever check it was built with, and a
-- kind added only to the domain fails at commit, after a whole derivation has
-- been paid for.
alter table jina_context.knowledge_documents
  drop constraint if exists knowledge_documents_kind_check;
alter table jina_context.knowledge_documents
  drop constraint if exists knowledge_documents_kind_known;
alter table jina_context.knowledge_documents
  add constraint knowledge_documents_kind_known check (kind in (
    'architecture','component','feature','decision','change_summary','incident',
    'issue_explanation','ownership','runbook','glossary','flow','pattern','topic'
  ));
alter table jina_context.knowledge_document_revisions
  drop constraint if exists knowledge_document_revisions_tenant_id_repository_logical_i_key;
create index if not exists context_knowledge_revisions_logical_created
  on jina_context.knowledge_document_revisions
  (tenant_id,repository,logical_id,created_at desc,id desc);
create index if not exists context_knowledge_revisions_commit_kind
  on jina_context.knowledge_document_revisions
  (tenant_id,repository,commit_sha,logical_id);

-- Existing deployments already protect canonical rows with this trigger. Remove
-- it inside the schema transaction for the one-time association backfill; the
-- trigger refresh at the end of this script restores append-only enforcement.
drop trigger if exists reject_immutable_change on jina_context.derivation_runs;
update jina_context.derivation_runs run
set revision_ids=linked.revision_ids
from (
  select tenant_id,repository,derivation_run_id,array_agg(id order by created_at,id) revision_ids
  from jina_context.knowledge_document_revisions
  where derivation_run_id is not null
  group by tenant_id,repository,derivation_run_id
) linked
where run.tenant_id=linked.tenant_id
  and run.repository=linked.repository
  and run.id=linked.derivation_run_id
  and cardinality(run.revision_ids)=0;

create table if not exists jina_context.knowledge_revision_evidence (
  tenant_id text not null,
  repository text not null,
  revision_id text not null,
  ordinal integer not null check (ordinal >= 0),
  claim_role text not null,
  claim_ids text[] not null default '{}',
  source_type text not null check (source_type in (
    'observation','blob','commit','pull_request','issue','document'
  )),
  source_id text not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  commit_sha text,
  path_or_url text,
  start_line integer,
  end_line integer,
  json_pointer text,
  observed_at timestamptz,
  anchor jsonb not null,
  primary key (tenant_id,repository,revision_id,ordinal),
  foreign key (tenant_id,repository,revision_id)
    references jina_context.knowledge_document_revisions(tenant_id,repository,id),
  check (source_type <> 'knowledge_revision'),
  check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40,64}$'),
  check (
    (start_line is null and end_line is null) or
    (path_or_url is not null and start_line > 0 and end_line >= start_line)
  )
);
create index if not exists context_knowledge_evidence_source
  on jina_context.knowledge_revision_evidence
  (tenant_id,repository,source_type,source_id);

create table if not exists jina_context.knowledge_revision_events (
  id text not null,
  tenant_id text not null,
  repository text not null,
  revision_id text not null,
  sequence integer not null check (sequence > 0),
  event_type text not null check (event_type in (
    'created','reviewed','approved','rejected','superseded','invalidated','redacted','retained','expired'
  )),
  actor_id text not null,
  reason text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository,revision_id)
    references jina_context.knowledge_document_revisions(tenant_id,repository,id),
  unique (tenant_id,repository,revision_id,sequence)
);
create index if not exists context_knowledge_events_revision
  on jina_context.knowledge_revision_events
  (tenant_id,repository,revision_id,sequence desc);

create table if not exists jina_context.repository_acl_observations (
  id text not null,
  tenant_id text not null,
  repository text not null,
  principal_id text not null,
  permission text not null check (permission in ('read','write','admin','denied')),
  acl_fingerprint text not null check (acl_fingerprint ~ '^[0-9a-f]{64}$'),
  source_observation_id text not null,
  observed_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository,source_observation_id)
    references jina_context.observations(tenant_id,repository,id),
  unique (tenant_id,repository,principal_id,source_observation_id)
);
create index if not exists context_acl_observations_principal
  on jina_context.repository_acl_observations
  (tenant_id,principal_id,repository,observed_at desc,id desc);

create table if not exists jina_context.erasure_filters (
  id text not null,
  tenant_id text not null,
  repository text not null,
  source_type text not null,
  source_id text,
  path_pattern text,
  content_digest text,
  reason text not null,
  actor_id text not null,
  created_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  check (num_nonnulls(source_id,path_pattern,content_digest) > 0)
);
create index if not exists context_erasure_filters_source
  on jina_context.erasure_filters (tenant_id,repository,source_type,source_id);

create table if not exists jina_context.audit_events (
  id text not null,
  tenant_id text not null,
  repository text not null,
  sequence bigint not null check (sequence > 0),
  actor_id text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  primary key (tenant_id,repository,id),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,sequence)
);

create table if not exists jina_context.outbox (
  delivery_id text primary key,
  event_id text not null,
  tenant_id text not null,
  repository text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  aggregate_sequence bigint not null check (aggregate_sequence > 0),
  event_type text not null,
  consumer text not null check (consumer in (
    'manifest','knowledge-current','lexical','dense','hierarchy',
    'structural','identity','acl','retention'
  )),
  payload jsonb not null,
  occurred_at timestamptz not null,
  available_at timestamptz not null,
  attempt integer not null default 0 check (attempt >= 0),
  lease_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  processed_at timestamptz,
  last_error text,
  unique (event_id,consumer),
  unique (tenant_id,repository,aggregate_type,aggregate_id,aggregate_sequence,consumer),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  check (
    (lease_id is null and lease_owner is null and lease_expires_at is null) or
    (lease_id is not null and lease_owner is not null and lease_expires_at is not null)
  )
);
create index if not exists context_outbox_claim
  on jina_context.outbox (consumer,available_at,occurred_at,delivery_id)
  where processed_at is null;
create index if not exists context_outbox_repository
  on jina_context.outbox (tenant_id,repository,consumer,processed_at,occurred_at);

create table if not exists jina_context.index_generations (
  id text primary key,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40,64}$'),
  checkpoint_id text not null references jina_context.evidence_checkpoints(id),
  kind text not null check (kind in ('baseline','enriched','rebuild')),
  status text not null check (status in ('building','published','failed','invalidated')),
  barrier_occurred_at timestamptz not null,
  projector_versions jsonb not null,
  capabilities jsonb not null,
  required_fingerprint text,
  acl_fingerprint text not null check (acl_fingerprint ~ '^[0-9a-f]{64}$'),
  projection_input_fingerprint text not null check (projection_input_fingerprint ~ '^[0-9a-f]{64}$'),
  degraded_capabilities text[] not null default '{}',
  created_at timestamptz not null,
  published_at timestamptz,
  invalidated_at timestamptz,
  failure jsonb,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  unique (tenant_id,repository,id),
  check ((status='published') = (published_at is not null) or status='invalidated'),
  check (invalidated_at is null or status='invalidated')
);
create unique index if not exists context_generations_one_published_commit
  on jina_context.index_generations (tenant_id,repository,ref_name,commit_sha)
  where status='published';
create index if not exists context_generations_published
  on jina_context.index_generations
  (tenant_id,repository,ref_name,published_at desc,id desc)
  where status='published';

create table if not exists jina_context.generation_projectors (
  generation_id text not null references jina_context.index_generations(id) on delete cascade,
  consumer text not null check (consumer in (
    'manifest','knowledge-current','lexical','dense','hierarchy',
    'structural','identity','acl','retention'
  )),
  required boolean not null,
  version text not null,
  status text not null check (status in (
    'pending','running','ready','disabled','skipped','failed'
  )),
  output_fingerprint text,
  processed_through timestamptz,
  lease_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failure jsonb,
  primary key (generation_id,consumer),
  check (
    (lease_id is null and lease_owner is null and lease_expires_at is null) or
    (lease_id is not null and lease_owner is not null and lease_expires_at is not null)
  )
);

create table if not exists jina_context.projection_checkpoints (
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  consumer text not null check (consumer in (
    'manifest','knowledge-current','lexical','dense','hierarchy',
    'structural','identity','acl','retention'
  )),
  projector_version text not null,
  processed_through timestamptz,
  output_fingerprint text,
  lease_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz not null,
  primary key (tenant_id,repository,ref_name,consumer),
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository),
  check (
    (lease_id is null and lease_owner is null and lease_expires_at is null) or
    (lease_id is not null and lease_owner is not null and lease_expires_at is not null)
  )
);

create table if not exists jina_context.ref_manifest (
  generation_id text not null references jina_context.index_generations(id) on delete cascade,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  commit_sha text not null,
  path text not null,
  blob_sha text not null,
  mode text not null,
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  content_available boolean not null default true,
  source_anchors jsonb not null default '[]'::jsonb,
  primary key (generation_id,path),
  unique (generation_id,tenant_id,repository,ref_name,path)
);
alter table jina_context.ref_manifest
  add column if not exists content_available boolean not null default true;
alter table jina_context.ref_manifest
  drop constraint if exists ref_manifest_tenant_id_repository_blob_sha_fkey;
create index if not exists context_manifest_path
  on jina_context.ref_manifest (tenant_id,repository,ref_name,path,generation_id);

create table if not exists jina_context.current_knowledge_revisions (
  generation_id text not null references jina_context.index_generations(id) on delete cascade,
  tenant_id text not null,
  repository text not null,
  logical_id text not null,
  revision_id text not null,
  selection_reason jsonb not null,
  selection_fingerprint text not null check (selection_fingerprint ~ '^[0-9a-f]{64}$'),
  primary key (generation_id,logical_id),
  unique (tenant_id,repository,logical_id,generation_id),
  foreign key (tenant_id,repository,revision_id)
    references jina_context.knowledge_document_revisions(tenant_id,repository,id)
);

create table if not exists jina_context.context_documents (
  id text not null,
  generation_id text not null references jina_context.index_generations(id) on delete cascade,
  tenant_id text not null,
  repository text not null,
  ref_name text not null,
  commit_sha text not null,
  source_kind text not null check (source_kind in (
    'code','provider','knowledge','commit','pull_request','issue','document'
  )),
  source_id text not null,
  source_revision_id text,
  title text not null,
  body text not null,
  contextual_text text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  authority_class text not null,
  effective_acl_fingerprint text not null check (effective_acl_fingerprint ~ '^[0-9a-f]{64}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_anchors jsonb not null default '[]'::jsonb,
  projector_name text not null,
  projector_version text not null,
  projected_at timestamptz not null,
  exact_vector tsvector generated always as (
    to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(body,''))
  ) stored,
  prose_vector tsvector generated always as (
    to_tsvector('english',coalesce(title,'') || ' ' || coalesce(body,'') || ' ' || coalesce(contextual_text,''))
  ) stored,
  primary key (generation_id,id),
  unique nulls not distinct (generation_id,source_kind,source_id,source_revision_id),
  check (commit_sha ~ '^[0-9a-f]{40,64}$')
);
create index if not exists context_documents_scope
  on jina_context.context_documents
  (tenant_id,repository,ref_name,generation_id,source_kind,source_id);
create index if not exists context_documents_exact
  on jina_context.context_documents using gin (exact_vector);
create index if not exists context_documents_prose
  on jina_context.context_documents using gin (prose_vector);

create table if not exists jina_context.context_fragments (
  id text not null,
  generation_id text not null,
  document_id text not null,
  tenant_id text not null,
  repository text not null,
  ordinal integer not null check (ordinal >= 0),
  source_text text not null,
  contextual_text text not null default '',
  source_anchors jsonb not null,
  source_start integer not null check (source_start >= 0),
  source_end integer not null check (source_end >= source_start),
  content_fingerprint text not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  effective_acl_fingerprint text not null check (effective_acl_fingerprint ~ '^[0-9a-f]{64}$'),
  exact_vector tsvector generated always as (
    to_tsvector('simple',coalesce(source_text,''))
  ) stored,
  prose_vector tsvector generated always as (
    to_tsvector('english',coalesce(source_text,'') || ' ' || coalesce(contextual_text,''))
  ) stored,
  primary key (generation_id,id),
  foreign key (generation_id,document_id)
    references jina_context.context_documents(generation_id,id) on delete cascade,
  unique (generation_id,document_id,ordinal)
);
create index if not exists context_fragments_scope
  on jina_context.context_fragments (tenant_id,repository,generation_id,document_id,ordinal);
create index if not exists context_fragments_exact
  on jina_context.context_fragments using gin (exact_vector);
create index if not exists context_fragments_prose
  on jina_context.context_fragments using gin (prose_vector);

create table if not exists jina_context.exact_index (
  generation_id text not null,
  term text not null,
  document_id text not null,
  field text not null check (field in ('title','body','metadata')),
  primary key (generation_id,term,document_id,field),
  foreign key (generation_id,document_id)
    references jina_context.context_documents(generation_id,id) on delete cascade
);
create index if not exists context_exact_index_lookup
  on jina_context.exact_index (generation_id,term,field,document_id);

create table if not exists jina_context.context_embeddings (
  generation_id text not null,
  fragment_id text not null,
  tenant_id text not null,
  repository text not null,
  embedding_model text not null,
  dimensions integer not null check (dimensions > 0),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  projector_version text not null,
  embedding real[],
  external_reference text,
  created_at timestamptz not null,
  primary key (generation_id,fragment_id,embedding_model),
  foreign key (generation_id,fragment_id)
    references jina_context.context_fragments(generation_id,id) on delete cascade,
  check (embedding is not null or external_reference is not null),
  check (embedding is null or cardinality(embedding)=dimensions)
);

create table if not exists jina_context.hierarchy_nodes (
  id text not null,
  generation_id text not null,
  document_id text not null,
  tenant_id text not null,
  repository text not null,
  parent_id text,
  ordinal integer not null check (ordinal >= 0),
  depth integer not null check (depth >= 0),
  preorder_start integer not null check (preorder_start >= 0),
  preorder_end integer not null check (preorder_end >= preorder_start),
  title text not null,
  summary text not null,
  source_anchors jsonb not null,
  source_start integer not null check (source_start >= 0),
  source_end integer not null check (source_end >= source_start),
  adapter_name text not null,
  adapter_version text not null,
  node_fingerprint text not null check (node_fingerprint ~ '^[0-9a-f]{64}$'),
  search_vector tsvector generated always as (
    to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(summary,''))
  ) stored,
  primary key (generation_id,id),
  foreign key (generation_id,document_id)
    references jina_context.context_documents(generation_id,id) on delete cascade,
  foreign key (generation_id,parent_id)
    references jina_context.hierarchy_nodes(generation_id,id) deferrable initially deferred,
  unique (generation_id,document_id,preorder_start)
);
create index if not exists context_hierarchy_parent
  on jina_context.hierarchy_nodes (tenant_id,repository,generation_id,document_id,parent_id,ordinal);
create index if not exists context_hierarchy_preorder
  on jina_context.hierarchy_nodes (generation_id,document_id,preorder_start,preorder_end);
alter table jina_context.hierarchy_nodes
  add column if not exists search_vector tsvector generated always as (
    to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(summary,''))
  ) stored;
create index if not exists context_hierarchy_search
  on jina_context.hierarchy_nodes using gin (search_vector);

create table if not exists jina_context.structural_relations (
  id text not null,
  generation_id text not null references jina_context.index_generations(id) on delete cascade,
  tenant_id text not null,
  repository text not null,
  relation_kind text not null,
  ref_name text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40,64}$'),
  source_kind text not null,
  source_id text not null,
  target_kind text not null,
  target_id text not null,
  source_anchors jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  relation_fingerprint text not null check (relation_fingerprint ~ '^[0-9a-f]{64}$'),
  projector_version text not null,
  primary key (generation_id,id),
  unique (generation_id,relation_fingerprint)
);
create index if not exists context_relations_source
  on jina_context.structural_relations
  (tenant_id,repository,generation_id,source_kind,source_id,relation_kind);
create index if not exists context_relations_target
  on jina_context.structural_relations
  (tenant_id,repository,generation_id,target_kind,target_id,relation_kind);

create table if not exists jina_context.identity_projection (
  generation_id text not null references jina_context.index_generations(id) on delete cascade,
  tenant_id text not null,
  repository text not null,
  provider text not null,
  external_id text not null,
  canonical_entity_id text not null,
  projection_fingerprint text not null check (projection_fingerprint ~ '^[0-9a-f]{64}$'),
  primary key (generation_id,provider,external_id)
);
create index if not exists context_identity_projection_entity
  on jina_context.identity_projection
  (tenant_id,repository,generation_id,canonical_entity_id);

create table if not exists jina_context.repository_acl_projection (
  generation_id text not null references jina_context.index_generations(id) on delete cascade,
  tenant_id text not null,
  repository text not null,
  principal_id text not null,
  permission text not null check (permission in ('read','write','admin','denied')),
  acl_fingerprint text not null check (acl_fingerprint ~ '^[0-9a-f]{64}$'),
  source_observation_id text not null,
  primary key (generation_id,principal_id),
  foreign key (tenant_id,repository,source_observation_id)
    references jina_context.observations(tenant_id,repository,id)
);
create index if not exists context_acl_projection_principal
  on jina_context.repository_acl_projection
  (tenant_id,principal_id,repository,generation_id,permission);

create table if not exists jina_context.query_runs (
  id text primary key,
  tenant_id text not null,
  repository text not null,
  principal_fingerprint text not null,
  generation_id text not null references jina_context.index_generations(id),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  task_kind text,
  routes text[] not null,
  coverage_status text not null check (coverage_status in ('complete','partial','insufficient')),
  degraded_capabilities text[] not null default '{}',
  started_at timestamptz not null,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  citation_failure_count integer not null default 0 check (citation_failure_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  failure_kind text,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository)
);
create index if not exists context_query_runs_scope
  on jina_context.query_runs (tenant_id,repository,started_at desc);

create table if not exists jina_context.retrieval_candidates (
  query_run_id text not null references jina_context.query_runs(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  candidate_id text not null,
  retriever text not null,
  source_kind text not null,
  source_id text not null,
  source_revision_id text,
  raw_score double precision,
  fused_score double precision,
  rerank_score double precision,
  selected boolean not null,
  diagnostics jsonb not null default '{}'::jsonb,
  primary key (query_run_id,ordinal),
  unique (query_run_id,candidate_id,retriever)
);

create table if not exists jina_context.answer_citations (
  query_run_id text not null references jina_context.query_runs(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  citation_id text not null,
  source_kind text not null,
  source_id text not null,
  source_revision_id text,
  source_anchor jsonb not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  accessible boolean not null,
  digest_valid boolean not null,
  supports_claim boolean,
  diagnostics jsonb not null default '{}'::jsonb,
  primary key (query_run_id,ordinal)
);
alter table jina_context.answer_citations
  drop constraint if exists answer_citations_query_run_id_citation_id_key;

create table if not exists jina_context.retrieval_metrics (
  id text primary key,
  tenant_id text not null,
  repository text not null,
  query_run_id text references jina_context.query_runs(id) on delete set null,
  metric_name text not null,
  metric_value double precision not null,
  dimensions jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null,
  foreign key (tenant_id,repository)
    references jina_context.repositories(tenant_id,repository)
);
create index if not exists context_retrieval_metrics_scope
  on jina_context.retrieval_metrics
  (tenant_id,repository,metric_name,recorded_at desc);

-- A derivation runs for up to two hours inside a sandbox that dies with the
-- worker, and its pages were only ever collected at the end. A build stopped
-- part way -- by a deploy, a crash, a lost lease -- threw away everything it had
-- already written, and nobody watching could see it happening at all. Pages are
-- checkpointed here as they are finished, so progress is durable and readable
-- while the run is still going.
create table if not exists jina_context.derivation_progress (
  stage_id text not null references jina_context.pipeline_stages(id) on delete cascade,
  tenant_id text not null,
  build_id text not null references jina_context.pipeline_builds(id) on delete cascade,
  checkpoint_id text not null,
  -- The document path is the identity under the file contract, so it is the key.
  document_path text not null,
  title text not null,
  body_markdown text not null,
  bytes integer not null check (bytes >= 0),
  first_seen_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (stage_id,document_path)
);
create index if not exists context_derivation_progress_build
  on jina_context.derivation_progress (tenant_id,build_id,updated_at desc);

create table if not exists jina_context.api_tokens (
  id text not null check (id ~ '^atk_'),
  tenant_id text not null,
  principal_id text not null check (principal_id ~ '^(user|tenant|svc):'),
  name text not null,
  -- sha256 hex of the presented jina_atk_ string, never the secret. Plain
  -- SHA-256 rather than a password hash is correct only while the body stays 256
  -- bits of randomBytes with no user-chosen entropy: stretching buys nothing
  -- against an unguessable secret and costs a KDF on every request. If this ever
  -- becomes shorter or user-chosen, the hash must change with it.
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null constraint api_tokens_scopes_known check (
    cardinality(scopes) >= 1
    and scopes <@ array['context:query','context:read','context:build','context:admin']::text[]
  ),
  created_at timestamptz not null,
  created_by text not null,
  expires_at timestamptz not null check (expires_at > created_at),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  primary key (tenant_id,id),
  check ((revoked_at is null) = (revoked_by is null))
);
-- The scope enumeration must be reasserted on every run: create table if not
-- exists is skipped wholesale once the table exists, so editing the literal
-- above does nothing to a database this has already touched.
alter table jina_context.api_tokens
  drop constraint if exists api_tokens_scopes_known;
alter table jina_context.api_tokens
  add constraint api_tokens_scopes_known check (
    cardinality(scopes) >= 1
    and scopes <@ array['context:query','context:read','context:build','context:admin']::text[]
  );
create unique index if not exists context_api_tokens_secret
  on jina_context.api_tokens (secret_hash);
create index if not exists context_api_tokens_tenant
  on jina_context.api_tokens (tenant_id,created_at desc,id desc);

create or replace view jina_context.current_refs as
select distinct on (tenant_id,repository,ref_name)
  tenant_id,repository,ref_name,commit_sha,is_default,observed_at,id as observation_id
from jina_context.refs
order by tenant_id,repository,ref_name,ref_sequence desc,id desc;

create or replace view jina_context.current_repository_acl as
select tenant_id,repository,principal_id,permission,acl_fingerprint,observed_at
from (
  select acl.*,
    row_number() over (
      partition by tenant_id,repository,principal_id
      order by observed_at desc,id desc
    ) as recency
  from jina_context.repository_acl_observations acl
) ranked
where recency=1;

create or replace view jina_context.published_context_documents as
select document.*
from jina_context.context_documents document
join jina_context.index_generations generation
  on generation.id=document.generation_id
where generation.status='published';

create or replace view jina_context.published_context_fragments as
select fragment.*
from jina_context.context_fragments fragment
join jina_context.index_generations generation
  on generation.id=fragment.generation_id
where generation.status='published';

create or replace view jina_context.published_structural_relations as
select relation.*
from jina_context.structural_relations relation
join jina_context.index_generations generation
  on generation.id=relation.generation_id
where generation.status='published';

create or replace view jina_context.published_hierarchy_nodes as
select node.*
from jina_context.hierarchy_nodes node
join jina_context.index_generations generation
  on generation.id=node.generation_id
where generation.status='published';

create or replace view jina_context.published_current_knowledge_revisions as
select selection.*
from jina_context.current_knowledge_revisions selection
join jina_context.index_generations generation
  on generation.id=selection.generation_id
where generation.status='published';

create or replace view jina_context.published_repository_acl as
select acl.*
from jina_context.repository_acl_projection acl
join jina_context.index_generations generation
  on generation.id=acl.generation_id
where generation.status='published';

do $triggers$
declare table_name text;
begin
  foreach table_name in array array[
    'observations','evidence_records','evidence_checkpoints','evidence_checkpoint_records',
    'evidence_checkpoint_manifest','evidence_checkpoint_structural_facts',
    'refs','commits','commit_parents','trees','tree_entries','blobs',
    'commit_changes','blob_analyses','symbols','imports','structural_facts',
    'entities','identities','derivation_runs','knowledge_documents',
    'knowledge_document_revisions','knowledge_revision_evidence',
    'knowledge_revision_events','repository_acl_observations','erasure_filters','audit_events',
    'projection_input_events'
  ] loop
    execute format('drop trigger if exists reject_immutable_change on jina_context.%I',table_name);
    execute format(
      'create trigger reject_immutable_change before update or delete on jina_context.%I ' ||
      'for each row execute function jina_context.reject_immutable_change()',
      table_name
    );
  end loop;
end
$triggers$;

revoke all on schema jina_context from public;
revoke all on all tables in schema jina_context from public;
revoke all on all sequences in schema jina_context from public;
revoke execute on all functions in schema jina_context from public;
`;

/**
 * Apply only when pgvector is installed and enabled. Keeping this separate lets
 * the mandatory lexical baseline bootstrap on stock PostgreSQL.
 */
export const CONTEXT_PGVECTOR_SCHEMA_SQL = `
create extension if not exists vector;
alter table jina_context.context_embeddings
  add column if not exists embedding_vector vector;
`;

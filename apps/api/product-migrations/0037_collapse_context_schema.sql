-- The live Context path publishes one validated catalog document per Board
-- release. Remove the pre-migration ingestion/projector/query database and its
-- unused product bot registry. The new context_releases and repository_access
-- tables are installed by the shared Context schema before this migration.
drop table if exists public.github_webhook_inbox_control cascade;

-- Authentication and tenancy are Clerk-only after the hard migration. Expire
-- pre-Clerk sessions, remove GitHub OAuth state, and drop its membership
-- projection instead of carrying dual authority indefinitely.
delete from public.dashboard_sessions;
alter table public.dashboard_sessions
  alter column user_id set not null;
drop table if exists public.oauth_states cascade;
drop table if exists public.tenant_members cascade;

-- Delivery handling is durable in github_webhook_inbox/jina_runtime.github_deliveries.
-- Installation ownership changes are final; rollback snapshots and merged tenant
-- shells belonged to the completed connection migration.
drop table if exists public.github_events cascade;
drop table if exists public.installation_tenant_move_repositories cascade;
drop table if exists public.installation_tenant_moves cascade;

-- Scenario generation/simulation was removed from the review runtime. Current
-- reviews persist findings and their event stream directly.
drop table if exists public.simulation_steps cascade;
drop table if exists public.simulations cascade;
drop table if exists public.scenario_steps cascade;
drop table if exists public.scenario_versions cascade;
drop table if exists public.scenarios cascade;
drop table if exists public.scenario_lineages cascade;

delete from public.tenants where merged_into_tenant_id is not null;
alter table public.tenants drop column if exists merged_into_tenant_id cascade;

-- Stored settings use only the current tri-select contract. Migration 0020
-- canonicalized the two retired provider names; discard any remaining invalid
-- values before enforcing the current domain.
update public.tenant_model_settings
set model_provider = 'managed'
where model_provider is null
   or model_provider not in ('codex', 'byok', 'managed');
alter table public.tenant_model_settings
  alter column model_provider set default 'managed',
  alter column model_provider set not null;
alter table public.tenant_model_settings
  add constraint tenant_model_settings_provider_check
  check (model_provider in ('codex', 'byok', 'managed'));

-- The review list projection now carries only the current completion status and
-- error. Rich review work is sourced from bounded current runtime events.
create or replace function public.jina_dashboard_review_result_projection(source jsonb)
returns jsonb
language sql
immutable
parallel safe
as $function$
  select case
    when source is null or jsonb_typeof(source) <> 'object' then null
    else jsonb_strip_nulls(jsonb_build_object(
      'status', public.jina_dashboard_bounded_text(source->'status'),
      'error', public.jina_dashboard_bounded_text(source->'error')
    ))
  end
$function$;

create or replace function public.jina_dashboard_event_payload_projection(event_status text, source jsonb)
returns jsonb
language sql
immutable
parallel safe
as $function$
  select case
    when source is null or jsonb_typeof(source) <> 'object' then null
    when event_status = 'runtime_review_completed' then
      jsonb_strip_nulls(jsonb_build_object(
        'status', public.jina_dashboard_bounded_text(source->'status'),
        'summary', public.jina_dashboard_bounded_text(source->'summary'),
        'findings_count', public.jina_dashboard_number(source->'findings_count'),
        'publishable_findings_count', public.jina_dashboard_number(source->'publishable_findings_count'),
        'inline_comment_count', public.jina_dashboard_number(source->'inline_comment_count'),
        'file_comment_count', public.jina_dashboard_number(source->'file_comment_count'),
        'unanchored_findings_count', public.jina_dashboard_number(source->'unanchored_findings_count'),
        'low_confidence_findings_held_back', public.jina_dashboard_number(source->'low_confidence_findings_held_back'),
        'areas_count', public.jina_dashboard_number(source->'areas_count'),
        'tasks_count', public.jina_dashboard_number(source->'tasks_count'),
        'error', public.jina_dashboard_bounded_text(source->'error')
      ))
    when event_status in (
      'github_runtime_review_published',
      'github_runtime_review_publish_skipped',
      'github_runtime_review_publish_failed'
    ) then
      jsonb_strip_nulls(jsonb_build_object(
        'publication_status', public.jina_dashboard_bounded_text(source->'publication_status'),
        'reason', public.jina_dashboard_bounded_text(source->'reason'),
        'error', public.jina_dashboard_bounded_text(source->'error'),
        'github_review_url', public.jina_dashboard_bounded_text(source->'github_review_url', 2048),
        'publishable_findings_count', public.jina_dashboard_number(source->'publishable_findings_count'),
        'inline_comment_count', public.jina_dashboard_number(source->'inline_comment_count'),
        'file_comment_count', public.jina_dashboard_number(source->'file_comment_count')
      ))
  end
$function$;

update public.review_runs
set dashboard_result_json = public.jina_dashboard_review_result_projection(result_json)
where result_json is not null;

update public.review_run_events
set dashboard_payload_json = public.jina_dashboard_event_payload_projection(status, payload_json)
where status in (
  'runtime_review_completed',
  'github_runtime_review_published',
  'github_runtime_review_publish_skipped',
  'github_runtime_review_publish_failed'
);

drop function if exists public.jina_dashboard_boolean(jsonb);

-- Every current repository is owned by one exact GitHub App installation.
-- Rows that the completed connection migration could not resolve are not part
-- of the current product model.
delete from public.repositories where installation_id is null;
alter table public.repositories
  alter column installation_id set not null;

-- Plaintext provider credentials were valid only before envelope encryption.
-- Remove unusable pre-migration values; current writes always use enc:v1.
update public.user_integrations
set codex_harness_auth = null,
    codex_harness_connected_at = null
where codex_harness_auth is not null
  and codex_harness_auth not like 'enc:v1:%';

update public.tenant_integrations
set openrouter_api_key = case
      when openrouter_api_key like 'enc:v1:%' then openrouter_api_key
      else null
    end,
    openrouter_key_source = case
      when openrouter_api_key like 'enc:v1:%' then openrouter_key_source
      else null
    end,
    openrouter_key_label = case
      when openrouter_api_key like 'enc:v1:%' then openrouter_key_label
      else null
    end,
    openrouter_connected_at = case
      when openrouter_api_key like 'enc:v1:%' then openrouter_connected_at
      else null
    end,
    openai_api_key = case
      when openai_api_key like 'enc:v1:%' then openai_api_key
      else null
    end,
    openai_connected_at = case
      when openai_api_key like 'enc:v1:%' then openai_connected_at
      else null
    end,
    anthropic_api_key = case
      when anthropic_api_key like 'enc:v1:%' then anthropic_api_key
      else null
    end,
    anthropic_connected_at = case
      when anthropic_api_key like 'enc:v1:%' then anthropic_connected_at
      else null
    end
where (openrouter_api_key is not null and openrouter_api_key not like 'enc:v1:%')
   or (openai_api_key is not null and openai_api_key not like 'enc:v1:%')
   or (anthropic_api_key is not null and anthropic_api_key not like 'enc:v1:%');

delete from public.context_execution_profiles
where encrypted_credential is not null
  and encrypted_credential not like 'enc:v1:%';

do $drop_inbox_generation_constraint$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.github_webhook_inbox'::regclass
      and pg_get_constraintdef(oid) like '%lease_generation%'
  loop
    execute format(
      'alter table public.github_webhook_inbox drop constraint %I',
      constraint_name
    );
  end loop;
end
$drop_inbox_generation_constraint$;

alter table if exists public.github_webhook_inbox
  drop column if exists lease_generation;
alter table if exists public.github_webhook_inbox
  add constraint github_webhook_inbox_lease_shape check (
    (status = 'leased' and lease_id is not null and lease_expires_at is not null)
    or
    (status <> 'leased' and lease_id is null and lease_expires_at is null)
  );

-- The current review contract has one run-review task. Remove workflows from
-- the retired staged review graph rather than retaining a drain-only runtime.
delete from jina_runtime.board_workflows
where workflow_type = 'pr_review'
  and pipeline_version <> 'pr_review.board.v2';

-- Remove retired review/extension tasks from the JSON Context Board. This is a
-- one-way data migration; the runtime does not carry compatibility readers.
with state_rows as (
  select
    state.id,
    state.snapshot,
    jsonb_path_query_array(
      state.snapshot,
      '$.intakeState.board.tasks[*] ? (
        @.type == "build-context" ||
        @.type == "context-build-graph" ||
        @.type == "snapshot-context-input" ||
        @.type == "plan-context-pages" ||
        @.type == "build-context-page" ||
        @.type == "publish-context-release" ||
        @.type == "build-causal-graph" ||
        @.type == "snapshot-causal-graph-history" ||
        @.type == "derive-causal-graph" ||
        @.type == "publish-causal-graph"
      )'
    ) current_tasks
  from jina_runtime.api_state state
), cleaned as (
  select
    state_rows.id,
    state_rows.snapshot,
    state_rows.current_tasks,
    coalesce((
      select jsonb_agg(item order by ordinal)
      from jsonb_array_elements(coalesce(state_rows.snapshot #> '{intakeState,board,dependencies}', '[]'))
        with ordinality dependency(item, ordinal)
      where item->>'taskId' in (
        select task->>'id' from jsonb_array_elements(state_rows.current_tasks) as tasks(task)
      )
        and item->>'dependsOnTaskId' in (
          select task->>'id' from jsonb_array_elements(state_rows.current_tasks) as tasks(task)
        )
    ), '[]') current_dependencies,
    coalesce((
      select jsonb_agg(item order by ordinal)
      from jsonb_array_elements(coalesce(state_rows.snapshot #> '{intakeState,board,outbox}', '[]'))
        with ordinality message(item, ordinal)
      where item->>'taskId' in (
        select task->>'id' from jsonb_array_elements(state_rows.current_tasks) as tasks(task)
      )
    ), '[]') current_outbox,
    coalesce((
      select jsonb_agg(item order by ordinal)
      from jsonb_array_elements(coalesce(state_rows.snapshot #> '{intakeState,board,events}', '[]'))
        with ordinality event(item, ordinal)
      where not (item ? 'taskId')
         or item->>'taskId' in (
           select task->>'id' from jsonb_array_elements(state_rows.current_tasks) as tasks(task)
         )
    ), '[]') current_events
  from state_rows
)
update jina_runtime.api_state state
set snapshot = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        cleaned.snapshot #- '{intakeState,pullRequests}',
        '{intakeState,board,tasks}', cleaned.current_tasks
      ),
      '{intakeState,board,dependencies}', cleaned.current_dependencies
    ),
    '{intakeState,board,outbox}', cleaned.current_outbox
  ),
  '{intakeState,board,events}', cleaned.current_events
),
version = state.version + 1,
updated_at = now()
from cleaned
where state.id = cleaned.id;

drop view if exists jina_context.published_context_documents cascade;
drop view if exists jina_context.published_context_fragments cascade;
drop view if exists jina_context.published_structural_relations cascade;
drop view if exists jina_context.published_hierarchy_nodes cascade;
drop view if exists jina_context.current_repository_acl cascade;

drop table if exists public.clerk_membership_bootstraps cascade;
drop table if exists public.bots cascade;

drop table if exists jina_context.context_board_publications cascade;
drop table if exists jina_context.current_context_board_releases cascade;
drop table if exists jina_context.current_issue_graph_releases cascade;
drop table if exists jina_context.index_generations cascade;
drop table if exists jina_context.generation_projectors cascade;
drop table if exists jina_context.projection_checkpoints cascade;
drop table if exists jina_context.outbox cascade;

drop table if exists jina_context.ref_manifest cascade;
drop table if exists jina_context.current_knowledge_revisions cascade;
drop table if exists jina_context.context_documents cascade;
drop table if exists jina_context.context_fragments cascade;
drop table if exists jina_context.exact_index cascade;
drop table if exists jina_context.hierarchy_nodes cascade;
drop table if exists jina_context.structural_relations cascade;
drop table if exists jina_context.identity_projection cascade;
drop table if exists jina_context.repository_acl_projection cascade;

drop table if exists jina_context.derivation_runs cascade;
drop table if exists jina_context.knowledge_revision_events cascade;
drop table if exists jina_context.knowledge_revision_evidence cascade;
drop table if exists jina_context.knowledge_document_revisions cascade;
drop table if exists jina_context.knowledge_documents cascade;

drop table if exists jina_context.evidence_checkpoint_structural_facts cascade;
drop table if exists jina_context.evidence_checkpoint_manifest cascade;
drop table if exists jina_context.evidence_checkpoint_records cascade;
drop table if exists jina_context.evidence_checkpoints cascade;
drop table if exists jina_context.evidence_records cascade;
drop table if exists jina_context.projection_input_events cascade;
drop table if exists jina_context.repository_acl_observations cascade;
drop table if exists jina_context.erasure_filters cascade;
drop table if exists jina_context.audit_events cascade;

drop table if exists jina_context.identities cascade;
drop table if exists jina_context.entities cascade;
drop table if exists jina_context.imports cascade;
drop table if exists jina_context.symbols cascade;
drop table if exists jina_context.structural_facts cascade;
drop table if exists jina_context.blob_analyses cascade;
drop table if exists jina_context.commit_changes cascade;
drop table if exists jina_context.tree_entries cascade;
drop table if exists jina_context.blobs cascade;
drop table if exists jina_context.trees cascade;
drop table if exists jina_context.commit_parents cascade;
drop table if exists jina_context.commits cascade;
drop table if exists jina_context.refs cascade;
drop table if exists jina_context.observations cascade;

-- Remove capability roles that existed only for the deleted projector pipeline.
do $retire_context_projector_roles$
declare
  role_name text;
  member_name text;
begin
  foreach role_name in array array[
    'jina_context_coordinator','jina_context_ingest','jina_context_derive',
    'jina_context_manifest','jina_context_knowledge_current','jina_context_lexical',
    'jina_context_hierarchy','jina_context_structural','jina_context_identity',
    'jina_context_acl','jina_context_retention','jina_context_dense'
  ] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      for member_name in
        select member.rolname
        from pg_auth_members membership
        join pg_roles granted on granted.oid=membership.roleid
        join pg_roles member on member.oid=membership.member
        where granted.rolname=role_name
      loop
        execute format('revoke %I from %I',role_name,member_name);
      end loop;
      execute format('drop owned by %I',role_name);
      execute format('drop role %I',role_name);
    end if;
  end loop;
end
$retire_context_projector_roles$;

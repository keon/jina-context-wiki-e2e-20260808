const CONTEXT_ROLES = [
  "jina_context_coordinator",
  "jina_context_ingest",
  "jina_context_derive",
  "jina_context_manifest",
  "jina_context_knowledge_current",
  "jina_context_lexical",
  "jina_context_dense",
  "jina_context_hierarchy",
  "jina_context_structural",
  "jina_context_identity",
  "jina_context_acl",
  "jina_context_retention",
  "jina_context_query",
  "jina_context_admin"
] as const;

const CONTEXT_CONSUMER_ROLES = [
  ["manifest", "jina_context_manifest"],
  ["knowledge-current", "jina_context_knowledge_current"],
  ["lexical", "jina_context_lexical"],
  ["dense", "jina_context_dense"],
  ["hierarchy", "jina_context_hierarchy"],
  ["structural", "jina_context_structural"],
  ["identity", "jina_context_identity"],
  ["acl", "jina_context_acl"],
  ["retention", "jina_context_retention"]
] as const;

export type ContextDatabaseRole = (typeof CONTEXT_ROLES)[number];

/**
 * Grants are intentionally explicit. In particular, runtime roles receive no
 * UPDATE or DELETE privileges on canonical evidence or immutable knowledge.
 */
export const CONTEXT_ROLES_SQL = `
do $roles$
declare role_name text;
begin
  foreach role_name in array array[${CONTEXT_ROLES.map((role) => `'${role}'`).join(",")}] loop
    if not exists (select 1 from pg_roles where rolname=role_name) then
      execute format('create role %I nologin',role_name);
    end if;
  end loop;
end
$roles$;

revoke all on schema jina_context from public;
revoke all on all tables in schema jina_context from public;
revoke all on all sequences in schema jina_context from public;
revoke execute on all functions in schema jina_context from public;

grant usage on schema jina_context to ${CONTEXT_ROLES.join(",")};

grant select,insert,update on
  jina_context.pipeline_builds,jina_context.pipeline_stages
to jina_context_coordinator;
grant select,insert,update on
  jina_context.index_generations,jina_context.generation_projectors,
  jina_context.projection_checkpoints
to jina_context_coordinator;
grant select on jina_context.pipeline_builds,jina_context.pipeline_stages to
  jina_context_ingest,jina_context_derive,jina_context_manifest,jina_context_lexical,
  jina_context_knowledge_current,jina_context_dense,jina_context_hierarchy,
  jina_context_structural,jina_context_identity,
  jina_context_acl,jina_context_retention;

grant select,insert,update on jina_context.repositories to jina_context_ingest;
grant select,insert on
  jina_context.observations,jina_context.evidence_records,jina_context.evidence_checkpoints,
  jina_context.evidence_checkpoint_records,jina_context.evidence_checkpoint_manifest,
  jina_context.evidence_checkpoint_structural_facts,jina_context.refs,jina_context.commits,
  jina_context.commit_parents,jina_context.trees,jina_context.tree_entries,
  jina_context.blobs,jina_context.commit_changes,jina_context.blob_analyses,
  jina_context.symbols,jina_context.imports,jina_context.structural_facts,
  jina_context.entities,jina_context.identities,jina_context.repository_acl_observations,
  jina_context.erasure_filters,jina_context.audit_events
to jina_context_ingest;
grant select,insert,update on jina_context.outbox to jina_context_ingest;

grant select on
  jina_context.repositories,jina_context.observations,jina_context.evidence_records,
  jina_context.evidence_checkpoints,jina_context.evidence_checkpoint_records,
  jina_context.evidence_checkpoint_manifest,jina_context.evidence_checkpoint_structural_facts,
  jina_context.refs,
  jina_context.commits,jina_context.commit_parents,jina_context.trees,
  jina_context.tree_entries,jina_context.blobs,jina_context.commit_changes,
  jina_context.blob_analyses,jina_context.symbols,jina_context.imports,
  jina_context.structural_facts,jina_context.entities,jina_context.identities,
  jina_context.repository_acl_observations,jina_context.erasure_filters
to jina_context_derive;
grant insert,select on
  jina_context.derivation_runs,jina_context.knowledge_documents,
  jina_context.knowledge_document_revisions,jina_context.knowledge_revision_evidence,
  jina_context.knowledge_revision_events,jina_context.audit_events
to jina_context_derive;
grant select,insert,update on jina_context.outbox to jina_context_derive;

grant select on
  jina_context.knowledge_documents,jina_context.knowledge_document_revisions,
  jina_context.knowledge_revision_events,jina_context.index_generations,
  jina_context.generation_projectors
to jina_context_knowledge_current;
grant select,insert,update,delete on jina_context.current_knowledge_revisions
to jina_context_knowledge_current;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_knowledge_current;

grant select on
  jina_context.repositories,jina_context.refs,jina_context.commits,
  jina_context.trees,jina_context.tree_entries,jina_context.blobs,
  jina_context.erasure_filters,jina_context.index_generations,
  jina_context.generation_projectors
to jina_context_manifest;
grant select,insert,update,delete on jina_context.ref_manifest to jina_context_manifest;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_manifest;

grant select on
  jina_context.observations,jina_context.blobs,jina_context.ref_manifest,
  jina_context.knowledge_document_revisions,jina_context.knowledge_revision_evidence,
  jina_context.current_knowledge_revisions,jina_context.erasure_filters,
  jina_context.index_generations,jina_context.generation_projectors
to jina_context_lexical;
grant select,insert,update,delete on
  jina_context.context_documents,jina_context.context_fragments,jina_context.exact_index
to jina_context_lexical;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_lexical;

grant select on
  jina_context.context_fragments,jina_context.index_generations,
  jina_context.generation_projectors
to jina_context_dense;
grant select,insert,update,delete on jina_context.context_embeddings to jina_context_dense;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_dense;

grant select on
  jina_context.context_documents,jina_context.context_fragments,
  jina_context.index_generations,jina_context.generation_projectors
to jina_context_hierarchy;
grant select,insert,update,delete on jina_context.hierarchy_nodes to jina_context_hierarchy;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_hierarchy;

grant select on
  jina_context.structural_facts,jina_context.ref_manifest,
  jina_context.index_generations,jina_context.generation_projectors
to jina_context_structural;
grant select,insert,update,delete on jina_context.structural_relations to jina_context_structural;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_structural;

grant select on
  jina_context.entities,jina_context.identities,jina_context.index_generations,
  jina_context.generation_projectors
to jina_context_identity;
grant select,insert,update,delete on jina_context.identity_projection to jina_context_identity;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_identity;

grant select on
  jina_context.repository_acl_observations,jina_context.index_generations,
  jina_context.generation_projectors
to jina_context_acl;
grant select,insert,update,delete on jina_context.repository_acl_projection to jina_context_acl;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_acl;

grant select on
  jina_context.erasure_filters,jina_context.index_generations,
  jina_context.generation_projectors,jina_context.projection_checkpoints
to jina_context_retention;
grant delete on
  jina_context.ref_manifest,jina_context.current_knowledge_revisions,
  jina_context.context_documents,jina_context.context_fragments,jina_context.exact_index,
  jina_context.context_embeddings,jina_context.hierarchy_nodes,
  jina_context.structural_relations,jina_context.identity_projection,
  jina_context.repository_acl_projection
to jina_context_retention;
grant select,insert,update on
  jina_context.projection_checkpoints,jina_context.generation_projectors,jina_context.outbox
to jina_context_retention;
grant select,update,delete on jina_context.index_generations to jina_context_retention;

grant select on
  jina_context.current_refs,jina_context.published_repository_acl,
  jina_context.index_generations,jina_context.published_context_documents,
  jina_context.published_context_fragments,
  jina_context.published_structural_relations,jina_context.published_hierarchy_nodes,
  jina_context.published_current_knowledge_revisions,
  jina_context.context_embeddings,jina_context.exact_index,jina_context.knowledge_documents,
  jina_context.knowledge_document_revisions,jina_context.knowledge_revision_evidence
to jina_context_query;
grant select,insert,update on jina_context.query_runs to jina_context_query;
grant select,insert on
  jina_context.retrieval_candidates,jina_context.answer_citations,
  jina_context.retrieval_metrics
to jina_context_query;

grant all privileges on all tables in schema jina_context to jina_context_admin;
grant all privileges on all sequences in schema jina_context to jina_context_admin;
grant execute on all functions in schema jina_context to jina_context_admin;

revoke update on jina_context.outbox from
  jina_context_ingest,jina_context_derive,
  ${CONTEXT_CONSUMER_ROLES.map(([, role]) => role).join(",")};
grant update (available_at,attempt,lease_id,lease_owner,lease_expires_at,processed_at,last_error)
  on jina_context.outbox
  to ${CONTEXT_CONSUMER_ROLES.map(([, role]) => role).join(",")};

revoke insert,update on jina_context.generation_projectors from
  ${CONTEXT_CONSUMER_ROLES.map(([, role]) => role).join(",")};
grant update (
  status,output_fingerprint,processed_through,lease_id,lease_owner,
  lease_expires_at,started_at,completed_at,failure
) on jina_context.generation_projectors
  to ${CONTEXT_CONSUMER_ROLES.map(([, role]) => role).join(",")};

revoke update on jina_context.projection_checkpoints from
  ${CONTEXT_CONSUMER_ROLES.map(([, role]) => role).join(",")};
grant update (
  projector_version,processed_through,output_fingerprint,lease_id,
  lease_owner,lease_expires_at,updated_at
) on jina_context.projection_checkpoints
  to ${CONTEXT_CONSUMER_ROLES.map(([, role]) => role).join(",")};

alter table jina_context.outbox enable row level security;
alter table jina_context.generation_projectors enable row level security;
alter table jina_context.projection_checkpoints enable row level security;

drop policy if exists context_outbox_producer on jina_context.outbox;
create policy context_outbox_producer on jina_context.outbox
  for insert to jina_context_ingest,jina_context_derive
  with check (true);
drop policy if exists context_outbox_producer_read on jina_context.outbox;
create policy context_outbox_producer_read on jina_context.outbox
  for select to jina_context_ingest,jina_context_derive
  using (true);
drop policy if exists context_outbox_admin on jina_context.outbox;
create policy context_outbox_admin on jina_context.outbox
  to jina_context_admin using (true) with check (true);
drop policy if exists context_generation_projectors_admin on jina_context.generation_projectors;
create policy context_generation_projectors_admin on jina_context.generation_projectors
  to jina_context_admin using (true) with check (true);
drop policy if exists context_generation_projectors_coordinator on jina_context.generation_projectors;
create policy context_generation_projectors_coordinator on jina_context.generation_projectors
  to jina_context_coordinator using (true) with check (true);
drop policy if exists context_projection_checkpoints_admin on jina_context.projection_checkpoints;
create policy context_projection_checkpoints_admin on jina_context.projection_checkpoints
  to jina_context_admin using (true) with check (true);
drop policy if exists context_projection_checkpoints_coordinator on jina_context.projection_checkpoints;
create policy context_projection_checkpoints_coordinator on jina_context.projection_checkpoints
  to jina_context_coordinator using (true) with check (true);

${CONTEXT_CONSUMER_ROLES.map(
  ([consumer, role]) => `
drop policy if exists context_outbox_${role} on jina_context.outbox;
create policy context_outbox_${role} on jina_context.outbox
  to ${role} using (consumer='${consumer}') with check (consumer='${consumer}');
drop policy if exists context_generation_projectors_${role} on jina_context.generation_projectors;
create policy context_generation_projectors_${role} on jina_context.generation_projectors
  to ${role} using (consumer='${consumer}') with check (consumer='${consumer}');
drop policy if exists context_projection_checkpoints_${role} on jina_context.projection_checkpoints;
create policy context_projection_checkpoints_${role} on jina_context.projection_checkpoints
  to ${role} using (consumer='${consumer}') with check (consumer='${consumer}');`
).join("\n")}

alter default privileges in schema jina_context revoke all on tables from public;
alter default privileges in schema jina_context revoke all on sequences from public;
alter default privileges in schema jina_context revoke execute on functions from public;
`;

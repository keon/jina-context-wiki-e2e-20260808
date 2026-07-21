const componentRoles = [
  "jina_ontology_intake",
  "jina_ontology_code",
  "jina_ontology_knowledge",
  "jina_ontology_manifest",
  "jina_ontology_search",
  "jina_ontology_reconciliation",
  "jina_ontology_graph",
  "jina_ontology_query"
] as const;

export const ONTOLOGY_COMPONENT_ROLES = componentRoles;

export const ONTOLOGY_ROLES_SQL = `
do $roles$
declare role_name text;
begin
  foreach role_name in array array[
    'jina_ontology_reader','jina_ontology_writer',
    ${componentRoles.map((role) => `'${role}'`).join(",")}
  ] loop
    if not exists (select 1 from pg_roles where rolname=role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end
$roles$;

revoke all on schema jina_ontology from public;
revoke all on all tables in schema jina_ontology from public;
revoke all on all sequences in schema jina_ontology from public;
revoke execute on all functions in schema jina_ontology from public;

grant usage on schema jina_ontology to jina_ontology_reader,jina_ontology_writer,${componentRoles.join(",")};
grant select on all tables in schema jina_ontology to jina_ontology_reader;

grant select,insert,update on jina_ontology.observations,jina_ontology.outbox to jina_ontology_intake;

grant select on jina_ontology.observations to jina_ontology_code;
grant select,insert,update,delete on
  jina_ontology.commits,jina_ontology.refs,jina_ontology.commit_changes,jina_ontology.blobs,
  jina_ontology.blob_analyses,jina_ontology.blob_symbols,jina_ontology.blob_imports,jina_ontology.symbol_edges
  to jina_ontology_code;
grant select,insert,update on jina_ontology.outbox to jina_ontology_code;

grant select on jina_ontology.observations,jina_ontology.commits,jina_ontology.refs,jina_ontology.blob_analyses to jina_ontology_knowledge;
grant select,insert,update,delete on
  jina_ontology.entities,jina_ontology.identities,jina_ontology.assertions,jina_ontology.entity_redirects,
  jina_ontology.audit_log,jina_ontology.erasure_filters,jina_ontology.repository_acl
  to jina_ontology_knowledge;
grant select,insert on jina_ontology.assertion_relations to jina_ontology_knowledge;
grant select,insert,update on jina_ontology.outbox to jina_ontology_knowledge;

grant select on jina_ontology.refs,jina_ontology.commits,jina_ontology.commit_changes to jina_ontology_manifest;
grant select,insert,update,delete on jina_ontology.ref_manifest to jina_ontology_manifest;
grant select,update on jina_ontology.outbox to jina_ontology_manifest;
grant execute on function jina_ontology.commit_manifest(text,text,text) to
  jina_ontology_reader,jina_ontology_code,jina_ontology_manifest,jina_ontology_graph,jina_ontology_query;

grant select on jina_ontology.observations,jina_ontology.entities,jina_ontology.assertions,jina_ontology.entity_redirects,jina_ontology.refs to jina_ontology_search;
grant select,insert,update,delete on jina_ontology.search_documents to jina_ontology_search;
grant select,update on jina_ontology.outbox to jina_ontology_search;

grant select on jina_ontology.entities,jina_ontology.entity_redirects to jina_ontology_reconciliation;
grant select,update on jina_ontology.assertions to jina_ontology_reconciliation;
grant select,insert on jina_ontology.audit_log to jina_ontology_reconciliation;
grant select,insert,update on jina_ontology.outbox to jina_ontology_reconciliation;

grant select on all tables in schema jina_ontology to jina_ontology_graph;
grant insert,update,delete on jina_ontology.graphs,jina_ontology.graph_heads,jina_ontology.nodes,jina_ontology.edges to jina_ontology_graph;
grant update on jina_ontology.outbox to jina_ontology_graph;

grant select on all tables in schema jina_ontology to jina_ontology_query;
grant insert,delete on jina_ontology.retrieval_metrics to jina_ontology_query;
grant usage,select on sequence jina_ontology.retrieval_metrics_id_seq to jina_ontology_query;

grant ${componentRoles.join(",")} to jina_ontology_writer;

alter default privileges in schema jina_ontology revoke all on tables from public;
alter default privileges in schema jina_ontology revoke all on sequences from public;
alter default privileges in schema jina_ontology revoke execute on functions from public;
alter default privileges in schema jina_ontology grant select on tables to jina_ontology_reader;
`;

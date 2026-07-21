const componentRoles = [
  "jina_context_graph_intake",
  "jina_context_graph_code",
  "jina_context_graph_knowledge",
  "jina_context_graph_manifest",
  "jina_context_graph_search",
  "jina_context_graph_reconciliation",
  "jina_context_graph",
  "jina_context_graph_query"
] as const;

export const CONTEXT_GRAPH_ROLES_SQL = `
do $roles$
declare role_name text;
begin
  foreach role_name in array array[
    'jina_context_graph_reader','jina_context_graph_writer',
    ${componentRoles.map((role) => `'${role}'`).join(",")}
  ] loop
    if not exists (select 1 from pg_roles where rolname=role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end
$roles$;

revoke all on schema jina_context_graph from public;
revoke all on all tables in schema jina_context_graph from public;
revoke all on all sequences in schema jina_context_graph from public;
revoke execute on all functions in schema jina_context_graph from public;

grant usage on schema jina_context_graph to jina_context_graph_reader,jina_context_graph_writer,${componentRoles.join(",")};
grant select on all tables in schema jina_context_graph to jina_context_graph_reader;

grant select,insert,update on jina_context_graph.observations,jina_context_graph.outbox to jina_context_graph_intake;

grant select on jina_context_graph.observations to jina_context_graph_code;
grant select,insert,update,delete on
  jina_context_graph.commits,jina_context_graph.refs,jina_context_graph.commit_changes,jina_context_graph.blobs,
  jina_context_graph.blob_analyses,jina_context_graph.blob_symbols,jina_context_graph.blob_imports,jina_context_graph.symbol_edges
  to jina_context_graph_code;
grant select,insert,update on jina_context_graph.outbox to jina_context_graph_code;

grant select on jina_context_graph.observations,jina_context_graph.commits,jina_context_graph.refs,jina_context_graph.blob_analyses to jina_context_graph_knowledge;
grant select,insert,update,delete on
  jina_context_graph.entities,jina_context_graph.identities,jina_context_graph.assertions,jina_context_graph.entity_redirects,
  jina_context_graph.audit_log,jina_context_graph.erasure_filters,jina_context_graph.repository_acl
  to jina_context_graph_knowledge;
grant select,insert on jina_context_graph.assertion_relations to jina_context_graph_knowledge;
grant select,insert,update on jina_context_graph.outbox to jina_context_graph_knowledge;

grant select on jina_context_graph.refs,jina_context_graph.commits,jina_context_graph.commit_changes to jina_context_graph_manifest;
grant select,insert,update,delete on jina_context_graph.ref_manifest to jina_context_graph_manifest;
grant select,update on jina_context_graph.outbox to jina_context_graph_manifest;
grant execute on function jina_context_graph.commit_manifest(text,text,text) to
  jina_context_graph_reader,jina_context_graph_code,jina_context_graph_manifest,jina_context_graph,jina_context_graph_query;

grant select on jina_context_graph.observations,jina_context_graph.entities,jina_context_graph.assertions,jina_context_graph.entity_redirects,jina_context_graph.refs to jina_context_graph_search;
grant select,insert,update,delete on jina_context_graph.search_documents to jina_context_graph_search;
grant select,update on jina_context_graph.outbox to jina_context_graph_search;

grant select on jina_context_graph.entities,jina_context_graph.entity_redirects to jina_context_graph_reconciliation;
grant select,update on jina_context_graph.assertions to jina_context_graph_reconciliation;
grant select,insert on jina_context_graph.audit_log to jina_context_graph_reconciliation;
grant select,insert,update on jina_context_graph.outbox to jina_context_graph_reconciliation;

grant select on all tables in schema jina_context_graph to jina_context_graph;
grant insert,update,delete on jina_context_graph.graphs,jina_context_graph.graph_heads,jina_context_graph.nodes,jina_context_graph.edges to jina_context_graph;
grant update on jina_context_graph.outbox to jina_context_graph;

grant select on all tables in schema jina_context_graph to jina_context_graph_query;
grant insert,delete on jina_context_graph.retrieval_metrics to jina_context_graph_query;
grant usage,select on sequence jina_context_graph.retrieval_metrics_id_seq to jina_context_graph_query;

grant ${componentRoles.join(",")} to jina_context_graph_writer;

alter default privileges in schema jina_context_graph revoke all on tables from public;
alter default privileges in schema jina_context_graph revoke all on sequences from public;
alter default privileges in schema jina_context_graph revoke execute on functions from public;
alter default privileges in schema jina_context_graph grant select on tables to jina_context_graph_reader;
`;

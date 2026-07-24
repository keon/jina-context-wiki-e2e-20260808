import { createHash } from "node:crypto";
import { predicateRegistry } from "@jina/context-graph";

const cardinalityOnePredicates = Object.values(predicateRegistry)
  .filter((definition) => definition.cardinality === "one")
  .map((definition) => definition.name)
  .sort();
// The index name encodes the predicate list so schema reruns rebuild the
// backstop only when the registry's cardinality-one set changes.
const oneActiveIndexName = `context_graph_assertions_one_active_${createHash("sha256")
  .update(cardinalityOnePredicates.join(","))
  .digest("hex")
  .slice(0, 8)}`;

export const CONTEXT_GRAPH_SCHEMA_SQL = `
      -- Production data predating the context-graph rename lives in the
      -- legacy jina_ontology schema. Renaming that schema in place keeps
      -- every existing table, index, and row visible under the new name;
      -- creating a fresh jina_context_graph schema next to it would orphan
      -- that data. The transaction-scoped advisory lock serializes
      -- concurrent schema applies (this whole multi-statement batch runs as
      -- one implicit transaction), mirroring the pipeline coordinator's
      -- advisory-lock idiom, so exactly one bootstrap performs the rename
      -- and the rest observe the adopted schema.
      do $$
      begin
        perform pg_advisory_xact_lock(hashtext('jina_context_graph.schema'));
        if exists (select 1 from pg_namespace where nspname = 'jina_ontology')
           and not exists (select 1 from pg_namespace where nspname = 'jina_context_graph') then
          execute 'alter schema jina_ontology rename to jina_context_graph';
        end if;
      end
      $$;
      create schema if not exists jina_context_graph;
      drop table if exists jina_context_graph.commit_files;
      drop table if exists jina_context_graph.model_outputs;
      drop table if exists jina_context_graph.issue_traces;
      create table if not exists jina_context_graph.graphs (
        id text primary key,
        tenant_id text not null,
        repository text not null,
        ref text not null,
        commit_sha text not null,
        generated_at timestamptz not null,
        executor text not null check (executor in ('daytona','fixture','projection')),
        model text not null,
        sandbox_id text,
        summary text not null
      );
      alter table jina_context_graph.graphs drop constraint if exists graphs_executor_check;
      alter table jina_context_graph.graphs add constraint graphs_executor_check check (executor in ('daytona','fixture','projection'));
      create index if not exists context_graphs_tenant_generated
        on jina_context_graph.graphs (tenant_id, generated_at desc);
      create table if not exists jina_context_graph.graph_heads (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        graph_id text not null references jina_context_graph.graphs(id) on delete cascade,
        updated_at timestamptz not null,
        primary key (tenant_id,repository,ref_name)
      );
      create table if not exists jina_context_graph.nodes (
        graph_id text not null references jina_context_graph.graphs(id) on delete cascade,
        node_id text not null,
        kind text not null,
        label text not null,
        description text not null,
        path text,
        evidence jsonb not null,
        primary key (graph_id, node_id)
      );
      alter table jina_context_graph.nodes drop constraint if exists context_graph_nodes_kind_check;
      update jina_context_graph.nodes set kind='Issue' where kind='VirtualIssue';
      alter table jina_context_graph.nodes add constraint context_graph_nodes_kind_check check (kind in (
        'Repository','File','Symbol','Commit','PullRequest','Issue','Engineer','Team','Document','Feature',
        'Package','Service','Deployment','Incident'
      ));
      create index if not exists context_graph_nodes_graph_kind_description
        on jina_context_graph.nodes (graph_id,kind,description);
      create table if not exists jina_context_graph.edges (
        graph_id text not null references jina_context_graph.graphs(id) on delete cascade,
        edge_id text not null,
        source_node_id text not null,
        target_node_id text not null,
        predicate text not null,
        plane text not null check (plane in ('code','knowledge')),
        confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
        why text,
        qualifiers jsonb not null default '{}'::jsonb,
        evidence jsonb not null,
        primary key (graph_id, edge_id),
        foreign key (graph_id, source_node_id) references jina_context_graph.nodes(graph_id, node_id),
        foreign key (graph_id, target_node_id) references jina_context_graph.nodes(graph_id, node_id)
      );
      alter table jina_context_graph.edges add column if not exists confidence double precision;
      alter table jina_context_graph.edges add column if not exists why text;
      alter table jina_context_graph.edges add column if not exists qualifiers jsonb not null default '{}'::jsonb;
      alter table jina_context_graph.edges drop constraint if exists edges_confidence_check;
      alter table jina_context_graph.edges add constraint edges_confidence_check
        check (confidence is null or (confidence >= 0 and confidence <= 1));
      create index if not exists context_graph_edges_graph_predicate_source
        on jina_context_graph.edges (graph_id,predicate,source_node_id);
      create index if not exists context_graph_edges_graph_predicate_target
        on jina_context_graph.edges (graph_id,predicate,target_node_id);
      alter table jina_context_graph.graphs add column if not exists node_count integer;
      alter table jina_context_graph.graphs add column if not exists edge_count integer;
      update jina_context_graph.graphs g
         set node_count=(select count(*) from jina_context_graph.nodes n where n.graph_id=g.id),
             edge_count=(select count(*) from jina_context_graph.edges e where e.graph_id=g.id)
       where g.node_count is null or g.edge_count is null;
      create table if not exists jina_context_graph.observations (
        id text primary key,
        tenant_id text not null,
        source text not null,
        type text not null check (type in ('source_event','source_snapshot','analysis_result','human_input','model_output','tombstone')),
        external_id text,
        repository text,
        recorded_at timestamptz not null,
        payload jsonb,
        payload_sha text not null,
        redacted_at timestamptz,
        redaction_reason text,
        unique (tenant_id,source,external_id)
      );
      alter table jina_context_graph.observations add column if not exists occurred_at timestamptz;
      alter table jina_context_graph.observations drop constraint if exists observations_supersedes_same_tenant;
      alter table jina_context_graph.observations drop constraint if exists observations_supersedes_id_fkey;
      alter table jina_context_graph.observations drop column if exists supersedes_id;
      create index if not exists context_graph_observations_work_item
        on jina_context_graph.observations (tenant_id,repository,source,((payload->>'kind')),((payload->>'number')))
        where redacted_at is null and payload is not null;
      create table if not exists jina_context_graph.commits (
        tenant_id text not null,
        repository text not null,
        sha text not null,
        tree_sha text not null,
        parents text[] not null,
        source_observation_id text not null references jina_context_graph.observations(id),
        primary key (tenant_id,repository,sha)
      );
      alter table jina_context_graph.commits add column if not exists author_external_id text;
      alter table jina_context_graph.commits add column if not exists committed_at timestamptz;
      alter table jina_context_graph.commits add column if not exists message text;
      alter table jina_context_graph.commits add column if not exists tree_paths text[] not null default '{}';
      alter table jina_context_graph.commits add column if not exists tree_blob_shas text[] not null default '{}';
      alter table jina_context_graph.commits add column if not exists tree_recorded boolean not null default false;
      alter table jina_context_graph.commits drop constraint if exists commits_tree_arrays_match;
      alter table jina_context_graph.commits add constraint commits_tree_arrays_match
        check (cardinality(tree_paths)=cardinality(tree_blob_shas));
      create table if not exists jina_context_graph.trees (
        tenant_id text not null,
        tree_sha text not null,
        paths text[] not null,
        blob_shas text[] not null,
        primary key (tenant_id,tree_sha),
        constraint trees_arrays_match check (cardinality(paths)=cardinality(blob_shas))
      );
      insert into jina_context_graph.trees (tenant_id,tree_sha,paths,blob_shas)
      select distinct on (tenant_id,tree_sha) tenant_id,tree_sha,tree_paths,tree_blob_shas
      from jina_context_graph.commits
      where tree_recorded and cardinality(tree_paths) > 0
      order by tenant_id,tree_sha
      on conflict do nothing;
      create table if not exists jina_context_graph.refs (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        commit_sha text not null,
        updated_at timestamptz not null,
        primary key (tenant_id,repository,ref_name)
      );
      alter table jina_context_graph.refs add column if not exists is_default boolean not null default false;
      insert into jina_context_graph.graph_heads (tenant_id,repository,ref_name,graph_id,updated_at)
      select ref.tenant_id,ref.repository,ref.ref_name,graph.id,graph.generated_at
      from jina_context_graph.refs ref
      join lateral (
        select candidate.id,candidate.generated_at
        from jina_context_graph.graphs candidate
        where candidate.tenant_id=ref.tenant_id and candidate.repository=ref.repository
          and candidate.ref=ref.ref_name and candidate.commit_sha=ref.commit_sha and candidate.executor='projection'
        order by candidate.generated_at desc,candidate.id
        limit 1
      ) graph on true
      on conflict (tenant_id,repository,ref_name) do nothing;
      create table if not exists jina_context_graph.blobs (
        tenant_id text not null,
        blob_sha text not null,
        byte_size integer not null,
        primary key (tenant_id,blob_sha)
      );
      create table if not exists jina_context_graph.commit_changes (
        tenant_id text not null,
        repository text not null,
        commit_sha text not null,
        path text not null,
        change text not null check (change in ('add','modify','delete','rename')),
        old_path text,
        old_blob_sha text,
        new_blob_sha text,
        primary key (tenant_id,repository,commit_sha,path,change),
        foreign key (tenant_id,repository,commit_sha) references jina_context_graph.commits(tenant_id,repository,sha)
      );
      create index if not exists context_graph_commit_changes_path
        on jina_context_graph.commit_changes (tenant_id,repository,path,commit_sha);
      create or replace function jina_context_graph.commit_manifest(
        p_tenant_id text,
        p_repository text,
        p_commit_sha text
      ) returns table(path text,blob_sha text)
      language sql stable parallel safe
      as $manifest$
        with recursive target as (
          select tree_sha,tree_paths,tree_blob_shas,tree_recorded
          from jina_context_graph.commits
          where tenant_id=p_tenant_id and repository=p_repository and sha=p_commit_sha
        ), exact_tree as (
          select entry.path,entry.blob_sha
          from target
          join jina_context_graph.trees tree on tree.tenant_id=p_tenant_id and tree.tree_sha=target.tree_sha
          cross join lateral unnest(tree.paths,tree.blob_shas) as entry(path,blob_sha)
          where target.tree_recorded
          union all
          select entry.path,entry.blob_sha
          from target
          cross join lateral unnest(target.tree_paths,target.tree_blob_shas) as entry(path,blob_sha)
          where target.tree_recorded and not exists (
            select 1 from jina_context_graph.trees tree
            where tree.tenant_id=p_tenant_id and tree.tree_sha=target.tree_sha
          )
        ), ancestry(sha,depth,visited) as (
          select p_commit_sha,0,array[p_commit_sha]
          where not coalesce((select tree_recorded from target),false)
          union all
          select commit.parents[1],ancestry.depth+1,ancestry.visited || commit.parents[1]
          from ancestry
          join jina_context_graph.commits commit
            on commit.tenant_id=p_tenant_id and commit.repository=p_repository and commit.sha=ancestry.sha
          where cardinality(commit.parents)>0 and not commit.parents[1]=any(ancestry.visited)
        ), events as (
          select ancestry.depth,change.path,
                 case when change.change='delete' then null else change.new_blob_sha end as blob_sha
          from ancestry
          join jina_context_graph.commit_changes change
            on change.tenant_id=p_tenant_id and change.repository=p_repository and change.commit_sha=ancestry.sha
          union all
          select ancestry.depth,change.old_path as path,null as blob_sha
          from ancestry
          join jina_context_graph.commit_changes change
            on change.tenant_id=p_tenant_id and change.repository=p_repository and change.commit_sha=ancestry.sha
          where change.change='rename' and change.old_path is not null
        ), latest as (
          select events.path,events.blob_sha,
                 row_number() over (partition by events.path order by events.depth) as position
          from events
        )
        select exact_tree.path,exact_tree.blob_sha from exact_tree
        union all
        select latest.path,latest.blob_sha from latest
        where latest.position=1 and latest.blob_sha is not null
        order by path
      $manifest$;
      create table if not exists jina_context_graph.blob_analyses (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        language text,
        parsed_at timestamptz not null default now(),
        primary key (tenant_id,blob_sha,parser_version),
        foreign key (tenant_id,blob_sha) references jina_context_graph.blobs(tenant_id,blob_sha)
      );
      alter table jina_context_graph.blob_analyses add column if not exists parsed_at timestamptz not null default now();
      create table if not exists jina_context_graph.blob_symbols (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        moniker text not null,
        name text not null,
        kind text not null,
        start_line integer not null,
        end_line integer not null,
        primary key (tenant_id,blob_sha,parser_version,moniker),
        foreign key (tenant_id,blob_sha,parser_version) references jina_context_graph.blob_analyses(tenant_id,blob_sha,parser_version)
      );
      alter table jina_context_graph.blob_symbols add column if not exists signature_hash text;
      update jina_context_graph.blob_symbols set signature_hash=md5(moniker) where signature_hash is null;
      create table if not exists jina_context_graph.blob_imports (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        specifier text not null,
        line integer not null,
        primary key (tenant_id,blob_sha,parser_version,specifier,line),
        foreign key (tenant_id,blob_sha,parser_version) references jina_context_graph.blob_analyses(tenant_id,blob_sha,parser_version)
      );
      create table if not exists jina_context_graph.symbol_edges (
        tenant_id text not null,
        blob_sha text not null,
        parser_version text not null,
        from_moniker text not null,
        kind text not null check (kind in ('calls','imports','references','extends')),
        to_moniker text not null,
        start_line integer not null,
        end_line integer not null,
        primary key (tenant_id,blob_sha,parser_version,from_moniker,kind,to_moniker,start_line,end_line),
        foreign key (tenant_id,blob_sha,parser_version) references jina_context_graph.blob_analyses(tenant_id,blob_sha,parser_version)
      );
      create table if not exists jina_context_graph.entities (
        id text primary key,
        tenant_id text not null,
        kind text not null,
        natural_key text not null,
        display_name text not null,
        created_at timestamptz not null default now(),
        retired_at timestamptz,
        unique (tenant_id,kind,natural_key)
      );
      alter table jina_context_graph.entities drop constraint if exists context_graph_entities_kind_check;
      update jina_context_graph.entities set kind='Issue' where kind='VirtualIssue';
      alter table jina_context_graph.entities add constraint context_graph_entities_kind_check check (kind in (
        'Repository','File','Symbol','Commit','PullRequest','Issue','Engineer','Team','Document','Feature',
        'Package','Service','Deployment','Incident'
      ));
      create table if not exists jina_context_graph.identities (
        id text primary key,
        tenant_id text not null,
        source text not null,
        external_id text not null,
        entity_id text not null references jina_context_graph.entities(id),
        status text not null check (status in ('proposed','accepted','rejected','erased')),
        confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
        source_observation_id text references jina_context_graph.observations(id),
        created_at timestamptz not null,
        unique (tenant_id,source,external_id,entity_id)
      );
      create unique index if not exists context_graph_identities_one_accepted
        on jina_context_graph.identities (tenant_id,source,external_id) where status='accepted';
      create table if not exists jina_context_graph.audit_log (
        id text primary key,
        tenant_id text not null,
        actor_id text not null,
        action text not null,
        input jsonb not null,
        result text not null check (result in ('accepted','rejected')),
        reason text,
        parent_audit_id text references jina_context_graph.audit_log(id),
        created_at timestamptz not null
      );
      create index if not exists context_graph_audit_tenant_created
        on jina_context_graph.audit_log (tenant_id,created_at desc);
      create table if not exists jina_context_graph.entity_redirects (
        id text primary key,
        tenant_id text not null,
        from_entity_id text not null references jina_context_graph.entities(id),
        to_entity_id text not null references jina_context_graph.entities(id),
        kind text not null check (kind in ('merge','unmerge')),
        audit_id text not null references jina_context_graph.audit_log(id),
        created_at timestamptz not null,
        check (from_entity_id <> to_entity_id)
      );
      create index if not exists context_graph_entity_redirects_tenant_created
        on jina_context_graph.entity_redirects (tenant_id,created_at desc);
      create index if not exists context_graph_entity_redirects_from_created
        on jina_context_graph.entity_redirects (tenant_id,from_entity_id,created_at,id);
      create table if not exists jina_context_graph.assertions (
        id text primary key,
        tenant_id text not null,
        repository text not null,
        commit_sha text not null,
        subject_id text not null references jina_context_graph.entities(id),
        subject_kind text not null,
        subject_natural_key text not null,
        subject_label text not null,
        predicate text not null,
        object_id text not null references jina_context_graph.entities(id),
        object_kind text not null,
        object_natural_key text not null,
        object_label text not null,
        status text not null check (status in ('proposed','active','rejected','superseded','retracted')),
        confidence double precision not null check (confidence >= 0 and confidence <= 1),
        evidence jsonb not null,
        source_observation_id text not null,
        generator_version text not null,
        registry_version text not null,
        recorded_at timestamptz not null
      );
      create index if not exists context_graph_assertions_current
        on jina_context_graph.assertions (tenant_id,repository,commit_sha,status);
      create index if not exists context_graph_assertions_review_queue
        on jina_context_graph.assertions (tenant_id,repository,status,recorded_at desc,id);
      alter table jina_context_graph.assertions alter column object_id drop not null;
      alter table jina_context_graph.assertions alter column source_observation_id drop not null;
      alter table jina_context_graph.assertions alter column object_kind drop not null;
      alter table jina_context_graph.assertions alter column object_natural_key drop not null;
      alter table jina_context_graph.assertions alter column object_label drop not null;
      alter table jina_context_graph.assertions alter column confidence drop not null;
      alter table jina_context_graph.assertions add column if not exists explanation text;
      alter table jina_context_graph.assertions add column if not exists qualifiers jsonb not null default '{}'::jsonb;
      update jina_context_graph.assertions
        set explanation=qualifiers->>'reason'
        where explanation is null and nullif(btrim(qualifiers->>'reason'),'') is not null;
      create or replace function jina_context_graph.enforce_assertion_explanation()
      returns trigger language plpgsql as $$
      begin
        if new.explanation is null or btrim(new.explanation) = '' then
          raise exception 'assertion explanation is required';
        end if;
        if tg_op = 'UPDATE' and old.explanation is not null and new.explanation is distinct from old.explanation then
          raise exception 'assertion explanation is immutable';
        end if;
        return new;
      end;
      $$;
      drop trigger if exists context_graph_assertion_explanation_guard on jina_context_graph.assertions;
      create trigger context_graph_assertion_explanation_guard
        before insert or update of explanation on jina_context_graph.assertions
        for each row execute function jina_context_graph.enforce_assertion_explanation();
      alter table jina_context_graph.assertions add column if not exists qualifiers_hash text not null default 'q_empty';
      alter table jina_context_graph.assertions add column if not exists asserted_by text;
      alter table jina_context_graph.assertions add column if not exists generator text;
      alter table jina_context_graph.assertions add column if not exists valid_from timestamptz;
      alter table jina_context_graph.assertions add column if not exists valid_to timestamptz;
      alter table jina_context_graph.assertions add column if not exists last_confirmed_at timestamptz;
      alter table jina_context_graph.assertions add column if not exists superseded_by text references jina_context_graph.assertions(id);
      alter table jina_context_graph.assertions add column if not exists audit_id text references jina_context_graph.audit_log(id);
      update jina_context_graph.assertions set last_confirmed_at=recorded_at where last_confirmed_at is null;
      drop index if exists jina_context_graph.context_graph_assertions_cardinality;
      create index if not exists context_graph_assertions_cardinality_repository
        on jina_context_graph.assertions (tenant_id,repository,subject_id,predicate,qualifiers_hash,status);
      create index if not exists context_graph_assertions_active_subject
        on jina_context_graph.assertions (tenant_id,repository,subject_id,predicate) where status='active';
      create index if not exists context_graph_assertions_active_object
        on jina_context_graph.assertions (tenant_id,repository,object_id,predicate) where status='active';
      create table if not exists jina_context_graph.assertion_relations (
        id text primary key,
        tenant_id text not null,
        source_assertion_id text not null references jina_context_graph.assertions(id),
        relation text not null check (relation in ('supports','contradicts')),
        target_assertion_id text not null references jina_context_graph.assertions(id),
        evidence_observation_id text not null references jina_context_graph.observations(id),
        created_at timestamptz not null,
        check (source_assertion_id <> target_assertion_id),
        unique (tenant_id,source_assertion_id,relation,target_assertion_id,evidence_observation_id)
      );
      create index if not exists context_graph_assertion_relations_source
        on jina_context_graph.assertion_relations (tenant_id,source_assertion_id,relation);
      create index if not exists context_graph_assertion_relations_target
        on jina_context_graph.assertion_relations (tenant_id,target_assertion_id,relation);
      create table if not exists jina_context_graph.outbox (
        id text primary key,
        tenant_id text not null,
        event_type text not null,
        consumer text not null default 'legacy',
        aggregate_id text not null,
        payload jsonb not null,
        created_at timestamptz not null,
        available_at timestamptz not null,
        claimed_by text,
        claimed_at timestamptz,
        claim_expires_at timestamptz,
        processed_at timestamptz,
        attempts integer not null default 0,
        last_error text
      );
      alter table jina_context_graph.outbox add column if not exists consumer text not null default 'legacy';
      alter table jina_context_graph.outbox drop constraint if exists context_graph_outbox_consumer_check;
      alter table jina_context_graph.outbox add constraint context_graph_outbox_consumer_check
        check (consumer in ('legacy','manifest','search','reconciliation','graph'));
      drop index if exists jina_context_graph.context_graph_outbox_claim;
      create index context_graph_outbox_claim
        on jina_context_graph.outbox (consumer,available_at,created_at) where processed_at is null;
      create table if not exists jina_context_graph.ref_manifest (
        tenant_id text not null,
        repository text not null,
        ref_name text not null,
        commit_sha text not null,
        path text not null,
        blob_sha text not null,
        projected_at timestamptz not null,
        primary key (tenant_id,repository,ref_name,path)
      );
      create index if not exists context_graph_ref_manifest_blob on jina_context_graph.ref_manifest (tenant_id,repository,ref_name,blob_sha);
      create table if not exists jina_context_graph.search_documents (
        id text primary key,
        tenant_id text not null,
        repository text not null,
        source_kind text not null,
        source_id text not null,
        title text not null,
        body text not null,
        search_vector tsvector generated always as (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) stored,
        embedding double precision[],
        projected_at timestamptz not null,
        unique (tenant_id,source_kind,source_id)
      );
      alter table jina_context_graph.search_documents
        drop constraint if exists search_documents_tenant_id_source_kind_source_id_key;
      create unique index if not exists context_graph_search_documents_scoped_source
        on jina_context_graph.search_documents (tenant_id,repository,source_kind,source_id);
      create index if not exists context_graph_search_documents_lexical on jina_context_graph.search_documents using gin(search_vector);
      create table if not exists jina_context_graph.retrieval_metrics (
        id bigint generated always as identity primary key,
        tenant_id text not null,
        repository text not null,
        template text not null,
        request_id text not null,
        principal_id text not null,
        access_channel text not null,
        duration_ms double precision not null check (duration_ms>=0),
        truncated boolean not null,
        recorded_at timestamptz not null
      );
      alter table jina_context_graph.retrieval_metrics add column if not exists request_id text;
      alter table jina_context_graph.retrieval_metrics add column if not exists principal_id text;
      alter table jina_context_graph.retrieval_metrics add column if not exists access_channel text;
      update jina_context_graph.retrieval_metrics
         set request_id=coalesce(request_id,'legacy-' || id::text),
             principal_id=coalesce(principal_id,'svc:legacy'),
             access_channel=coalesce(access_channel,'direct')
       where request_id is null or principal_id is null or access_channel is null;
      alter table jina_context_graph.retrieval_metrics alter column request_id set not null;
      alter table jina_context_graph.retrieval_metrics alter column principal_id set not null;
      alter table jina_context_graph.retrieval_metrics alter column access_channel set not null;
      alter table jina_context_graph.retrieval_metrics
        drop constraint if exists context_graph_retrieval_metrics_access_channel_check;
      alter table jina_context_graph.retrieval_metrics
        add constraint context_graph_retrieval_metrics_access_channel_check
        check (access_channel in ('mcp','api','admin','direct'));
      create index if not exists context_graph_retrieval_metrics_recent
        on jina_context_graph.retrieval_metrics (tenant_id,recorded_at desc,template);
      create index if not exists context_graph_retrieval_metrics_access_recent
        on jina_context_graph.retrieval_metrics (tenant_id,recorded_at desc,access_channel,principal_id);
      create table if not exists jina_context_graph.erasure_filters (
        id text primary key,
        tenant_id text not null,
        kind text not null check (kind in ('identity','observation','commit','repository')),
        value text not null,
        audit_id text not null references jina_context_graph.audit_log(id),
        created_at timestamptz not null,
        unique (tenant_id,kind,value)
      );
      create table if not exists jina_context_graph.repository_acl (
        tenant_id text not null,
        repository text not null,
        principal_id text not null,
        role text not null check (role in ('reader','writer','admin')),
        created_at timestamptz not null default now(),
        primary key (tenant_id,repository,principal_id)
      );
      create unique index if not exists context_graph_observations_tenant_identity
        on jina_context_graph.observations (tenant_id,id);
      create unique index if not exists context_graph_entities_tenant_identity
        on jina_context_graph.entities (tenant_id,id);
      create unique index if not exists context_graph_audit_tenant_identity
        on jina_context_graph.audit_log (tenant_id,id);
      create unique index if not exists context_graph_assertions_tenant_identity
        on jina_context_graph.assertions (tenant_id,id);
      drop index if exists jina_context_graph.context_graph_assertions_one_active;
      -- Legacy data can hold duplicate active rows for predicates the old
      -- hardcoded index did not cover; creating the widened index over them
      -- would raise 23505 on every boot. Reconcile first with the same winner
      -- rule the reconciliation worker uses, as an audited migration action.
      do $$
      declare grp record; winner_id text; loser_ids text[]; migration_audit_id text;
      begin
        for grp in
          select tenant_id,repository,subject_id,predicate,qualifiers_hash
          from jina_context_graph.assertions
          where status='active' and predicate in (${cardinalityOnePredicates.map((name) => `'${name}'`).join(",")})
          group by tenant_id,repository,subject_id,predicate,qualifiers_hash
          having count(*) > 1
        loop
          select id into winner_id from jina_context_graph.assertions
          where tenant_id=grp.tenant_id and repository=grp.repository and subject_id=grp.subject_id
            and predicate=grp.predicate and qualifiers_hash=grp.qualifiers_hash and status='active'
          order by coalesce(valid_from,recorded_at) desc, recorded_at desc, id desc limit 1;
          select array_agg(id) into loser_ids from jina_context_graph.assertions
          where tenant_id=grp.tenant_id and repository=grp.repository and subject_id=grp.subject_id
            and predicate=grp.predicate and qualifiers_hash=grp.qualifiers_hash and status='active'
            and id <> winner_id;
          migration_audit_id := 'audit_migration_' || md5(grp.tenant_id||':'||grp.repository||':'||grp.subject_id||':'||grp.predicate||':'||grp.qualifiers_hash);
          insert into jina_context_graph.audit_log (id,tenant_id,actor_id,action,input,result,created_at)
          values (migration_audit_id, grp.tenant_id, 'svc:schema-migration', 'reconcile_cardinality_backstop',
                  jsonb_build_object('winnerId',winner_id,'supersededIds',to_jsonb(loser_ids),'predicate',grp.predicate),
                  'accepted', now())
          on conflict (id) do nothing;
          update jina_context_graph.assertions
            set status='superseded', valid_to=now(), superseded_by=winner_id, audit_id=migration_audit_id
          where id = any(loser_ids);
        end loop;
      end $$;
      do $$ declare stale record; begin
        for stale in
          select indexname from pg_indexes
          where schemaname='jina_context_graph' and indexname like 'context_graph_assertions_one_active%'
            and indexname <> '${oneActiveIndexName}'
        loop
          execute format('drop index jina_context_graph.%I', stale.indexname);
        end loop;
      end $$;
      create unique index if not exists ${oneActiveIndexName}
        on jina_context_graph.assertions (tenant_id,repository,subject_id,predicate,qualifiers_hash)
        where status='active' and predicate in (${cardinalityOnePredicates.map((name) => `'${name}'`).join(",")});
      drop index if exists jina_context_graph.context_graph_assertions_one_live_candidate;
      create unique index if not exists context_graph_assertions_one_live_candidate_repository
        on jina_context_graph.assertions (tenant_id,repository,subject_id,predicate,object_id,qualifiers_hash)
        where status in ('proposed','active');
      do $$ begin
        if not exists (select 1 from pg_constraint where conname='commits_observation_same_tenant') then
          alter table jina_context_graph.commits add constraint commits_observation_same_tenant
            foreign key (tenant_id,source_observation_id) references jina_context_graph.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='refs_commit_same_tenant_repository') then
          alter table jina_context_graph.refs add constraint refs_commit_same_tenant_repository
            foreign key (tenant_id,repository,commit_sha) references jina_context_graph.commits(tenant_id,repository,sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='commit_changes_old_blob_same_tenant') then
          alter table jina_context_graph.commit_changes add constraint commit_changes_old_blob_same_tenant
            foreign key (tenant_id,old_blob_sha) references jina_context_graph.blobs(tenant_id,blob_sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='commit_changes_new_blob_same_tenant') then
          alter table jina_context_graph.commit_changes add constraint commit_changes_new_blob_same_tenant
            foreign key (tenant_id,new_blob_sha) references jina_context_graph.blobs(tenant_id,blob_sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='identities_entity_same_tenant') then
          alter table jina_context_graph.identities add constraint identities_entity_same_tenant
            foreign key (tenant_id,entity_id) references jina_context_graph.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='identities_observation_same_tenant') then
          alter table jina_context_graph.identities add constraint identities_observation_same_tenant
            foreign key (tenant_id,source_observation_id) references jina_context_graph.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='audit_parent_same_tenant') then
          alter table jina_context_graph.audit_log add constraint audit_parent_same_tenant
            foreign key (tenant_id,parent_audit_id) references jina_context_graph.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='redirect_from_entity_same_tenant') then
          alter table jina_context_graph.entity_redirects add constraint redirect_from_entity_same_tenant
            foreign key (tenant_id,from_entity_id) references jina_context_graph.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='redirect_to_entity_same_tenant') then
          alter table jina_context_graph.entity_redirects add constraint redirect_to_entity_same_tenant
            foreign key (tenant_id,to_entity_id) references jina_context_graph.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='redirect_audit_same_tenant') then
          alter table jina_context_graph.entity_redirects add constraint redirect_audit_same_tenant
            foreign key (tenant_id,audit_id) references jina_context_graph.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_subject_same_tenant') then
          alter table jina_context_graph.assertions add constraint assertions_subject_same_tenant
            foreign key (tenant_id,subject_id) references jina_context_graph.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_object_same_tenant') then
          alter table jina_context_graph.assertions add constraint assertions_object_same_tenant
            foreign key (tenant_id,object_id) references jina_context_graph.entities(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_observation_same_tenant') then
          alter table jina_context_graph.assertions add constraint assertions_observation_same_tenant
            foreign key (tenant_id,source_observation_id) references jina_context_graph.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_superseded_same_tenant') then
          alter table jina_context_graph.assertions add constraint assertions_superseded_same_tenant
            foreign key (tenant_id,superseded_by) references jina_context_graph.assertions(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_audit_same_tenant') then
          alter table jina_context_graph.assertions add constraint assertions_audit_same_tenant
            foreign key (tenant_id,audit_id) references jina_context_graph.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertion_relations_source_same_tenant') then
          alter table jina_context_graph.assertion_relations add constraint assertion_relations_source_same_tenant
            foreign key (tenant_id,source_assertion_id) references jina_context_graph.assertions(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertion_relations_target_same_tenant') then
          alter table jina_context_graph.assertion_relations add constraint assertion_relations_target_same_tenant
            foreign key (tenant_id,target_assertion_id) references jina_context_graph.assertions(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertion_relations_evidence_same_tenant') then
          alter table jina_context_graph.assertion_relations add constraint assertion_relations_evidence_same_tenant
            foreign key (tenant_id,evidence_observation_id) references jina_context_graph.observations(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='erasure_audit_same_tenant') then
          alter table jina_context_graph.erasure_filters add constraint erasure_audit_same_tenant
            foreign key (tenant_id,audit_id) references jina_context_graph.audit_log(tenant_id,id) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='manifest_commit_same_tenant_repository') then
          alter table jina_context_graph.ref_manifest add constraint manifest_commit_same_tenant_repository
            foreign key (tenant_id,repository,commit_sha) references jina_context_graph.commits(tenant_id,repository,sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='manifest_blob_same_tenant') then
          alter table jina_context_graph.ref_manifest add constraint manifest_blob_same_tenant
            foreign key (tenant_id,blob_sha) references jina_context_graph.blobs(tenant_id,blob_sha) not valid;
        end if;
        if not exists (select 1 from pg_constraint where conname='assertions_exactly_one_provenance') then
          alter table jina_context_graph.assertions add constraint assertions_exactly_one_provenance
            check ((source_observation_id is null) <> (asserted_by is null)) not valid;
        end if;
      end $$;
    `;

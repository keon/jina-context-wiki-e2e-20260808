import type { EvidenceAnchor, IndexGeneration, QueryMetrics, QueryRunTelemetry } from "@jina/context-engine";
import { ContextDatabase, dateString } from "./database.js";

export interface StoredRetrievalCandidate {
  readonly id: string;
  readonly documentId: string;
  readonly fragmentId?: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceRevisionId?: string;
  readonly title: string;
  readonly text: string;
  readonly contextualText: string;
  readonly anchors: readonly EvidenceAnchor[];
  readonly authorityClass: string;
  readonly sourceFingerprint: string;
  readonly effectiveAclFingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly exactScore: number;
  readonly proseScore: number;
}

export interface QueryRunStart {
  readonly id: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly principalFingerprint: string;
  readonly generationId: string;
  readonly requestFingerprint: string;
  readonly taskKind?: string;
  readonly routes: readonly string[];
  readonly startedAt: string;
}

export class PostgresContextQueryRepository {
  constructor(private readonly database: ContextDatabase) {}

  async authorize(
    tenantId: string,
    repository: string,
    principalId: string,
    generationId: string
  ): Promise<{ readonly allowed: boolean; readonly aclFingerprint?: string }> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ permission: string; acl_fingerprint: string }>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select acl.permission,acl.acl_fingerprint
       from jina_context.current_repository_acl acl
       join jina_context.index_generations generation
         on generation.id=$4 and generation.tenant_id=acl.tenant_id
        and generation.repository=acl.repository and generation.status='published'
       where acl.tenant_id=$1 and acl.repository=$2 and acl.principal_id=$3
      limit 1`,
      [tenantId, repository, principalId, generationId],
      "query.authorize"
    );
    const row = result.rows[0];
    return row && ["read", "write", "admin"].includes(row.permission)
      ? { allowed: true, aclFingerprint: row.acl_fingerprint }
      : { allowed: false };
  }

  async latestPublished(
    tenantId: string,
    repository: string,
    ref: string,
    principalId: string
  ): Promise<IndexGeneration | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<GenerationQueryRow>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select generation.*,coalesce(projector.statuses,'{}'::jsonb) as projector_statuses
       from jina_context.current_context_board_releases current_release
       join jina_context.index_generations generation
         on generation.id=current_release.release_id
        and generation.tenant_id=current_release.tenant_id
        and generation.repository=current_release.repository
        and generation.ref_name=current_release.ref_name
       left join lateral (
         select jsonb_object_agg(status.consumer,status.status) as statuses
         from jina_context.generation_projectors status
         where status.generation_id=generation.id
       ) projector on true
       where current_release.tenant_id=$1 and current_release.repository=$2
         and current_release.ref_name=$3 and generation.status='published'
         and exists (
           select 1 from jina_context.current_repository_acl acl
           where acl.tenant_id=generation.tenant_id and acl.repository=generation.repository
             and acl.principal_id=$4
             and acl.permission in ('read','write','admin')
         )
      limit 1`,
      [tenantId, repository, ref, principalId],
      "query.latest-published"
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      repository: row.repository,
      repositoryAccessFingerprint: row.acl_fingerprint,
      projectionInputFingerprint: row.projection_input_fingerprint,
      ref: row.ref_name,
      commitSha: row.commit_sha,
      checkpointId: row.checkpoint_id,
      status: "published",
      projectorVersions: row.projector_versions,
      projectorStatuses: row.projector_statuses,
      capabilities: row.capabilities,
      fingerprint: row.required_fingerprint,
      createdAt: dateString(row.created_at),
      publishedAt: dateString(row.published_at)
    };
  }

  async lexicalSearch(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly query: string;
    readonly limit: number;
    readonly sourceKinds?: readonly string[];
  }): Promise<readonly StoredRetrievalCandidate[]> {
    await this.database.initialize();
    const limit = Math.max(1, Math.min(input.limit, 200));
    const result = await this.database.queryAs<CandidateRow>(
      "jina_context_query",
      { tenantIds: [input.tenantId] },
      `with authorized as materialized (
         select acl.acl_fingerprint
         from jina_context.current_repository_acl acl
         join jina_context.index_generations generation
           on generation.id=$4 and generation.tenant_id=acl.tenant_id
          and generation.repository=acl.repository
         where acl.tenant_id=$1 and acl.repository=$2 and acl.principal_id=$3
           and acl.permission in ('read','write','admin') and generation.status='published'
       ), query as (
         select to_tsquery('simple',$5) exact,
                to_tsquery('english',$5) prose
       )
       select document.id as document_id,fragment.id as fragment_id,
              document.source_kind,document.source_id,document.source_revision_id,
              document.title,fragment.source_text,fragment.contextual_text,
              fragment.source_anchors,document.authority_class,document.source_fingerprint,
              document.effective_acl_fingerprint,document.metadata,
              ts_rank_cd(fragment.exact_vector,query.exact) as exact_score,
              ts_rank_cd(fragment.prose_vector,query.prose) as prose_score
       from authorized
       cross join query
       join jina_context.published_context_fragments fragment
         on fragment.generation_id=$4
        and fragment.effective_acl_fingerprint=authorized.acl_fingerprint
       join jina_context.published_context_documents document
         on document.generation_id=fragment.generation_id and document.id=fragment.document_id
       where (fragment.exact_vector @@ query.exact or fragment.prose_vector @@ query.prose)
         and ($6::text[] is null or document.source_kind=any($6))
       order by greatest(
         ts_rank_cd(fragment.exact_vector,query.exact)*2,
         ts_rank_cd(fragment.prose_vector,query.prose)
       ) desc,fragment.id
       limit $7`,
      [
        input.tenantId,
        input.repository,
        input.principalId,
        input.generationId,
        input.query,
        input.sourceKinds ?? null,
        limit
      ],
      "query.lexical"
    );
    return result.rows.map(candidateFromRow);
  }

  async exactLookup(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly terms: readonly string[];
    readonly limit: number;
  }): Promise<readonly StoredRetrievalCandidate[]> {
    await this.database.initialize();
    // Keep a multi-target exact route inside one transaction. Candidate
    // selection rotates across requested terms before applying the global
    // limit, while final ranking uses the number of distinct matched terms to
    // preserve the in-memory ExactRetriever's score semantics.
    const result = await this.database.queryAs<CandidateRow>(
      "jina_context_query",
      { tenantIds: [input.tenantId] },
      `with requested_terms as materialized (
         select distinct on (lower(requested.term))
                lower(requested.term) as term,requested.ordinality as term_ordinal
         from unnest($5::text[]) with ordinality as requested(term,ordinality)
         order by lower(requested.term),requested.ordinality
       ), authorized as materialized (
         select acl.acl_fingerprint
         from jina_context.current_repository_acl acl
         join jina_context.index_generations generation
           on generation.id=$4 and generation.tenant_id=acl.tenant_id
          and generation.repository=acl.repository and generation.status='published'
         where acl.tenant_id=$1 and acl.repository=$2 and acl.principal_id=$3
           and acl.permission in ('read','write','admin')
       ), term_matches as materialized (
         select exact.document_id,requested.term,requested.term_ordinal,
                max(case exact.field when 'title' then 1.0 when 'metadata' then 0.9 else 0.8 end) as field_score
         from requested_terms requested
         join jina_context.exact_index exact
           on exact.generation_id=$4 and exact.term=requested.term
         join jina_context.published_context_documents document
           on document.generation_id=exact.generation_id and document.id=exact.document_id
         join authorized
           on authorized.acl_fingerprint=document.effective_acl_fingerprint
         where document.tenant_id=$1 and document.repository=$2
         group by exact.document_id,requested.term,requested.term_ordinal
       ), document_scores as materialized (
         select document_id,count(*)::double precision as exact_score
         from term_matches
         group by document_id
       ), ranked_term_matches as (
         select matched.document_id,matched.term_ordinal,scores.exact_score,
                row_number() over (
                  partition by matched.term
                  order by scores.exact_score desc,matched.field_score desc,matched.document_id
                ) as coverage_round
         from term_matches matched
         join document_scores scores using (document_id)
       ), document_priority as (
         select distinct on (document_id)
                document_id,exact_score,coverage_round,term_ordinal
         from ranked_term_matches
         order by document_id,coverage_round,term_ordinal
       ), selected_documents as materialized (
         select document_id,exact_score
         from document_priority
         order by coverage_round,term_ordinal,exact_score desc,document_id
         limit $6
       )
       select document.id as document_id,fragment.id as fragment_id,
              document.source_kind,document.source_id,document.source_revision_id,
              document.title,fragment.source_text,fragment.contextual_text,
              fragment.source_anchors,document.authority_class,document.source_fingerprint,
              document.effective_acl_fingerprint,document.metadata,
              selected.exact_score,0::double precision as prose_score
       from selected_documents selected
       join jina_context.published_context_documents document
         on document.generation_id=$4 and document.id=selected.document_id
       join lateral (
         select candidate.*
         from jina_context.published_context_fragments candidate
         where candidate.generation_id=document.generation_id
           and candidate.document_id=document.id
         order by candidate.ordinal
         limit 1
       ) fragment on true
       order by selected.exact_score desc,document.id`,
      [
        input.tenantId,
        input.repository,
        input.principalId,
        input.generationId,
        input.terms.slice(0, 50),
        Math.max(1, Math.min(input.limit, 200))
      ],
      "query.exact"
    );
    return result.rows.map(candidateFromRow);
  }

  async hierarchySearch(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly StoredRetrievalCandidate[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<CandidateRow>(
      "jina_context_query",
      { tenantIds: [input.tenantId] },
      `with query as (
         select to_tsquery('simple',$5) value
       )
       select document.id as document_id,node.id as fragment_id,
              document.source_kind,document.source_id,document.source_revision_id,
              document.title,node.summary as source_text,
              concat_ws(' ',document.contextual_text,node.title) as contextual_text,
              node.source_anchors,document.authority_class,document.source_fingerprint,
              document.effective_acl_fingerprint,
              document.metadata || jsonb_build_object(
                'hierarchyNodeId',node.id,
                'hierarchyDepth',node.depth,
                'hierarchyAdapter',node.adapter_name
              ) as metadata,
              0::double precision as exact_score,
              ts_rank_cd(node.search_vector,query.value)::double precision as prose_score
       from query
       join jina_context.published_hierarchy_nodes node
         on node.generation_id=$4 and node.search_vector @@ query.value
       join jina_context.published_context_documents document
         on document.generation_id=node.generation_id and document.id=node.document_id
       join jina_context.current_repository_acl acl
         on acl.tenant_id=document.tenant_id and acl.repository=document.repository
        and acl.principal_id=$3 and acl.permission in ('read','write','admin')
        and acl.acl_fingerprint=document.effective_acl_fingerprint
       where document.tenant_id=$1 and document.repository=$2
       order by prose_score desc,node.depth,node.preorder_start,node.id
       limit $6`,
      [
        input.tenantId,
        input.repository,
        input.principalId,
        input.generationId,
        input.query,
        Math.max(1, Math.min(input.limit, 200))
      ],
      "query.hierarchy"
    );
    return result.rows.map(candidateFromRow);
  }

  async longContextSearch(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly StoredRetrievalCandidate[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<CandidateRow>(
      "jina_context_query",
      { tenantIds: [input.tenantId] },
      `with query as (
         select to_tsquery('simple',$5) exact,
                to_tsquery('english',$5) prose
       )
       select document.id as document_id,null::text as fragment_id,
              document.source_kind,document.source_id,document.source_revision_id,
              document.title,
              ts_headline(
                'english',
                document.body,
                query.prose,
                'MaxFragments=3,MaxWords=120,MinWords=20,StartSel="",StopSel=""'
              ) as source_text,
              document.contextual_text,document.source_anchors,
              document.authority_class,document.source_fingerprint,
              document.effective_acl_fingerprint,document.metadata,
              ts_rank_cd(document.exact_vector,query.exact)::double precision as exact_score,
              ts_rank_cd(document.prose_vector,query.prose)::double precision as prose_score
       from query
       join jina_context.published_context_documents document
         on document.generation_id=$4
        and (document.exact_vector @@ query.exact or document.prose_vector @@ query.prose)
       join jina_context.current_repository_acl acl
         on acl.tenant_id=document.tenant_id and acl.repository=document.repository
        and acl.principal_id=$3 and acl.permission in ('read','write','admin')
        and acl.acl_fingerprint=document.effective_acl_fingerprint
       where document.tenant_id=$1 and document.repository=$2
         and length(document.body) >= 16000
       order by greatest(
         ts_rank_cd(document.exact_vector,query.exact)*2,
         ts_rank_cd(document.prose_vector,query.prose)
       ) desc,document.id
       limit $6`,
      [
        input.tenantId,
        input.repository,
        input.principalId,
        input.generationId,
        input.query,
        Math.max(1, Math.min(input.limit, 50))
      ],
      "query.long-context"
    );
    return result.rows.map(candidateFromRow);
  }

  async browse(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly limit: number;
    readonly sourceKinds: readonly string[];
    readonly timeWindow?: { readonly from?: string; readonly to?: string };
  }): Promise<readonly StoredRetrievalCandidate[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<CandidateRow>(
      "jina_context_query",
      { tenantIds: [input.tenantId] },
      `select document.id as document_id,fragment.id as fragment_id,
              document.source_kind,document.source_id,document.source_revision_id,
              document.title,fragment.source_text,fragment.contextual_text,
              fragment.source_anchors,document.authority_class,document.source_fingerprint,
              document.effective_acl_fingerprint,document.metadata,
              1::double precision as exact_score,
              1::double precision as prose_score
       from jina_context.published_context_documents document
       join jina_context.published_context_fragments fragment
         on fragment.generation_id=document.generation_id and fragment.document_id=document.id
       join jina_context.current_repository_acl acl
         on acl.tenant_id=document.tenant_id and acl.repository=document.repository
        and acl.principal_id=$3 and acl.permission in ('read','write','admin')
        and acl.acl_fingerprint=document.effective_acl_fingerprint
       where document.tenant_id=$1 and document.repository=$2 and document.generation_id=$4
         and document.source_kind=any($5)
         and (
           $6::text is null or exists (
             select 1 from jsonb_array_elements(fragment.source_anchors) anchor
             where anchor->>'observedAt' >= $6
           )
         )
         and (
           $7::text is null or exists (
             select 1 from jsonb_array_elements(fragment.source_anchors) anchor
             where anchor->>'observedAt' <= $7
           )
         )
       order by (
         select max(anchor->>'observedAt')
         from jsonb_array_elements(fragment.source_anchors) anchor
       ) desc nulls last,document.id,fragment.ordinal
       limit $8`,
      [
        input.tenantId,
        input.repository,
        input.principalId,
        input.generationId,
        input.sourceKinds,
        input.timeWindow?.from ?? null,
        input.timeWindow?.to ?? null,
        Math.max(1, Math.min(input.limit, 200))
      ],
      "query.browse"
    );
    return result.rows.map(candidateFromRow);
  }

  async structuralNeighbors(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly identifier: string;
    readonly relationKinds?: readonly string[];
    readonly limit: number;
  }): Promise<
    readonly {
      id: string;
      kind: string;
      from: string;
      to: string;
      anchors: readonly EvidenceAnchor[];
      metadata: Record<string, unknown>;
    }[]
  > {
    await this.database.initialize();
    const result = await this.database.queryAs<{
      id: string;
      relation_kind: string;
      source_id: string;
      target_id: string;
      source_anchors: EvidenceAnchor[];
      metadata: Record<string, unknown>;
    }>(
      "jina_context_query",
      { tenantIds: [input.tenantId] },
      `with authorized as materialized (
         select acl.acl_fingerprint
         from jina_context.current_repository_acl acl
         where acl.tenant_id=$1 and acl.repository=$2 and acl.principal_id=$3
           and acl.permission in ('read','write','admin')
       )
       select relation.*
       from authorized
       join jina_context.published_structural_relations relation
         on relation.tenant_id=$1 and relation.repository=$2 and relation.generation_id=$4
       where (
           lower(relation.source_id)=lower($5)
           or lower(relation.target_id)=lower($5)
           or right(lower(relation.source_id),char_length($5)+1)='#' || lower($5)
           or right(lower(relation.target_id),char_length($5)+1)='#' || lower($5)
         )
         and ($6::text[] is null or relation.relation_kind=any($6))
         and not exists (
           select 1
           from jsonb_array_elements(relation.source_anchors) relation_anchor
           where not exists (
             select 1
             from jina_context.published_context_documents document
             cross join lateral jsonb_array_elements(document.source_anchors) document_anchor
             where document.generation_id=relation.generation_id
               and document.effective_acl_fingerprint=authorized.acl_fingerprint
               and document_anchor->>'sourceType'=relation_anchor->>'sourceType'
               and document_anchor->>'sourceId'=relation_anchor->>'sourceId'
               and document_anchor->>'contentDigest'=relation_anchor->>'contentDigest'
           )
         )
       order by relation.relation_kind,relation.id limit $7`,
      [
        input.tenantId,
        input.repository,
        input.principalId,
        input.generationId,
        input.identifier,
        input.relationKinds ?? null,
        Math.max(1, Math.min(input.limit, 500))
      ],
      "query.structural"
    );
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.relation_kind,
      from: row.source_id,
      to: row.target_id,
      anchors: row.source_anchors,
      metadata: row.metadata
    }));
  }

  async startQueryRun(run: QueryRunStart): Promise<void> {
    await this.database.initialize();
    await this.database.queryAs(
      "jina_context_query",
      { tenantIds: [run.tenantId] },
      `insert into jina_context.query_runs
        (id,tenant_id,repository,principal_fingerprint,generation_id,request_fingerprint,
         task_kind,routes,coverage_status,degraded_capabilities,started_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'insufficient','{}',$9)`,
      [
        run.id,
        run.tenantId,
        run.repository,
        run.principalFingerprint,
        run.generationId,
        run.requestFingerprint,
        run.taskKind ?? null,
        run.routes,
        run.startedAt
      ],
      "query.run.start"
    );
  }

  async completeQueryRun(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly coverageStatus: "complete" | "partial" | "insufficient";
    readonly degradedCapabilities: readonly string[];
    readonly completedAt: string;
    readonly durationMs: number;
    readonly failureKind?: string;
  }): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_query",
      { tenantIds: [input.tenantId] },
      `update jina_context.query_runs
       set coverage_status=$2,degraded_capabilities=$3,completed_at=$4,duration_ms=$5,failure_kind=$6
       where id=$1 and completed_at is null`,
      [
        input.id,
        input.coverageStatus,
        input.degradedCapabilities,
        input.completedAt,
        input.durationMs,
        input.failureKind ?? null
      ],
      "query.run.complete"
    );
    return result.rowCount === 1;
  }

  async recordQueryRun(run: QueryRunTelemetry): Promise<void> {
    await this.database.transactionAs(
      "jina_context_query",
      { tenantIds: [run.tenantId] },
      async (client) => {
        const inserted = await client.query(
          `insert into jina_context.query_runs
          (id,tenant_id,repository,principal_fingerprint,generation_id,request_fingerprint,
           task_kind,routes,coverage_status,degraded_capabilities,started_at,completed_at,
           duration_ms,citation_failure_count,conflict_count)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict (id) do nothing
         returning id`,
          [
            run.id,
            run.tenantId,
            run.repository,
            run.principalFingerprint,
            run.generationId,
            run.requestFingerprint,
            run.taskKind ?? null,
            run.routes,
            run.coverageStatus,
            run.degradedCapabilities,
            run.startedAt,
            run.completedAt,
            run.durationMs,
            run.citationFailureCount,
            run.conflictCount
          ]
        );
        if (inserted.rowCount !== 1) return;
        for (const candidate of run.candidates) {
          await client.query(
            `insert into jina_context.retrieval_candidates
            (query_run_id,ordinal,candidate_id,retriever,source_kind,source_id,source_revision_id,
             raw_score,fused_score,selected,diagnostics)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
            [
              run.id,
              candidate.ordinal,
              candidate.candidateId,
              candidate.retriever,
              candidate.sourceKind,
              candidate.sourceId,
              candidate.sourceRevisionId ?? null,
              candidate.rawScore,
              candidate.fusedScore ?? null,
              candidate.selected,
              JSON.stringify(candidate.diagnostics)
            ]
          );
        }
        for (const citation of run.citations) {
          await client.query(
            `insert into jina_context.answer_citations
            (query_run_id,ordinal,citation_id,source_kind,source_id,source_revision_id,source_anchor,
             content_digest,accessible,digest_valid,supports_claim,diagnostics)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb)`,
            [
              run.id,
              citation.ordinal,
              citation.citationId,
              citation.sourceKind,
              citation.sourceId,
              citation.sourceRevisionId ?? null,
              JSON.stringify(citation.sourceAnchor),
              citation.contentDigest,
              citation.accessible,
              citation.digestValid,
              citation.supportsClaim ?? null,
              JSON.stringify(citation.diagnostics)
            ]
          );
        }
        for (const [ordinal, metric] of run.routeMetrics.entries()) {
          for (const [kind, value] of [
            ["candidate_count", metric.candidateCount],
            ["duration_ms", metric.durationMs]
          ] as const) {
            await client.query(
              `insert into jina_context.retrieval_metrics
              (id,tenant_id,repository,query_run_id,metric_name,metric_value,dimensions,recorded_at)
             values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
              [
                `metric_${run.id}_${ordinal}_${kind}`,
                run.tenantId,
                run.repository,
                run.id,
                `route.${kind}`,
                value,
                JSON.stringify({ route: metric.route }),
                run.completedAt
              ]
            );
          }
        }
      },
      "query.run.record"
    );
  }

  async metrics(tenantId: string): Promise<QueryMetrics> {
    await this.database.initialize();
    const result = await this.database.queryAs<{
      count: string;
      p95_ms: number | null;
      citation_failure_count: string;
      conflict_count: string;
    }>(
      "jina_context_query",
      { tenantIds: [tenantId] },
      `select count(*)::text as count,
              percentile_disc(0.95) within group (order by duration_ms) as p95_ms,
              coalesce(sum(citation_failure_count),0)::text as citation_failure_count,
              coalesce(sum(conflict_count),0)::text as conflict_count
       from jina_context.query_runs
      where tenant_id=$1 and completed_at is not null`,
      [tenantId],
      "query.metrics"
    );
    const row = result.rows[0]!;
    return {
      count: Number(row.count),
      p95Ms: Number(row.p95_ms ?? 0),
      citationFailureCount: Number(row.citation_failure_count),
      conflictCount: Number(row.conflict_count)
    };
  }
}

interface GenerationQueryRow {
  id: string;
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  checkpoint_id: string;
  projector_versions: IndexGeneration["projectorVersions"];
  capabilities: IndexGeneration["capabilities"];
  required_fingerprint: string;
  acl_fingerprint: string;
  projection_input_fingerprint: string;
  created_at: Date;
  published_at: Date;
  projector_statuses: IndexGeneration["projectorStatuses"];
}

interface CandidateRow {
  document_id: string;
  fragment_id: string | null;
  source_kind: string;
  source_id: string;
  source_revision_id: string | null;
  title: string;
  source_text: string;
  contextual_text: string;
  source_anchors: EvidenceAnchor[];
  authority_class: string;
  source_fingerprint: string;
  effective_acl_fingerprint: string;
  metadata: Record<string, unknown>;
  exact_score: number;
  prose_score: number;
}

function candidateFromRow(row: CandidateRow): StoredRetrievalCandidate {
  return {
    id: row.fragment_id ?? row.document_id,
    documentId: row.document_id,
    ...(row.fragment_id ? { fragmentId: row.fragment_id } : {}),
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    ...(row.source_revision_id ? { sourceRevisionId: row.source_revision_id } : {}),
    title: row.title,
    text: row.source_text,
    contextualText: row.contextual_text,
    anchors: row.source_anchors,
    authorityClass: row.authority_class,
    sourceFingerprint: row.source_fingerprint,
    effectiveAclFingerprint: row.effective_acl_fingerprint,
    metadata: row.metadata,
    exactScore: Number(row.exact_score),
    proseScore: Number(row.prose_score)
  };
}

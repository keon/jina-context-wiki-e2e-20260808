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
      `select acl.permission,acl.acl_fingerprint
       from jina_context.published_repository_acl acl
       where acl.tenant_id=$1 and acl.repository=$2 and acl.principal_id=$3
         and acl.generation_id=$4
       limit 1`,
      [tenantId, repository, principalId, generationId]
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
      `select generation.*
       from jina_context.index_generations generation
       where generation.tenant_id=$1 and generation.repository=$2
         and generation.ref_name=$3 and generation.status='published'
         and exists (
           select 1 from jina_context.repository_acl_projection acl
           where acl.generation_id=generation.id and acl.principal_id=$4
             and acl.permission in ('read','write','admin')
         )
       order by generation.published_at desc,generation.id desc limit 1`,
      [tenantId, repository, ref, principalId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const statuses = await this.database.queryAs<{
      consumer: string;
      status: string;
    }>("jina_context_query", "select consumer,status from jina_context.generation_projectors where generation_id=$1", [
      row.id
    ]);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      repository: row.repository,
      ref: row.ref_name,
      commitSha: row.commit_sha,
      checkpointId: row.checkpoint_id,
      status: "published",
      projectorVersions: row.projector_versions,
      projectorStatuses: Object.fromEntries(
        statuses.rows.map((status) => [status.consumer, status.status])
      ) as IndexGeneration["projectorStatuses"],
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
      `with authorized as materialized (
         select acl.acl_fingerprint
         from jina_context.repository_acl_projection acl
         join jina_context.index_generations generation on generation.id=acl.generation_id
         where acl.tenant_id=$1 and acl.repository=$2 and acl.principal_id=$3
           and acl.generation_id=$4 and acl.permission in ('read','write','admin')
           and generation.status='published'
       ), query as (
         select websearch_to_tsquery('simple',$5) exact,
                websearch_to_tsquery('english',$5) prose
       )
       select document.id as document_id,fragment.id as fragment_id,
              document.source_kind,document.source_id,document.source_revision_id,
              document.title,fragment.source_text,fragment.contextual_text,
              fragment.source_anchors,document.authority_class,document.source_fingerprint,
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
      ]
    );
    return result.rows.map(candidateFromRow);
  }

  async exactLookup(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly term: string;
    readonly limit: number;
  }): Promise<readonly StoredRetrievalCandidate[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<CandidateRow>(
      "jina_context_query",
      `select document.id as document_id,fragment.id as fragment_id,
              document.source_kind,document.source_id,document.source_revision_id,
              document.title,fragment.source_text,fragment.contextual_text,
              fragment.source_anchors,document.authority_class,document.source_fingerprint,
              case when lower(document.title)=lower($5) then 1.0 else 0.75 end as exact_score,
              0::double precision as prose_score
       from jina_context.published_context_documents document
       join jina_context.published_context_fragments fragment
         on fragment.generation_id=document.generation_id and fragment.document_id=document.id
       join jina_context.repository_acl_projection acl
         on acl.generation_id=document.generation_id
        and acl.principal_id=$3 and acl.permission in ('read','write','admin')
        and acl.acl_fingerprint=document.effective_acl_fingerprint
       where document.tenant_id=$1 and document.repository=$2 and document.generation_id=$4
         and (
           lower(document.title)=lower($5)
           or position(lower($5) in lower(document.title)) > 0
           or position(lower($5) in lower(fragment.source_text)) > 0
         )
       order by exact_score desc,document.id,fragment.ordinal
       limit $6`,
      [
        input.tenantId,
        input.repository,
        input.principalId,
        input.generationId,
        input.term,
        Math.max(1, Math.min(input.limit, 200))
      ]
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
      `select relation.*
       from jina_context.published_structural_relations relation
       where relation.tenant_id=$1 and relation.repository=$2 and relation.generation_id=$4
         and (relation.source_id=$5 or relation.target_id=$5)
         and ($6::text[] is null or relation.relation_kind=any($6))
         and exists (
           select 1 from jina_context.repository_acl_projection acl
           where acl.generation_id=relation.generation_id and acl.principal_id=$3
             and acl.permission in ('read','write','admin')
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
      ]
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
      ]
    );
  }

  async completeQueryRun(input: {
    readonly id: string;
    readonly coverageStatus: "complete" | "partial" | "insufficient";
    readonly degradedCapabilities: readonly string[];
    readonly completedAt: string;
    readonly durationMs: number;
    readonly failureKind?: string;
  }): Promise<boolean> {
    await this.database.initialize();
    const result = await this.database.queryAs(
      "jina_context_query",
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
      ]
    );
    return result.rowCount === 1;
  }

  async recordQueryRun(run: QueryRunTelemetry): Promise<void> {
    await this.database.initialize();
    await this.database.queryAs(
      "jina_context_query",
      `insert into jina_context.query_runs
        (id,tenant_id,repository,principal_fingerprint,generation_id,request_fingerprint,
         task_kind,routes,coverage_status,degraded_capabilities,started_at,completed_at,
         duration_ms,citation_failure_count,conflict_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (id) do nothing`,
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
      `select count(*)::text as count,
              percentile_disc(0.95) within group (order by duration_ms) as p95_ms,
              coalesce(sum(citation_failure_count),0)::text as citation_failure_count,
              coalesce(sum(conflict_count),0)::text as conflict_count
       from jina_context.query_runs
       where tenant_id=$1 and completed_at is not null`,
      [tenantId]
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
  created_at: Date;
  published_at: Date;
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
    exactScore: Number(row.exact_score),
    proseScore: Number(row.prose_score)
  };
}

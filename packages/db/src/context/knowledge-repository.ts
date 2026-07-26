import type {
  DerivationRun,
  KnowledgeCommit,
  KnowledgeDocumentKind,
  KnowledgeDocumentRevision,
  KnowledgeEvidenceCitation,
  KnowledgeRevisionEvent,
  KnowledgeStore,
  ContextWriteFence
} from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, contextStableId, dateString } from "./database.js";
import { enqueueContextEvent } from "./outbox-repository.js";
import { assertContextWriteFence } from "./write-fence.js";

interface DerivationRow {
  id: string;
  tenant_id: string;
  repository: string;
  checkpoint_id: string;
  cache_key: string;
  focus_fingerprint: string;
  generator_name: string;
  generator_version: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  raw_output: unknown[];
  status: DerivationRun["status"];
  validation_diagnostics: string[];
  created_at: Date;
}

interface RevisionRow {
  id: string;
  logical_id: string;
  tenant_id: string;
  repository: string;
  kind: KnowledgeDocumentKind;
  title: string;
  body_markdown: string;
  summary: string;
  structured_summary: Record<string, unknown>;
  scope: KnowledgeDocumentRevision["scope"];
  evidence_fingerprint: string;
  body_digest: string;
  generator_name: string;
  generator_version: string;
  model: string;
  prompt_version: string;
  confidence: number;
  created_at: Date;
}

interface CitationRow {
  revision_id: string;
  ordinal: number;
  claim_role: string;
  claim_ids: string[];
  tenant_id: string;
  repository: string;
  source_type: KnowledgeEvidenceCitation["anchor"]["sourceType"];
  source_id: string;
  content_digest: string;
  commit_sha: string | null;
  path_or_url: string | null;
  start_line: number | null;
  end_line: number | null;
  json_pointer: string | null;
  observed_at: Date | null;
}

interface EventRow {
  id: string;
  revision_id: string;
  sequence: number;
  event_type: KnowledgeRevisionEvent["type"];
  actor_id: string;
  reason: string | null;
  payload: { replacementRevisionId?: string };
  occurred_at: Date;
}

export class PostgresKnowledgeRepository implements KnowledgeStore {
  constructor(private readonly database: ContextDatabase) {}

  async findSuccessfulRun(cacheKey: string): Promise<DerivationRun | undefined> {
    await this.database.initialize();
    const result = await this.database.pool.query<DerivationRow>(
      `select * from jina_context.derivation_runs
       where cache_key=$1 and status='succeeded'
       order by completed_at desc,id limit 1`,
      [cacheKey]
    );
    return result.rows[0] ? this.hydrateRun(result.rows[0]) : undefined;
  }

  async commitKnowledge(input: KnowledgeCommit, fence?: ContextWriteFence): Promise<DerivationRun> {
    await this.database.transaction(async (client) => {
      await assertContextWriteFence(client, input.run.tenantId, "run-derive-knowledge", fence);
      const checkpoint = await requireCheckpoint(client, input.run.checkpointId);
      await insertDerivationRun(client, input.run, checkpoint);
      for (const revision of input.revisions) {
        if (
          revision.tenantId !== checkpoint.tenant_id ||
          revision.repository !== checkpoint.repository ||
          revision.scope.ref !== checkpoint.ref_name ||
          revision.scope.commitSha !== checkpoint.commit_sha
        ) {
          throw new Error(`Knowledge revision ${revision.id} escapes its evidence checkpoint`);
        }
        await client.query(
          `insert into jina_context.knowledge_documents
            (tenant_id,repository,logical_id,kind,subject,created_at)
           values ($1,$2,$3,$4,$5::jsonb,$6)
           on conflict (tenant_id,repository,logical_id) do nothing`,
          [
            revision.tenantId,
            revision.repository,
            revision.logicalId,
            revision.kind,
            JSON.stringify({ logicalId: revision.logicalId, scope: revision.scope }),
            revision.createdAt
          ]
        );
        await client.query(
          `insert into jina_context.knowledge_document_revisions
            (id,tenant_id,repository,logical_id,derivation_run_id,title,body_markdown,
             summary,structured_summary,scope,ref_name,commit_sha,evidence_fingerprint,
             body_digest,generator_name,generator_version,model,prompt_version,confidence,
             author_kind,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,'model',$20)
           on conflict (tenant_id,repository,id) do nothing`,
          [
            revision.id,
            revision.tenantId,
            revision.repository,
            revision.logicalId,
            input.run.id,
            revision.title,
            revision.bodyMarkdown,
            revision.summary,
            JSON.stringify(revision.structuredSummary),
            JSON.stringify(revision.scope),
            revision.scope.ref,
            revision.scope.commitSha,
            revision.evidenceFingerprint,
            revision.bodyDigest,
            revision.generatorName,
            revision.generatorVersion,
            revision.model,
            revision.promptVersion,
            revision.confidence,
            revision.createdAt
          ]
        );
        const storedRevision = await client.query(
          `select 1 from jina_context.knowledge_document_revisions
           where tenant_id=$1 and repository=$2 and id=$3 and logical_id=$4
             and evidence_fingerprint=$5 and body_digest=$6
             and generator_name=$7 and generator_version=$8`,
          [
            revision.tenantId,
            revision.repository,
            revision.id,
            revision.logicalId,
            revision.evidenceFingerprint,
            revision.bodyDigest,
            revision.generatorName,
            revision.generatorVersion
          ]
        );
        if (storedRevision.rowCount !== 1) {
          throw new Error(`Knowledge revision identity collision for ${revision.id}`);
        }
      }
      for (const citation of input.citations) {
        const revision = input.revisions.find((candidate) => candidate.id === citation.revisionId);
        if (!revision) throw new Error(`Citation ${citation.id} references an uncommitted revision`);
        await assertCitationInCheckpoint(client, input.run.checkpointId, citation);
        const anchor = citation.anchor;
        await client.query(
          `insert into jina_context.knowledge_revision_evidence
            (tenant_id,repository,revision_id,ordinal,claim_role,claim_ids,source_type,
             source_id,content_digest,commit_sha,path_or_url,start_line,end_line,json_pointer,
             observed_at,anchor)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
           on conflict (tenant_id,repository,revision_id,ordinal) do nothing`,
          [
            revision.tenantId,
            revision.repository,
            citation.revisionId,
            citation.ordinal,
            citation.claim,
            [citation.id],
            anchor.sourceType,
            anchor.sourceId,
            anchor.contentDigest,
            anchor.commitSha ?? null,
            anchor.pathOrUrl ?? null,
            anchor.startLine ?? null,
            anchor.endLine ?? null,
            anchor.jsonPointer ?? null,
            anchor.observedAt ?? null,
            JSON.stringify(anchor)
          ]
        );
        const storedCitation = await client.query(
          `select 1 from jina_context.knowledge_revision_evidence
           where tenant_id=$1 and repository=$2 and revision_id=$3 and ordinal=$4
             and source_type=$5 and source_id=$6 and content_digest=$7
             and anchor=$8::jsonb`,
          [
            revision.tenantId,
            revision.repository,
            citation.revisionId,
            citation.ordinal,
            anchor.sourceType,
            anchor.sourceId,
            anchor.contentDigest,
            JSON.stringify(anchor)
          ]
        );
        if (storedCitation.rowCount !== 1) {
          throw new Error(`Knowledge citation identity collision for ${citation.revisionId}:${citation.ordinal}`);
        }
      }
      for (const revision of input.revisions) {
        await enqueueContextEvent(client, {
          id: contextStableId("event", { revision: revision.id, type: "created" }),
          sequence: 1,
          tenantId: revision.tenantId,
          repository: revision.repository,
          aggregateType: "knowledge",
          aggregateId: revision.id,
          eventType: "knowledge.revision.created",
          payload: { revisionId: revision.id, logicalId: revision.logicalId },
          consumers: ["knowledge-current", "lexical", "dense", "hierarchy", "retention"],
          occurredAt: revision.createdAt
        });
      }
      await assertContextWriteFence(client, input.run.tenantId, "run-derive-knowledge", fence);
    });
    return input.run;
  }

  async recordFailedRun(run: DerivationRun, fence?: ContextWriteFence): Promise<void> {
    await this.database.transaction(async (client) => {
      await assertContextWriteFence(client, run.tenantId, "run-derive-knowledge", fence);
      const checkpoint = await requireCheckpoint(client, run.checkpointId);
      await insertDerivationRun(client, run, checkpoint);
      await assertContextWriteFence(client, run.tenantId, "run-derive-knowledge", fence);
    });
  }

  async getRun(runId: string): Promise<DerivationRun | undefined> {
    await this.database.initialize();
    const result = await this.database.pool.query<DerivationRow>(
      "select * from jina_context.derivation_runs where id=$1",
      [runId]
    );
    return result.rows[0] ? this.hydrateRun(result.rows[0]) : undefined;
  }

  async getRevision(revisionId: string): Promise<KnowledgeDocumentRevision | undefined> {
    await this.database.initialize();
    const result = await this.database.pool.query<RevisionRow>(
      REVISION_SELECT + ` where revision.id=$1 and ${revisionNotErasedSql("revision")}`,
      [revisionId]
    );
    return result.rows[0] ? revisionFromRow(result.rows[0]) : undefined;
  }

  async listRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]> {
    await this.database.initialize();
    const result = await this.database.pool.query<RevisionRow>(
      REVISION_SELECT +
        ` where revision.tenant_id=$1 and revision.repository=$2
          and ${revisionNotErasedSql("revision")}
          order by revision.created_at desc,revision.id`,
      [tenantId, repository]
    );
    return result.rows.map(revisionFromRow);
  }

  async listCitations(revisionId: string): Promise<KnowledgeEvidenceCitation[]> {
    await this.database.initialize();
    const result = await this.database.pool.query<CitationRow>(
      `select * from jina_context.knowledge_revision_evidence
       where revision_id=$1
         and not exists (
           select 1 from jina_context.erasure_filters erasure
           where erasure.tenant_id=knowledge_revision_evidence.tenant_id
             and erasure.repository=knowledge_revision_evidence.repository
             and erasure.source_type=knowledge_revision_evidence.source_type
             and (erasure.source_id is null or erasure.source_id=knowledge_revision_evidence.source_id)
             and (erasure.content_digest is null or erasure.content_digest=knowledge_revision_evidence.content_digest)
             and (
               erasure.path_pattern is null
               or knowledge_revision_evidence.path_or_url like erasure.path_pattern escape '\\'
             )
         )
       order by ordinal`,
      [revisionId]
    );
    return result.rows.map(citationFromRow);
  }

  async appendRevisionEvent(event: KnowledgeRevisionEvent): Promise<KnowledgeRevisionEvent> {
    await this.database.transaction(async (client) => {
      const revision = await client.query<{ tenant_id: string; repository: string }>(
        `select tenant_id,repository from jina_context.knowledge_document_revisions
         where id=$1`,
        [event.revisionId]
      );
      const scope = revision.rows[0];
      if (!scope) throw new Error(`Unknown knowledge revision ${event.revisionId}`);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${scope.tenant_id}:${scope.repository}:${event.revisionId}`
      ]);
      const expected = await client.query<{ sequence: number }>(
        `select coalesce(max(sequence),0)+1 as sequence
         from jina_context.knowledge_revision_events
         where tenant_id=$1 and repository=$2 and revision_id=$3`,
        [scope.tenant_id, scope.repository, event.revisionId]
      );
      if (Number(expected.rows[0]!.sequence) !== event.sequence) {
        throw new Error(
          `Knowledge revision event sequence ${event.sequence} is stale; expected ${expected.rows[0]!.sequence}`
        );
      }
      await client.query(
        `insert into jina_context.knowledge_revision_events
          (id,tenant_id,repository,revision_id,sequence,event_type,actor_id,reason,payload,occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         on conflict (tenant_id,repository,id) do nothing`,
        [
          event.id,
          scope.tenant_id,
          scope.repository,
          event.revisionId,
          event.sequence,
          event.type,
          event.actorId,
          event.reason,
          JSON.stringify(event.replacementRevisionId ? { replacementRevisionId: event.replacementRevisionId } : {}),
          event.createdAt
        ]
      );
      await enqueueContextEvent(client, {
        id: contextStableId("event", { revisionEvent: event.id }),
        sequence: event.sequence + 1,
        tenantId: scope.tenant_id,
        repository: scope.repository,
        aggregateType: "knowledge",
        aggregateId: event.revisionId,
        eventType: `knowledge.revision.${event.type}`,
        payload: { revisionId: event.revisionId, sequence: event.sequence },
        consumers: ["knowledge-current", "lexical", "dense", "hierarchy", "retention"],
        occurredAt: event.createdAt
      });
    });
    return event;
  }

  async listRevisionEvents(revisionId: string): Promise<KnowledgeRevisionEvent[]> {
    await this.database.initialize();
    const result = await this.database.pool.query<EventRow>(
      `select * from jina_context.knowledge_revision_events
       where revision_id=$1 order by sequence`,
      [revisionId]
    );
    return result.rows.map(eventFromRow);
  }

  async listCurrentEligibleRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]> {
    await this.database.initialize();
    const result = await this.database.pool.query<RevisionRow>(
      `select distinct on (revision.logical_id)
         revision.*,document.kind
       from jina_context.knowledge_document_revisions revision
       join jina_context.knowledge_documents document
         on document.tenant_id=revision.tenant_id
        and document.repository=revision.repository
        and document.logical_id=revision.logical_id
       where revision.tenant_id=$1 and revision.repository=$2
         and not exists (
           select 1 from jina_context.knowledge_revision_events event
           where event.tenant_id=revision.tenant_id
             and event.repository=revision.repository
             and event.revision_id=revision.id
             and event.event_type in ('rejected','superseded','invalidated','redacted','expired')
         )
         and not exists (
           select 1
           from jina_context.knowledge_revision_evidence citation
           join jina_context.erasure_filters erasure
             on erasure.tenant_id=citation.tenant_id
            and erasure.repository=citation.repository
            and erasure.source_type=citation.source_type
            and (erasure.source_id is null or erasure.source_id=citation.source_id)
            and (erasure.content_digest is null or erasure.content_digest=citation.content_digest)
            and (
              erasure.path_pattern is null
              or citation.path_or_url like erasure.path_pattern escape '\\'
            )
           where citation.tenant_id=revision.tenant_id
             and citation.repository=revision.repository
             and citation.revision_id=revision.id
         )
         and (
           document.kind not in ('incident','ownership')
           or exists (
             select 1 from jina_context.knowledge_revision_events review
             where review.tenant_id=revision.tenant_id
               and review.repository=revision.repository
               and review.revision_id=revision.id
               and review.event_type in ('reviewed','approved')
           )
         )
       order by revision.logical_id,revision.created_at desc,revision.id desc`,
      [tenantId, repository]
    );
    return result.rows.map(revisionFromRow);
  }

  private async hydrateRun(row: DerivationRow): Promise<DerivationRun> {
    const revisions = await this.database.pool.query<{ id: string }>(
      `select id from jina_context.knowledge_document_revisions
       where tenant_id=$1 and repository=$2 and derivation_run_id=$3 order by created_at,id`,
      [row.tenant_id, row.repository, row.id]
    );
    return {
      id: row.id,
      tenantId: row.tenant_id,
      repository: row.repository,
      checkpointId: row.checkpoint_id,
      cacheKey: row.cache_key,
      focusFingerprint: row.focus_fingerprint,
      generatorName: row.generator_name,
      generatorVersion: row.generator_version,
      model: row.model,
      promptVersion: row.prompt_version,
      schemaVersion: row.schema_version,
      rawOutputs: row.raw_output,
      status: row.status,
      diagnostics: row.validation_diagnostics,
      revisionIds: revisions.rows.map((revision) => revision.id),
      createdAt: dateString(row.created_at)
    };
  }
}

function revisionNotErasedSql(alias: string): string {
  return `not exists (
    select 1
    from jina_context.knowledge_revision_evidence citation
    join jina_context.erasure_filters erasure
      on erasure.tenant_id=citation.tenant_id
     and erasure.repository=citation.repository
     and erasure.source_type=citation.source_type
     and (erasure.source_id is null or erasure.source_id=citation.source_id)
     and (erasure.content_digest is null or erasure.content_digest=citation.content_digest)
     and (
       erasure.path_pattern is null
       or citation.path_or_url like erasure.path_pattern escape '\\'
     )
    where citation.tenant_id=${alias}.tenant_id
      and citation.repository=${alias}.repository
      and citation.revision_id=${alias}.id
  )`;
}

const REVISION_SELECT = `
  select revision.*,document.kind
  from jina_context.knowledge_document_revisions revision
  join jina_context.knowledge_documents document
    on document.tenant_id=revision.tenant_id
   and document.repository=revision.repository
   and document.logical_id=revision.logical_id`;

async function requireCheckpoint(
  client: PoolClient,
  checkpointId: string
): Promise<{
  tenant_id: string;
  repository: string;
  ref_name: string;
  commit_sha: string;
  evidence_fingerprint: string;
  created_at: Date;
}> {
  const result = await client.query<{
    tenant_id: string;
    repository: string;
    ref_name: string;
    commit_sha: string;
    evidence_fingerprint: string;
    created_at: Date;
  }>("select * from jina_context.evidence_checkpoints where id=$1", [checkpointId]);
  const row = result.rows[0];
  if (!row) throw new Error(`Unknown evidence checkpoint ${checkpointId}`);
  return row;
}

async function insertDerivationRun(
  client: PoolClient,
  run: DerivationRun,
  checkpoint: Awaited<ReturnType<typeof requireCheckpoint>>
): Promise<void> {
  if (run.tenantId !== checkpoint.tenant_id || run.repository !== checkpoint.repository) {
    throw new Error(`Derivation run ${run.id} escapes its evidence checkpoint`);
  }
  await client.query(
    `insert into jina_context.derivation_runs
      (id,tenant_id,repository,ref_name,commit_sha,checkpoint_id,focus,focus_fingerprint,
       evidence_fingerprint,generator_name,generator_version,model,prompt_version,
       schema_version,cache_key,status,raw_output,validation_diagnostics,started_at,completed_at)
     values ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$18)
     on conflict (tenant_id,repository,id) do nothing`,
    [
      run.id,
      run.tenantId,
      run.repository,
      checkpoint.ref_name,
      checkpoint.commit_sha,
      run.checkpointId,
      run.focusFingerprint,
      checkpoint.evidence_fingerprint,
      run.generatorName,
      run.generatorVersion,
      run.model,
      run.promptVersion,
      run.schemaVersion,
      run.cacheKey,
      run.status,
      JSON.stringify(run.rawOutputs),
      JSON.stringify(run.diagnostics),
      run.createdAt
    ]
  );
  const stored = await client.query(
    `select 1 from jina_context.derivation_runs
     where tenant_id=$1 and repository=$2 and id=$3 and checkpoint_id=$4
       and cache_key=$5 and focus_fingerprint=$6 and evidence_fingerprint=$7
       and generator_name=$8 and generator_version=$9 and model=$10
       and prompt_version=$11 and schema_version=$12 and status=$13`,
    [
      run.tenantId,
      run.repository,
      run.id,
      run.checkpointId,
      run.cacheKey,
      run.focusFingerprint,
      checkpoint.evidence_fingerprint,
      run.generatorName,
      run.generatorVersion,
      run.model,
      run.promptVersion,
      run.schemaVersion,
      run.status
    ]
  );
  if (stored.rowCount !== 1) throw new Error(`Derivation run identity collision for ${run.id}`);
}

async function assertCitationInCheckpoint(
  client: PoolClient,
  checkpointId: string,
  citation: KnowledgeEvidenceCitation
): Promise<void> {
  const anchor = citation.anchor;
  const result = await client.query(
    `select 1
     from jina_context.evidence_checkpoint_records selection
     join jina_context.evidence_records evidence
       on evidence.tenant_id=selection.tenant_id
      and evidence.repository=selection.repository
      and evidence.id=selection.evidence_id
     where selection.checkpoint_id=$1
       and evidence.tenant_id=$2 and evidence.repository=$3
       and evidence.source_type=$4 and evidence.source_id=$5
       and evidence.content_digest=$6
       and evidence.commit_sha is not distinct from $7
       and evidence.path_or_url is not distinct from $8
       and evidence.start_line is not distinct from $9
       and evidence.end_line is not distinct from $10
       and evidence.json_pointer is not distinct from $11
     limit 1`,
    [
      checkpointId,
      anchor.tenantId,
      anchor.repository,
      anchor.sourceType,
      anchor.sourceId,
      anchor.contentDigest,
      anchor.commitSha ?? null,
      anchor.pathOrUrl ?? null,
      anchor.startLine ?? null,
      anchor.endLine ?? null,
      anchor.jsonPointer ?? null
    ]
  );
  if (result.rowCount !== 1) {
    throw new Error(`Citation ${citation.id} does not resolve inside evidence checkpoint ${checkpointId}`);
  }
}

function revisionFromRow(row: RevisionRow): KnowledgeDocumentRevision {
  return {
    id: row.id,
    logicalId: row.logical_id,
    tenantId: row.tenant_id,
    repository: row.repository,
    kind: row.kind,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    summary: row.summary,
    structuredSummary: row.structured_summary,
    scope: row.scope,
    evidenceFingerprint: row.evidence_fingerprint,
    bodyDigest: row.body_digest,
    generatorName: row.generator_name,
    generatorVersion: row.generator_version,
    model: row.model,
    promptVersion: row.prompt_version,
    confidence: row.confidence,
    createdAt: dateString(row.created_at)
  };
}

function citationFromRow(row: CitationRow): KnowledgeEvidenceCitation {
  return {
    id: row.claim_ids[0] ?? contextStableId("kc", { revisionId: row.revision_id, ordinal: row.ordinal }),
    revisionId: row.revision_id,
    ordinal: row.ordinal,
    claim: row.claim_role,
    anchor: {
      tenantId: row.tenant_id,
      repository: row.repository,
      sourceType: row.source_type,
      sourceId: row.source_id,
      contentDigest: row.content_digest,
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
      ...(row.path_or_url ? { pathOrUrl: row.path_or_url } : {}),
      ...(row.start_line !== null ? { startLine: row.start_line } : {}),
      ...(row.end_line !== null ? { endLine: row.end_line } : {}),
      ...(row.json_pointer ? { jsonPointer: row.json_pointer } : {}),
      ...(row.observed_at ? { observedAt: dateString(row.observed_at) } : {})
    }
  };
}

function eventFromRow(row: EventRow): KnowledgeRevisionEvent {
  return {
    id: row.id,
    revisionId: row.revision_id,
    sequence: row.sequence,
    type: row.event_type,
    actorId: row.actor_id,
    reason: row.reason ?? "",
    ...(row.payload.replacementRevisionId ? { replacementRevisionId: row.payload.replacementRevisionId } : {}),
    createdAt: dateString(row.occurred_at)
  };
}

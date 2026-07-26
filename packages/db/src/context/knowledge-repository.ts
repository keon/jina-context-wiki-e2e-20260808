import type {
  DerivationRun,
  KnowledgeCommit,
  KnowledgeDocumentKind,
  KnowledgeDocumentRevision,
  KnowledgeEvidenceCitation,
  KnowledgeRevisionEvent,
  KnowledgeStore,
  ContextWriteFence,
  EvidenceRecord
} from "@jina/context-engine";
import { evidenceExcerpt, sameImmutableKnowledgeCitation, sameImmutableKnowledgeRevision } from "@jina/context-engine";
import type { PoolClient } from "pg";
import { ContextDatabase, contextStableId, dateString } from "./database.js";
import { enqueueContextEvent } from "./outbox-repository.js";
import { appendProjectionInputEvent, lockProjectionInput } from "./projection-input.js";
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
  started_at: Date;
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
    const result = await this.database.queryAs<DerivationRow>(
      "jina_context_admin",
      { system: true },
      `select * from jina_context.derivation_runs
       where cache_key=$1 and status='succeeded'
       order by completed_at desc,id limit 1`,
      [cacheKey]
    );
    return result.rows[0] ? this.hydrateRun(result.rows[0]) : undefined;
  }

  async commitKnowledge(input: KnowledgeCommit, fence?: ContextWriteFence): Promise<DerivationRun> {
    await this.database.transactionAs("jina_context_derive", { tenantIds: [input.run.tenantId] }, async (client) => {
      const canonicalRevisionCreatedAt = new Map<string, string>();
      const newlyInsertedRevisionIds = new Set<string>();
      const revisionById = new Map(input.revisions.map((revision) => [revision.id, revision]));
      if (revisionById.size !== input.revisions.length) throw new Error("Duplicate revisions in commit");
      if (
        input.run.revisionIds.length !== revisionById.size ||
        input.run.revisionIds.some((revisionId) => !revisionById.has(revisionId))
      ) {
        throw new Error("Derivation run revision IDs do not match the committed revisions");
      }
      const citationsByRevision = new Map<string, KnowledgeEvidenceCitation[]>(
        input.revisions.map((revision) => [revision.id, []])
      );
      for (const citation of input.citations) {
        const revisionCitations = citationsByRevision.get(citation.revisionId);
        if (!revisionCitations) throw new Error(`Citation ${citation.id} references an uncommitted revision`);
        revisionCitations.push(citation);
      }
      for (const [revisionId, citations] of citationsByRevision) {
        citations.sort((left, right) => left.ordinal - right.ordinal);
        if (citations.length === 0) throw new Error("Knowledge revisions require source citations");
        if (citations.some((citation, index) => citation.ordinal !== index)) {
          throw new Error(`Knowledge citation ordinals must be contiguous for ${revisionId}`);
        }
      }
      await assertContextWriteFence(client, input.run.tenantId, "run-derive-knowledge", fence);
      const checkpoint = await requireCheckpoint(client, input.run.checkpointId);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `context-generation-ref:${checkpoint.tenant_id}:${checkpoint.repository}:${checkpoint.ref_name}`
      ]);
      await assertCheckpointCurrent(client, input.run.checkpointId, checkpoint);
      await lockProjectionInput(client, checkpoint.tenant_id, checkpoint.repository);
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
        const insertedRevision = await client.query(
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
        if (insertedRevision.rowCount === 1) newlyInsertedRevisionIds.add(revision.id);
        const storedRevision = await client.query<RevisionRow>(
          REVISION_SELECT + ` where revision.tenant_id=$1 and revision.repository=$2 and revision.id=$3`,
          [revision.tenantId, revision.repository, revision.id]
        );
        const canonicalRevision = storedRevision.rows[0] && revisionFromRow(storedRevision.rows[0]);
        if (!canonicalRevision || !sameImmutableKnowledgeRevision(canonicalRevision, revision)) {
          throw new Error(`Knowledge revision identity collision for ${revision.id}`);
        }
        canonicalRevisionCreatedAt.set(revision.id, canonicalRevision.createdAt);
      }
      for (const revision of input.revisions) {
        if (newlyInsertedRevisionIds.has(revision.id)) continue;
        const storedCitations = await selectStoredCitations(client, revision);
        if (!sameStoredCitationCollection(storedCitations, citationsByRevision.get(revision.id)!)) {
          throw new Error(`Knowledge citation collection identity collision for ${revision.id}`);
        }
      }
      for (const citation of input.citations) {
        const revision = revisionById.get(citation.revisionId)!;
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
        const storedCitation = await client.query<CitationRow>(
          `select * from jina_context.knowledge_revision_evidence
           where tenant_id=$1 and repository=$2 and revision_id=$3 and ordinal=$4`,
          [revision.tenantId, revision.repository, citation.revisionId, citation.ordinal]
        );
        const canonicalCitation = storedCitation.rows[0];
        if (!canonicalCitation || !sameStoredCitation(canonicalCitation, citation)) {
          throw new Error(`Knowledge citation identity collision for ${citation.revisionId}:${citation.ordinal}`);
        }
      }
      for (const revision of input.revisions) {
        const storedCitations = await selectStoredCitations(client, revision);
        if (!sameStoredCitationCollection(storedCitations, citationsByRevision.get(revision.id)!)) {
          throw new Error(`Knowledge citation collection identity collision for ${revision.id}`);
        }
      }
      for (const revision of input.revisions) {
        const occurredAt = canonicalRevisionCreatedAt.get(revision.id);
        if (!occurredAt) throw new Error(`Knowledge revision ${revision.id} has no canonical creation time`);
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
          occurredAt
        });
      }
      await appendProjectionInputEvent(client, {
        tenantId: checkpoint.tenant_id,
        repository: checkpoint.repository,
        id: `projection-input:knowledge-run:${input.run.id}`,
        eventType: "knowledge.run.committed",
        aggregateId: input.run.id,
        occurredAt: input.run.createdAt
      });
      await assertContextWriteFence(client, input.run.tenantId, "run-derive-knowledge", fence);
    });
    return input.run;
  }

  async recordFailedRun(run: DerivationRun, fence?: ContextWriteFence): Promise<void> {
    await this.database.transactionAs("jina_context_derive", { tenantIds: [run.tenantId] }, async (client) => {
      await assertContextWriteFence(client, run.tenantId, "run-derive-knowledge", fence);
      const checkpoint = await requireCheckpoint(client, run.checkpointId);
      await insertDerivationRun(client, run, checkpoint);
      await assertContextWriteFence(client, run.tenantId, "run-derive-knowledge", fence);
    });
  }

  async getRun(runId: string): Promise<DerivationRun | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<DerivationRow>(
      "jina_context_admin",
      { system: true },
      "select * from jina_context.derivation_runs where id=$1",
      [runId]
    );
    return result.rows[0] ? this.hydrateRun(result.rows[0]) : undefined;
  }

  async getRevision(revisionId: string): Promise<KnowledgeDocumentRevision | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<RevisionRow>(
      "jina_context_admin",
      { system: true },
      REVISION_SELECT + ` where revision.id=$1 and ${revisionNotErasedSql("revision")}`,
      [revisionId]
    );
    return result.rows[0] ? revisionFromRow(result.rows[0]) : undefined;
  }

  async getScopedRevision(
    tenantId: string,
    repositories: readonly string[],
    revisionId: string
  ): Promise<KnowledgeDocumentRevision | undefined> {
    await this.database.initialize();
    const result = await this.database.queryAs<RevisionRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      REVISION_SELECT +
        ` where revision.id=$1 and revision.tenant_id=$2 and revision.repository=any($3::text[])
          and ${revisionNotErasedSql("revision")}`,
      [revisionId, tenantId, [...repositories]]
    );
    return result.rows[0] ? revisionFromRow(result.rows[0]) : undefined;
  }

  async listRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<RevisionRow>(
      "jina_context_derive",
      { tenantIds: [tenantId] },
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
    const result = await this.database.queryAs<CitationRow>(
      "jina_context_admin",
      { system: true },
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
    await this.database.transactionAs("jina_context_admin", { system: true }, async (client) => {
      const revision = await client.query<{ tenant_id: string; repository: string; ref_name: string }>(
        `select tenant_id,repository,ref_name from jina_context.knowledge_document_revisions
         where id=$1`,
        [event.revisionId]
      );
      const scope = revision.rows[0];
      if (!scope) throw new Error(`Unknown knowledge revision ${event.revisionId}`);
      await lockProjectionInput(client, scope.tenant_id, scope.repository);
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
      await appendProjectionInputEvent(client, {
        tenantId: scope.tenant_id,
        repository: scope.repository,
        id: `projection-input:knowledge-event:${event.id}`,
        eventType: "knowledge.revision.event",
        aggregateId: event.id,
        occurredAt: event.createdAt
      });
      if (["rejected", "superseded", "invalidated", "redacted", "expired"].includes(event.type)) {
        await client.query(
          `update jina_context.index_generations
           set status='invalidated',invalidated_at=$4
           where tenant_id=$1 and repository=$2 and ref_name=$3 and status='published'`,
          [scope.tenant_id, scope.repository, scope.ref_name, event.createdAt]
        );
      }
    });
    return event;
  }

  async listRevisionEvents(revisionId: string): Promise<KnowledgeRevisionEvent[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<EventRow>(
      "jina_context_admin",
      { system: true },
      `select * from jina_context.knowledge_revision_events
       where revision_id=$1 order by sequence`,
      [revisionId]
    );
    return result.rows.map(eventFromRow);
  }

  async listCheckpointRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<RevisionRow>(
      "jina_context_derive",
      { tenantIds: [tenantId] },
      `with current_checkpoint as (
         select *
         from jina_context.evidence_checkpoints
         where id=$3 and tenant_id=$1 and repository=$2
       )
       select revision.*,document.kind
       from current_checkpoint current
       join jina_context.knowledge_document_revisions revision
         on revision.tenant_id=current.tenant_id
        and revision.repository=current.repository
        and revision.ref_name=current.ref_name
        and revision.commit_sha=current.commit_sha
       join jina_context.knowledge_documents document
         on document.tenant_id=revision.tenant_id
        and document.repository=revision.repository
        and document.logical_id=revision.logical_id
       where not exists (
         select 1
         from jina_context.knowledge_revision_evidence citation
         where citation.tenant_id=revision.tenant_id
           and citation.repository=revision.repository
           and citation.revision_id=revision.id
           and not exists (
             select 1
             from jina_context.evidence_checkpoint_records selection
             join jina_context.evidence_records evidence
               on evidence.tenant_id=selection.tenant_id
              and evidence.repository=selection.repository
              and evidence.id=selection.evidence_id
             where selection.checkpoint_id=current.id
               and evidence.source_type=citation.source_type
               and evidence.source_id=citation.source_id
               and evidence.content_digest=citation.content_digest
               and evidence.commit_sha is not distinct from citation.commit_sha
               and evidence.path_or_url is not distinct from citation.path_or_url
           )
       )
       order by revision.created_at,revision.id`,
      [tenantId, repository, checkpointId]
    );
    return result.rows.map(revisionFromRow);
  }

  async listCurrentEligibleRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<RevisionRow>(
      "jina_context_derive",
      { tenantIds: [tenantId] },
      `with current_checkpoint as (
         select *
         from jina_context.evidence_checkpoints
         where id=$3 and tenant_id=$1 and repository=$2
       )
       select distinct on (revision.logical_id)
         revision.*,document.kind
       from current_checkpoint current
       join jina_context.knowledge_document_revisions revision
         on revision.tenant_id=current.tenant_id
        and revision.repository=current.repository
        and revision.ref_name=current.ref_name
        and revision.commit_sha=current.commit_sha
       join jina_context.knowledge_documents document
         on document.tenant_id=revision.tenant_id
        and document.repository=revision.repository
        and document.logical_id=revision.logical_id
       where not exists (
           select 1
           from jina_context.knowledge_revision_evidence citation
           where citation.tenant_id=revision.tenant_id
             and citation.repository=revision.repository
             and citation.revision_id=revision.id
             and not exists (
               select 1
               from jina_context.evidence_checkpoint_records selection
               join jina_context.evidence_records evidence
                 on evidence.tenant_id=selection.tenant_id
                and evidence.repository=selection.repository
                and evidence.id=selection.evidence_id
               where selection.checkpoint_id=current.id
                 and evidence.source_type=citation.source_type
                 and evidence.source_id=citation.source_id
                 and evidence.content_digest=citation.content_digest
                 and evidence.commit_sha is not distinct from citation.commit_sha
                 and evidence.path_or_url is not distinct from citation.path_or_url
             )
         )
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
      [tenantId, repository, checkpointId]
    );
    return result.rows.map(revisionFromRow);
  }

  private async hydrateRun(row: DerivationRow): Promise<DerivationRun> {
    const revisions = await this.database.queryAs<{ id: string }>(
      "jina_context_derive",
      { tenantIds: [row.tenant_id] },
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
      createdAt: dateString(row.started_at)
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
  ref_sequence: string;
  commit_sha: string;
  evidence_fingerprint: string;
  created_at: Date;
}> {
  const result = await client.query<{
    tenant_id: string;
    repository: string;
    ref_name: string;
    ref_sequence: string;
    commit_sha: string;
    evidence_fingerprint: string;
    created_at: Date;
  }>("select * from jina_context.evidence_checkpoints where id=$1", [checkpointId]);
  const row = result.rows[0];
  if (!row) throw new Error(`Unknown evidence checkpoint ${checkpointId}`);
  return row;
}

async function assertCheckpointCurrent(
  client: PoolClient,
  checkpointId: string,
  checkpoint: Awaited<ReturnType<typeof requireCheckpoint>>
): Promise<void> {
  const result = await client.query<{ ref_sequence: string }>(
    `select greatest(
       coalesce((
         select max(ref_sequence)
         from jina_context.pipeline_builds
         where tenant_id=$1 and repository=$2 and ref_name=$3
       ),0),
       coalesce((
         select max(ref_sequence)
         from jina_context.evidence_checkpoints
         where tenant_id=$1 and repository=$2 and ref_name=$3
       ),0)
     )::text ref_sequence`,
    [checkpoint.tenant_id, checkpoint.repository, checkpoint.ref_name]
  );
  const checkpointSequence = Number(checkpoint.ref_sequence);
  const latestSequence = Number(result.rows[0]!.ref_sequence);
  if (
    !Number.isSafeInteger(checkpointSequence) ||
    !Number.isSafeInteger(latestSequence) ||
    checkpointSequence < latestSequence
  ) {
    throw new Error(`Checkpoint ${checkpointId} is superseded for ${checkpoint.repository}@${checkpoint.ref_name}`);
  }
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
  const result = await client.query<{
    id: string;
    ref_name: string;
    source_type: EvidenceRecord["anchor"]["sourceType"];
    source_id: string;
    content_digest: string;
    commit_sha: string | null;
    path_or_url: string | null;
    observed_at: Date | null;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
    authority_class: EvidenceRecord["authorityClass"];
    acl_fingerprint: string;
    created_at: Date;
  }>(
    `select evidence.*
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
     limit 1`,
    [
      checkpointId,
      anchor.tenantId,
      anchor.repository,
      anchor.sourceType,
      anchor.sourceId,
      anchor.contentDigest,
      anchor.commitSha ?? null,
      anchor.pathOrUrl ?? null
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Citation ${citation.id} does not resolve inside evidence checkpoint ${checkpointId}`);
  }
  const record: EvidenceRecord = {
    id: row.id,
    anchor: {
      tenantId: anchor.tenantId,
      repository: anchor.repository,
      sourceType: row.source_type,
      sourceId: row.source_id,
      contentDigest: row.content_digest,
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
      ...(row.path_or_url ? { pathOrUrl: row.path_or_url } : {}),
      ...(row.observed_at ? { observedAt: row.observed_at.toISOString() } : {})
    },
    ref: row.ref_name,
    title: row.title,
    body: row.body,
    metadata: row.metadata,
    authorityClass: row.authority_class,
    aclFingerprint: row.acl_fingerprint,
    createdAt: row.created_at.toISOString()
  };
  const excerpt = evidenceExcerpt(record, anchor);
  if (excerpt === undefined) {
    throw new Error(`Citation ${citation.id} has an invalid evidence selector`);
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

async function selectStoredCitations(
  client: PoolClient,
  revision: Pick<KnowledgeDocumentRevision, "id" | "tenantId" | "repository">
): Promise<CitationRow[]> {
  const result = await client.query<CitationRow>(
    `select * from jina_context.knowledge_revision_evidence
     where tenant_id=$1 and repository=$2 and revision_id=$3
     order by ordinal`,
    [revision.tenantId, revision.repository, revision.id]
  );
  return result.rows;
}

function sameStoredCitation(row: CitationRow, citation: KnowledgeEvidenceCitation): boolean {
  return (
    row.claim_ids.length === 1 &&
    row.claim_ids[0] === citation.id &&
    sameImmutableKnowledgeCitation(citationFromRow(row), citation)
  );
}

function sameStoredCitationCollection(
  rows: readonly CitationRow[],
  citations: readonly KnowledgeEvidenceCitation[]
): boolean {
  return rows.length === citations.length && rows.every((row, index) => sameStoredCitation(row, citations[index]!));
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

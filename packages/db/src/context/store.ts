import {
  contextProjectionConsumers,
  type ContextEngineStore,
  type ContextWriteFence,
  type DerivationRun,
  type EraseEvidenceInput,
  type EvidenceAnchor,
  type EvidenceCheckpoint,
  type EvidenceRecord,
  type EvidenceSnapshot,
  type GenerationProjection,
  type IndexGeneration,
  type KnowledgeCommit,
  type KnowledgeDocumentRevision,
  type KnowledgeEvidenceCitation,
  type KnowledgeRevisionEvent,
  type ProjectionBacklog,
  type QueryMetrics,
  type QueryRunTelemetry,
  type RefManifestEntry,
  type StructuralFact,
  repositoryAclFingerprint
} from "@jina/context-engine";
import type { PostgresContextDatabaseConfig } from "./database.js";
import { ContextDatabase, contextDigest, contextStableId } from "./database.js";
import { currentRepositoryAccessFingerprint, lockRepositoryAccess, repositoryAccessLockKey } from "./access.js";
import { PostgresEvidenceRepository } from "./evidence-repository.js";
import { PostgresKnowledgeRepository } from "./knowledge-repository.js";
import { enqueueContextEvent } from "./outbox-repository.js";
import {
  appendProjectionInputEvent,
  currentProjectionInputFingerprint,
  lockProjectionInput
} from "./projection-input.js";
import { PostgresProjectionRepository } from "./projection-repository.js";
import { PostgresContextQueryRepository } from "./query-repository.js";

/**
 * Cohesive store façade for domain services. SQL remains split across the
 * evidence, knowledge, and projection repositories.
 */
export class PostgresContextEngineStore implements ContextEngineStore {
  readonly enforcesWriteFences = true as const;
  readonly database: ContextDatabase;
  readonly evidence: PostgresEvidenceRepository;
  readonly knowledge: PostgresKnowledgeRepository;
  readonly projection: PostgresProjectionRepository;
  readonly query: PostgresContextQueryRepository;

  constructor(config: PostgresContextDatabaseConfig | ContextDatabase) {
    this.database = config instanceof ContextDatabase ? config : new ContextDatabase(config);
    this.evidence = new PostgresEvidenceRepository(this.database);
    this.knowledge = new PostgresKnowledgeRepository(this.database);
    this.projection = new PostgresProjectionRepository(this.database);
    this.query = new PostgresContextQueryRepository(this.database);
  }

  commitSnapshot(snapshot: EvidenceSnapshot, fence?: ContextWriteFence): Promise<EvidenceCheckpoint> {
    return this.evidence.commitSnapshot(snapshot, fence);
  }
  getCheckpoint(checkpointId: string): Promise<EvidenceCheckpoint | undefined> {
    return this.evidence.getCheckpoint(checkpointId);
  }
  latestCheckpoint(tenantId: string, repository: string, ref: string): Promise<EvidenceCheckpoint | undefined> {
    return this.evidence.latestCheckpoint(tenantId, repository, ref);
  }
  listEvidence(checkpointId: string): Promise<EvidenceRecord[]> {
    return this.evidence.listEvidence(checkpointId);
  }
  resolveAnchor(
    checkpointId: string,
    anchor: Omit<EvidenceAnchor, "contentDigest">
  ): Promise<EvidenceRecord | undefined> {
    return this.evidence.resolveAnchor(checkpointId, anchor);
  }
  listManifest(checkpointId: string): Promise<RefManifestEntry[]> {
    return this.evidence.listManifest(checkpointId);
  }
  listStructuralFacts(checkpointId: string): Promise<StructuralFact[]> {
    return this.evidence.listStructuralFacts(checkpointId);
  }

  findSuccessfulRun(cacheKey: string): Promise<DerivationRun | undefined> {
    return this.knowledge.findSuccessfulRun(cacheKey);
  }
  commitKnowledge(input: KnowledgeCommit, fence?: ContextWriteFence): Promise<DerivationRun> {
    return this.knowledge.commitKnowledge(input, fence);
  }
  recordFailedRun(run: DerivationRun, fence?: ContextWriteFence): Promise<void> {
    return this.knowledge.recordFailedRun(run, fence);
  }
  getRun(runId: string): Promise<DerivationRun | undefined> {
    return this.knowledge.getRun(runId);
  }
  getRevision(revisionId: string): Promise<KnowledgeDocumentRevision | undefined> {
    return this.knowledge.getRevision(revisionId);
  }
  listRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]> {
    return this.knowledge.listRevisions(tenantId, repository);
  }
  listCitations(revisionId: string): Promise<KnowledgeEvidenceCitation[]> {
    return this.knowledge.listCitations(revisionId);
  }
  appendRevisionEvent(event: KnowledgeRevisionEvent): Promise<KnowledgeRevisionEvent> {
    return this.knowledge.appendRevisionEvent(event);
  }
  listRevisionEvents(revisionId: string): Promise<KnowledgeRevisionEvent[]> {
    return this.knowledge.listRevisionEvents(revisionId);
  }
  listCurrentEligibleRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]> {
    return this.knowledge.listCurrentEligibleRevisions(tenantId, repository);
  }

  publish(projection: GenerationProjection, fence?: ContextWriteFence): Promise<IndexGeneration> {
    return this.projection.publish(projection, fence);
  }
  getGeneration(generationId: string): Promise<GenerationProjection | undefined> {
    return this.projection.getGeneration(generationId);
  }
  getAuthorizedGeneration(
    generationId: string,
    allowedAclFingerprints: ReadonlySet<string>
  ): Promise<GenerationProjection | undefined> {
    return this.projection.getAuthorizedGeneration(generationId, allowedAclFingerprints);
  }
  latestPublished(tenantId: string, repository: string, ref: string): Promise<GenerationProjection | undefined> {
    return this.projection.latestPublished(tenantId, repository, ref);
  }
  listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]> {
    return this.projection.listGenerations(tenantId, repository);
  }

  async replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    const desired = new Set(repositories.map((repository) => repository.trim().toLowerCase()).filter(Boolean));
    await this.database.transactionAs("jina_context_admin", async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `repository-access:${tenantId}:${principalId}`
      ]);
      const now = new Date().toISOString();
      const registered = await client.query<{ repository: string }>(
        "select repository from jina_context.repositories where tenant_id=$1",
        [tenantId]
      );
      for (const repository of desired) {
        if (!registered.rows.some((row) => row.repository === repository)) {
          await client.query(
            `insert into jina_context.repositories
              (tenant_id,repository,provider,provider_repository_id,default_ref,metadata,created_at,updated_at)
             values ($1,$2,'unknown',$2,'main','{}'::jsonb,$3,$3)
             on conflict do nothing`,
            [tenantId, repository, now]
          );
          registered.rows.push({ repository });
        }
      }
      const repositoryNames = [...new Set(registered.rows.map((row) => row.repository))].sort();
      for (const repository of repositoryNames) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          repositoryAccessLockKey(tenantId, repository)
        ]);
      }
      const known = await client.query<{
        repository: string;
        permission: string | null;
        acl_fingerprint: string | null;
      }>(
        `select repository.repository,current.permission,current.acl_fingerprint
         from jina_context.repositories repository
         left join jina_context.current_repository_acl current
           on current.tenant_id=repository.tenant_id
          and current.repository=repository.repository
          and current.principal_id=$2
         where repository.tenant_id=$1`,
        [tenantId, principalId]
      );
      for (const row of known.rows) {
        const permission = desired.has(row.repository) ? "read" : "denied";
        const aclFingerprint = repositoryAclFingerprint(tenantId, row.repository);
        if (row.permission === permission && row.acl_fingerprint === aclFingerprint) continue;
        const version = await client.query<{ observed_at: Date; sequence: string }>(
          `select
             greatest(
               clock_timestamp(),
               coalesce(max(observed_at) + interval '1 microsecond',clock_timestamp())
             ) observed_at,
             (count(*) + 1)::text sequence
           from jina_context.repository_acl_observations
           where tenant_id=$1 and repository=$2 and principal_id=$3`,
          [tenantId, row.repository, principalId]
        );
        const observedAt = version.rows[0]!.observed_at.toISOString();
        const sequence = Number(version.rows[0]!.sequence);
        const payload = { principalId, repository: row.repository, permission, sequence };
        const digest = contextDigest(payload);
        const observationId = contextStableId("observation", { tenantId, ...payload, observedAt, digest });
        await client.query(
          `insert into jina_context.observations
            (id,tenant_id,repository,source,source_type,external_id,recorded_at,payload,content_digest)
           values ($1,$2,$3,'access','human_input',$4,$5,$6::jsonb,$7)
           on conflict (tenant_id,repository,id) do nothing`,
          [
            observationId,
            tenantId,
            row.repository,
            `${principalId}:${sequence}:${digest}`,
            observedAt,
            JSON.stringify(payload),
            digest
          ]
        );
        const aclId = contextStableId("acl", { observationId, principalId, sequence });
        await client.query(
          `insert into jina_context.repository_acl_observations
            (id,tenant_id,repository,principal_id,permission,acl_fingerprint,
             source_observation_id,observed_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (tenant_id,repository,id) do nothing`,
          [aclId, tenantId, row.repository, principalId, permission, aclFingerprint, observationId, observedAt]
        );
        await enqueueContextEvent(client, {
          id: contextStableId("event", { aclId }),
          sequence: 1,
          tenantId,
          repository: row.repository,
          aggregateType: "access",
          aggregateId: aclId,
          eventType: "access.replaced",
          payload: { aclObservationId: aclId, principalId, sequence },
          consumers: ["acl", "retention"],
          occurredAt: observedAt
        });
      }
    });
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ repository: string }>(
      "jina_context_admin",
      `select repository
       from jina_context.current_repository_acl
       where tenant_id=$1 and principal_id=$2 and permission in ('read','write','admin')
       order by repository`,
      [tenantId, principalId]
    );
    return result.rows.map((row) => row.repository);
  }

  async aclFingerprintsForPrincipal(tenantId: string, principalId: string, repository: string): Promise<string[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ acl_fingerprint: string }>(
      "jina_context_admin",
      `select distinct acl_fingerprint
       from jina_context.current_repository_acl
       where tenant_id=$1 and repository=$2 and principal_id=$3
         and permission in ('read','write','admin')
       order by acl_fingerprint`,
      [tenantId, repository, principalId]
    );
    return result.rows.map((row) => row.acl_fingerprint);
  }

  async repositoryAccessFingerprint(tenantId: string, repository: string): Promise<string> {
    return this.database.transactionAs("jina_context_admin", async (client) => {
      await lockRepositoryAccess(client, tenantId, repository);
      return currentRepositoryAccessFingerprint(client, tenantId, repository);
    });
  }

  async projectionInputFingerprint(tenantId: string, repository: string): Promise<string> {
    await this.database.initialize();
    return this.database.transactionAs("jina_context_coordinator", (client) =>
      currentProjectionInputFingerprint(client, tenantId, repository)
    );
  }

  async listRepositories(tenantId: string): Promise<string[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ repository: string }>(
      "jina_context_admin",
      "select repository from jina_context.repositories where tenant_id=$1 order by repository",
      [tenantId]
    );
    return result.rows.map((row) => row.repository);
  }

  async projectionBacklog(tenantId: string): Promise<ProjectionBacklog> {
    await this.database.initialize();
    const result = await this.database.queryAs<{
      consumer: keyof ProjectionBacklog;
      count: string;
      oldest: Date | null;
    }>(
      "jina_context_admin",
      `select consumer,count(*)::text as count,min(available_at) as oldest
       from jina_context.outbox
       where tenant_id=$1 and processed_at is null
       group by consumer`,
      [tenantId]
    );
    const byConsumer = new Map(result.rows.map((row) => [row.consumer, row]));
    const consumers = [
      "manifest",
      "knowledge-current",
      "lexical",
      "dense",
      "hierarchy",
      "structural",
      "identity",
      "acl",
      "retention"
    ] as const;
    return Object.fromEntries(
      consumers.map((consumer) => {
        const row = byConsumer.get(consumer);
        return [
          consumer,
          {
            count: Number(row?.count ?? 0),
            ...(row?.oldest ? { oldestAvailableAt: row.oldest.toISOString() } : {})
          }
        ];
      })
    ) as ProjectionBacklog;
  }

  async pendingProjectionCheckpoints(tenantId: string, limit: number): Promise<string[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ checkpoint_id: string }>(
      "jina_context_admin",
      `with pending_scope as (
         select distinct checkpoint.id as checkpoint_id,delivery.available_at
         from jina_context.outbox delivery
         join jina_context.evidence_checkpoints checkpoint
           on checkpoint.id=delivery.payload->>'checkpointId'
          and checkpoint.tenant_id=delivery.tenant_id
          and checkpoint.repository=delivery.repository
         where delivery.tenant_id=$1 and delivery.processed_at is null
           and checkpoint.id=(
             select latest.id
             from jina_context.evidence_checkpoints latest
             where latest.tenant_id=checkpoint.tenant_id
               and latest.repository=checkpoint.repository
               and latest.ref_name=checkpoint.ref_name
             order by latest.ref_sequence desc,latest.id desc
             limit 1
           )
         union
         select distinct checkpoint.id as checkpoint_id,delivery.available_at
         from jina_context.outbox delivery
         join jina_context.knowledge_document_revisions revision
           on revision.id=delivery.aggregate_id
          and revision.tenant_id=delivery.tenant_id
          and revision.repository=delivery.repository
         join jina_context.evidence_checkpoints checkpoint
           on checkpoint.tenant_id=revision.tenant_id
          and checkpoint.repository=revision.repository
          and checkpoint.ref_name=revision.ref_name
          and checkpoint.commit_sha=revision.commit_sha
         where delivery.tenant_id=$1 and delivery.processed_at is null
           and delivery.aggregate_type='knowledge'
           and checkpoint.id=(
             select latest.id
             from jina_context.evidence_checkpoints latest
             where latest.tenant_id=checkpoint.tenant_id
               and latest.repository=checkpoint.repository
               and latest.ref_name=checkpoint.ref_name
             order by latest.ref_sequence desc,latest.id desc
             limit 1
           )
         union
         select distinct on (checkpoint.repository,checkpoint.ref_name)
           checkpoint.id as checkpoint_id,delivery.available_at
         from jina_context.outbox delivery
         join jina_context.evidence_checkpoints checkpoint
           on checkpoint.tenant_id=delivery.tenant_id
          and checkpoint.repository=delivery.repository
         where delivery.tenant_id=$1 and delivery.processed_at is null
           and delivery.aggregate_type in ('access','retention')
         order by checkpoint.repository,checkpoint.ref_name,checkpoint.ref_sequence desc
       )
       select checkpoint_id
       from pending_scope
       group by checkpoint_id
       order by min(available_at),checkpoint_id
       limit $2`,
      [tenantId, Math.max(1, Math.min(limit, 100))]
    );
    return result.rows.map((row) => row.checkpoint_id);
  }

  recordQueryRun(run: QueryRunTelemetry): Promise<void> {
    return this.query.recordQueryRun(run);
  }

  queryMetrics(tenantId: string): Promise<QueryMetrics> {
    return this.query.metrics(tenantId);
  }

  async eraseEvidence(input: EraseEvidenceInput): Promise<{ erasedGenerationCount: number }> {
    if (!input.sourceId.trim() || !input.actorId.trim() || !input.reason.trim()) {
      throw new Error("Evidence erasure requires sourceId, actorId, and reason");
    }
    return this.database.transactionAs("jina_context_admin", async (client) => {
      await lockProjectionInput(client, input.tenantId, input.repository);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `context-erasure:${input.tenantId}:${input.repository}`
      ]);
      const id = contextStableId("erasure", {
        tenantId: input.tenantId,
        repository: input.repository,
        sourceType: input.sourceType,
        sourceId: input.sourceId
      });
      await client.query(
        `insert into jina_context.erasure_filters
          (id,tenant_id,repository,source_type,source_id,reason,actor_id,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id,repository,id) do nothing`,
        [
          id,
          input.tenantId,
          input.repository,
          input.sourceType,
          input.sourceId,
          input.reason,
          input.actorId,
          input.createdAt
        ]
      );
      const sequence = await client.query<{ next: string }>(
        `select (coalesce(max(sequence),0)+1)::text as next
         from jina_context.audit_events
         where tenant_id=$1 and repository=$2`,
        [input.tenantId, input.repository]
      );
      const auditId = contextStableId("audit", { erasureId: id, sequence: sequence.rows[0]!.next });
      await client.query(
        `insert into jina_context.audit_events
          (id,tenant_id,repository,sequence,actor_id,action,target_type,target_id,payload,occurred_at)
         values ($1,$2,$3,$4,$5,'evidence.erased','evidence_source',$6,$7::jsonb,$8)
         on conflict do nothing`,
        [
          auditId,
          input.tenantId,
          input.repository,
          sequence.rows[0]!.next,
          input.actorId,
          input.sourceId,
          JSON.stringify({ sourceType: input.sourceType, reason: input.reason }),
          input.createdAt
        ]
      );
      await appendProjectionInputEvent(client, {
        tenantId: input.tenantId,
        repository: input.repository,
        id: `projection-input:erasure:${id}`,
        eventType: "evidence.erased",
        aggregateId: id,
        occurredAt: input.createdAt
      });
      const invalidated = await client.query(
        `update jina_context.index_generations
         set status='invalidated',invalidated_at=$3
         where tenant_id=$1 and repository=$2 and status='published'`,
        [input.tenantId, input.repository, input.createdAt]
      );
      await enqueueContextEvent(client, {
        id: contextStableId("event", { erasureId: id }),
        sequence: 1,
        tenantId: input.tenantId,
        repository: input.repository,
        aggregateType: "retention",
        aggregateId: id,
        eventType: "evidence.erased",
        payload: { sourceType: input.sourceType, sourceId: input.sourceId },
        consumers: [...contextProjectionConsumers],
        occurredAt: input.createdAt
      });
      return { erasedGenerationCount: invalidated.rowCount ?? 0 };
    });
  }

  async migrateTenantAliases(fromTenantId: string, toTenantId: string): Promise<void> {
    if (fromTenantId === toTenantId) return;
    await this.database.initialize();
    const principals = await this.database.queryAs<{ principal_id: string; repository: string }>(
      "jina_context_admin",
      `select principal_id,repository from jina_context.current_repository_acl
       where tenant_id=$1 and permission in ('read','write','admin')`,
      [fromTenantId]
    );
    const byPrincipal = new Map<string, string[]>();
    for (const row of principals.rows) {
      const values = byPrincipal.get(row.principal_id) ?? [];
      values.push(row.repository);
      byPrincipal.set(row.principal_id, values);
    }
    for (const [principalId, repositories] of byPrincipal) {
      const current = await this.repositoriesForPrincipal(toTenantId, principalId);
      await this.replaceRepositoryAccess(toTenantId, principalId, [...new Set([...current, ...repositories])]);
    }
  }

  async health(): Promise<{ ok: boolean; adapter: string }> {
    try {
      await this.database.initialize();
      await this.database.queryAs("jina_context_admin", "select 1");
      return { ok: true, adapter: "postgres" };
    } catch {
      return { ok: false, adapter: "postgres" };
    }
  }

  close(): Promise<void> {
    return this.database.close();
  }
}

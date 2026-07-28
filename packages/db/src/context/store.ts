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
  type ApiTokenRecord,
  type DerivationProgressPage,
  type DerivationProgressSnapshot,
  type MintApiTokenInput,
  type ProjectionBacklog,
  type QueryPlan,
  type VerifiedApiToken,
  type QueryRoute,
  type RetrievalCandidate,
  type QueryMetrics,
  type QueryRunTelemetry,
  type RefManifestEntry,
  type StructuralFact,
  exactTerms,
  fingerprint,
  repositoryAclFingerprint,
  stableId
} from "@jina/context-engine";
import type { PoolClient } from "pg";
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
import { PostgresContextQueryRepository, type StoredRetrievalCandidate } from "./query-repository.js";
import { PostgresApiTokenRepository } from "./api-token-repository.js";
import { PostgresDerivationProgressRepository } from "./derivation-progress-repository.js";

/**
 * Cohesive store façade for domain services. SQL remains split across the
 * evidence, knowledge, and projection repositories.
 */
export class PostgresContextEngineStore implements ContextEngineStore {
  readonly enforcesWriteFences = true as const;
  readonly nativeExactIndex = true as const;
  readonly database: ContextDatabase;
  readonly evidence: PostgresEvidenceRepository;
  readonly knowledge: PostgresKnowledgeRepository;
  readonly projection: PostgresProjectionRepository;
  readonly query: PostgresContextQueryRepository;
  readonly apiTokens: PostgresApiTokenRepository;
  readonly derivationProgressStore: PostgresDerivationProgressRepository;

  constructor(config: PostgresContextDatabaseConfig | ContextDatabase) {
    this.database = config instanceof ContextDatabase ? config : new ContextDatabase(config);
    this.evidence = new PostgresEvidenceRepository(this.database);
    this.knowledge = new PostgresKnowledgeRepository(this.database);
    this.projection = new PostgresProjectionRepository(this.database);
    this.query = new PostgresContextQueryRepository(this.database);
    this.apiTokens = new PostgresApiTokenRepository(this.database);
    this.derivationProgressStore = new PostgresDerivationProgressRepository(this.database);
  }

  verifyApiToken(secretHash: string): Promise<VerifiedApiToken | undefined> {
    return this.apiTokens.verifyApiToken(secretHash);
  }
  stampApiTokenUse(tenantId: string, tokenId: string, usedAt: string): Promise<void> {
    return this.apiTokens.stampApiTokenUse(tenantId, tokenId, usedAt);
  }
  mintApiToken(token: MintApiTokenInput): Promise<ApiTokenRecord> {
    return this.apiTokens.mintApiToken(token);
  }
  listApiTokens(tenantId: string): Promise<ApiTokenRecord[]> {
    return this.apiTokens.listApiTokens(tenantId);
  }
  revokeApiToken(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined> {
    return this.apiTokens.revokeApiToken(tenantId, tokenId, revokedBy, revokedAt);
  }

  recordDerivationProgress(input: {
    tenantId: string;
    buildId: string;
    stageId: string;
    checkpointId: string;
    pages: readonly DerivationProgressPage[];
    at: string;
  }): Promise<void> {
    return this.derivationProgressStore.record(input);
  }
  derivationProgress(tenantId: string, buildId: string): Promise<DerivationProgressSnapshot> {
    return this.derivationProgressStore.snapshot(tenantId, buildId);
  }
  derivationProgressPages(tenantId: string, stageId: string): Promise<DerivationProgressPage[]> {
    return this.derivationProgressStore.pagesForStage(tenantId, stageId);
  }
  clearDerivationProgress(tenantId: string, stageId: string): Promise<void> {
    return this.derivationProgressStore.clear(tenantId, stageId);
  }

  runInTenantScope<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runInTenantScope(tenantId, operation);
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
  getScopedRevision(
    tenantId: string,
    repositories: readonly string[],
    revisionId: string
  ): Promise<KnowledgeDocumentRevision | undefined> {
    return this.knowledge.getScopedRevision(tenantId, repositories, revisionId);
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
  listCheckpointRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]> {
    return this.knowledge.listCheckpointRevisions(tenantId, repository, checkpointId);
  }
  listCurrentEligibleRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]> {
    return this.knowledge.listCurrentEligibleRevisions(tenantId, repository, checkpointId);
  }

  publish(projection: GenerationProjection, fence?: ContextWriteFence): Promise<IndexGeneration> {
    return this.projection.publish(projection, fence);
  }
  getGeneration(generationId: string): Promise<GenerationProjection | undefined> {
    return this.projection.getGeneration(generationId);
  }
  getScopedGeneration(
    tenantId: string,
    repositories: readonly string[],
    generationId: string
  ): Promise<GenerationProjection | undefined> {
    return this.projection.getScopedGeneration(tenantId, repositories, generationId);
  }
  getAuthorizedGeneration(generationId: string, principalId: string): Promise<GenerationProjection | undefined> {
    return this.projection.getAuthorizedGeneration(generationId, principalId);
  }
  latestPublished(tenantId: string, repository: string, ref: string): Promise<GenerationProjection | undefined> {
    return this.projection.latestPublished(tenantId, repository, ref);
  }
  listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]> {
    return this.projection.listGenerations(tenantId, repository);
  }

  latestAuthorizedGeneration(
    tenantId: string,
    repository: string,
    ref: string,
    principalId: string
  ): Promise<IndexGeneration | undefined> {
    return this.query.latestPublished(tenantId, repository, ref, principalId);
  }

  async retrieveIndexed(input: {
    tenantId: string;
    repository: string;
    principalId: string;
    generation: IndexGeneration;
    plan: QueryPlan;
    route: QueryRoute;
    limit: number;
    allowedAclFingerprints: ReadonlySet<string>;
  }): Promise<RetrievalCandidate[]> {
    if (input.route === "dense") return [];
    if (input.route === "structural") {
      const identifiers = exactTerms(input.plan);
      const relations = (
        await Promise.all(
          identifiers.slice(0, 20).map((identifier) =>
            this.query.structuralNeighbors({
              tenantId: input.tenantId,
              repository: input.repository,
              principalId: input.principalId,
              generationId: input.generation.id,
              identifier,
              limit: input.limit
            })
          )
        )
      ).flat();
      const aclFingerprint =
        [...input.allowedAclFingerprints].sort()[0] ?? input.generation.repositoryAccessFingerprint;
      return uniqueById(
        relations.map((relation) => ({
          id: stableId("rc", { route: input.route, relationId: relation.id }),
          retriever: input.route,
          sourceKind: "structure" as const,
          sourceId: relation.id,
          title: `${relation.kind}: ${relation.from} → ${relation.to}`,
          excerpt: `${relation.from} ${relation.kind} ${relation.to}`,
          contextualText: JSON.stringify(relation.metadata),
          anchors: [...relation.anchors],
          rawScore: 1,
          scoreSemantics: "indexed structural neighbor",
          exactMatch: true,
          authorityClass: "deterministic_analysis",
          effectiveAclFingerprint: aclFingerprint,
          contentFingerprint: fingerprint({
            relationId: relation.id,
            anchors: relation.anchors
          }),
          explanation: "indexed structural relation",
          metadata: relation.metadata
        }))
      ).slice(0, input.limit);
    }

    let rows: readonly StoredRetrievalCandidate[];
    if (input.route === "exact") {
      const terms = exactTerms(input.plan);
      rows = (
        await Promise.all(
          terms.slice(0, 50).map((term) =>
            this.query.exactLookup({
              tenantId: input.tenantId,
              repository: input.repository,
              principalId: input.principalId,
              generationId: input.generation.id,
              term,
              limit: input.limit
            })
          )
        )
      ).flat();
    } else if (input.route === "hierarchy") {
      rows = await this.query.hierarchySearch({
        tenantId: input.tenantId,
        repository: input.repository,
        principalId: input.principalId,
        generationId: input.generation.id,
        query: indexedQueryText(input.plan),
        limit: input.limit
      });
    } else if (input.route === "long_context") {
      rows = await this.query.longContextSearch({
        tenantId: input.tenantId,
        repository: input.repository,
        principalId: input.principalId,
        generationId: input.generation.id,
        query: indexedQueryText(input.plan),
        limit: input.limit
      });
    } else if (input.route === "structured" && structuredTargets(input.plan).length === 0) {
      rows = await this.query.browse({
        tenantId: input.tenantId,
        repository: input.repository,
        principalId: input.principalId,
        generationId: input.generation.id,
        limit: input.limit,
        sourceKinds: ["provider"],
        ...(input.plan.timeWindow ? { timeWindow: input.plan.timeWindow } : {})
      });
    } else if (input.route === "temporal" && input.plan.timeWindow) {
      rows = await this.query.browse({
        tenantId: input.tenantId,
        repository: input.repository,
        principalId: input.principalId,
        generationId: input.generation.id,
        limit: input.limit,
        sourceKinds: ["provider", "knowledge"],
        timeWindow: input.plan.timeWindow
      });
    } else {
      const sourceKinds =
        input.route === "knowledge"
          ? ["knowledge"]
          : input.route === "structured"
            ? ["provider"]
            : input.route === "temporal"
              ? ["provider", "knowledge"]
              : undefined;
      rows = await this.query.lexicalSearch({
        tenantId: input.tenantId,
        repository: input.repository,
        principalId: input.principalId,
        generationId: input.generation.id,
        query: indexedQueryText(input.plan),
        limit: input.limit,
        ...(sourceKinds ? { sourceKinds } : {})
      });
    }
    return uniqueById(
      rows.map((row) => {
        const sourceKind = indexedSourceKind(row.sourceKind);
        const rawScore = input.route === "exact" ? row.exactScore : Math.max(row.exactScore * 2, row.proseScore);
        const retrieval = indexedRetrievalDescription(input.route);
        return {
          id: stableId("rc", { route: input.route, storedId: row.id }),
          retriever: input.route,
          documentId: row.documentId,
          sourceKind,
          sourceId: row.sourceId,
          ...(row.sourceRevisionId ? { sourceRevisionId: row.sourceRevisionId } : {}),
          title: row.title,
          excerpt: row.text,
          contextualText: row.contextualText,
          anchors: [...row.anchors],
          rawScore,
          scoreSemantics: retrieval.scoreSemantics,
          exactMatch: input.route === "exact",
          authorityClass: row.authorityClass,
          effectiveAclFingerprint: row.effectiveAclFingerprint,
          contentFingerprint: fingerprint({ sourceFingerprint: row.sourceFingerprint, excerpt: row.text }),
          explanation: retrieval.explanation,
          metadata: { ...row.metadata }
        };
      })
    ).slice(0, input.limit);
  }

  async replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    const desired = new Set(repositories.map((repository) => repository.trim().toLowerCase()).filter(Boolean));
    await this.database.transactionAs("jina_context_admin", { tenantIds: [tenantId] }, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `repository-access:${tenantId}:${principalId}`
      ]);
      await this.#setRepositoryAccess(client, tenantId, principalId, desired);
    });
  }

  async mergeRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    const requested = new Set(repositories.map((repository) => repository.trim().toLowerCase()).filter(Boolean));
    await this.database.transactionAs("jina_context_admin", { tenantIds: [tenantId] }, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `repository-access:${tenantId}:${principalId}`
      ]);
      const current = await client.query<{ repository: string }>(
        `select repository
         from jina_context.current_repository_acl
         where tenant_id=$1 and principal_id=$2 and permission in ('read','write','admin')`,
        [tenantId, principalId]
      );
      await this.#setRepositoryAccess(
        client,
        tenantId,
        principalId,
        new Set([...current.rows.map((row) => row.repository), ...requested])
      );
    });
  }

  async #setRepositoryAccess(
    client: PoolClient,
    tenantId: string,
    principalId: string,
    desired: ReadonlySet<string>
  ): Promise<void> {
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
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ repository: string }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
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
      { tenantIds: [tenantId] },
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
    return this.database.transactionAs("jina_context_admin", { tenantIds: [tenantId] }, async (client) => {
      await lockRepositoryAccess(client, tenantId, repository);
      return currentRepositoryAccessFingerprint(client, tenantId, repository);
    });
  }

  async latestAdmittedRefSequence(tenantId: string, repository: string, ref: string): Promise<number> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ ref_sequence: string }>(
      "jina_context_coordinator",
      { tenantIds: [tenantId] },
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
      [tenantId, repository, ref]
    );
    const sequence = Number(result.rows[0]!.ref_sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error(`Ref sequence exceeds the supported range for ${repository}@${ref}`);
    }
    return sequence;
  }

  async projectionInputFingerprint(tenantId: string, repository: string): Promise<string> {
    await this.database.initialize();
    return this.database.transactionAs("jina_context_coordinator", { tenantIds: [tenantId] }, (client) =>
      currentProjectionInputFingerprint(client, tenantId, repository)
    );
  }

  async listRepositories(tenantId: string): Promise<string[]> {
    await this.database.initialize();
    const result = await this.database.queryAs<{ repository: string }>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
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
      { tenantIds: [tenantId] },
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
    return this.database.transactionAs("jina_context_admin", { tenantIds: [tenantId] }, async (client) => {
      await client.query(
        `update jina_context.outbox delivery
         set processed_at=clock_timestamp(),lease_id=null,lease_owner=null,lease_expires_at=null,
             last_error='superseded by a newer admitted ref sequence'
         where delivery.tenant_id=$1 and delivery.processed_at is null
           and (
             (
               delivery.aggregate_type='evidence'
               and exists (
                 select 1
                 from jina_context.evidence_checkpoints checkpoint
                 where checkpoint.tenant_id=delivery.tenant_id
                   and checkpoint.repository=delivery.repository
                   and checkpoint.id=coalesce(delivery.payload->>'checkpointId',delivery.aggregate_id)
                   and checkpoint.ref_sequence < greatest(
                     coalesce((
                       select max(build.ref_sequence)
                       from jina_context.pipeline_builds build
                       where build.tenant_id=checkpoint.tenant_id
                         and build.repository=checkpoint.repository
                         and build.ref_name=checkpoint.ref_name
                     ),0),
                     coalesce((
                       select max(committed.ref_sequence)
                       from jina_context.evidence_checkpoints committed
                       where committed.tenant_id=checkpoint.tenant_id
                         and committed.repository=checkpoint.repository
                         and committed.ref_name=checkpoint.ref_name
                     ),0)
                   )
               )
             )
             or (
               delivery.aggregate_type='knowledge'
               and exists (
                 select 1
                 from jina_context.knowledge_document_revisions revision
                 where revision.tenant_id=delivery.tenant_id
                   and revision.repository=delivery.repository
                   and revision.id=delivery.aggregate_id
                   and coalesce((
                     select max(source_checkpoint.ref_sequence)
                     from jina_context.evidence_checkpoints source_checkpoint
                     where source_checkpoint.tenant_id=revision.tenant_id
                       and source_checkpoint.repository=revision.repository
                       and source_checkpoint.ref_name=revision.ref_name
                       and source_checkpoint.commit_sha=revision.commit_sha
                   ),0) < greatest(
                     coalesce((
                       select max(build.ref_sequence)
                       from jina_context.pipeline_builds build
                       where build.tenant_id=revision.tenant_id
                         and build.repository=revision.repository
                         and build.ref_name=revision.ref_name
                     ),0),
                     coalesce((
                       select max(committed.ref_sequence)
                       from jina_context.evidence_checkpoints committed
                       where committed.tenant_id=revision.tenant_id
                         and committed.repository=revision.repository
                         and committed.ref_name=revision.ref_name
                     ),0)
                   )
               )
             )
           )`,
        [tenantId]
      );
      const result = await client.query<{ checkpoint_id: string }>(
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
         select distinct checkpoint.id as checkpoint_id,delivery.available_at
         from jina_context.outbox delivery
         join jina_context.evidence_checkpoints checkpoint
           on checkpoint.tenant_id=delivery.tenant_id
          and checkpoint.repository=delivery.repository
         where delivery.tenant_id=$1 and delivery.processed_at is null
           and delivery.aggregate_type in ('access','retention')
           and checkpoint.id=(
             select latest.id
             from jina_context.evidence_checkpoints latest
             where latest.tenant_id=checkpoint.tenant_id
               and latest.repository=checkpoint.repository
               and latest.ref_name=checkpoint.ref_name
             order by latest.ref_sequence desc,latest.id desc
             limit 1
           )
       )
       select checkpoint_id
       from pending_scope
       group by checkpoint_id
       order by min(available_at),checkpoint_id
       limit $2`,
        [tenantId, Math.max(1, Math.min(limit, 100))]
      );
      return result.rows.map((row) => row.checkpoint_id);
    });
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
    return this.database.transactionAs("jina_context_admin", { tenantIds: [input.tenantId] }, async (client) => {
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
      { tenantIds: [fromTenantId] },
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
      await this.mergeRepositoryAccess(toTenantId, principalId, repositories);
    }
  }

  async health(): Promise<{ ok: boolean; adapter: string }> {
    try {
      await this.database.initialize();
      await this.database.pool.query("select 1");
      return { ok: true, adapter: "postgres" };
    } catch {
      return { ok: false, adapter: "postgres" };
    }
  }

  close(): Promise<void> {
    return this.database.close();
  }
}

function indexedQueryText(plan: QueryPlan): string {
  const searchable = [
    plan.normalizedQuestion,
    ...(plan.targets.paths ?? []),
    ...(plan.targets.symbols ?? []),
    ...(plan.targets.pullRequests ?? []),
    ...(plan.targets.issues ?? [])
  ]
    .filter(Boolean)
    .join(" ");
  const lexemes = [
    ...new Set(
      [
        ...searchable
          .normalize("NFKC")
          .toLowerCase()
          .matchAll(/[a-z0-9_]+/g)
      ].map((match) => match[0])
    )
  ];
  // PostgreSQL websearch_to_tsquery combines ordinary terms with AND, while
  // the deterministic retrieval contract ranks any meaningful token overlap.
  // An OR tsquery preserves that contract and still uses the GIN vectors.
  return lexemes.length > 0 ? lexemes.join(" | ") : "jina_no_query_terms";
}

function structuredTargets(plan: QueryPlan): string[] {
  return [
    ...(plan.targets.pullRequests ?? []),
    ...(plan.targets.issues ?? []),
    ...[...plan.normalizedQuestion.matchAll(/#[1-9][0-9]*/g)].map((match) => match[0])
  ];
}

function indexedSourceKind(value: string): RetrievalCandidate["sourceKind"] {
  if (value === "code" || value === "provider" || value === "knowledge" || value === "structure") return value;
  throw new Error(`Unsupported indexed source kind: ${value}`);
}

function indexedRetrievalDescription(route: QueryRoute): {
  scoreSemantics: string;
  explanation: string;
} {
  switch (route) {
    case "exact":
      return { scoreSemantics: "materialized exact-index match", explanation: "materialized exact-index term match" };
    case "hierarchy":
      return { scoreSemantics: "hierarchy-node full-text rank", explanation: "indexed hierarchy-node match" };
    case "long_context":
      return {
        scoreSemantics: "full-document full-text rank",
        explanation: "indexed full-document long-context match"
      };
    case "structured":
      return { scoreSemantics: "canonical provider lookup", explanation: "indexed canonical provider retrieval" };
    case "temporal":
      return { scoreSemantics: "time-window source lookup", explanation: "indexed time-window retrieval" };
    case "knowledge":
      return { scoreSemantics: "knowledge fragment full-text rank", explanation: "indexed knowledge retrieval" };
    case "lexical":
      return { scoreSemantics: "fragment full-text rank", explanation: "indexed lexical-fragment retrieval" };
    case "dense":
      return { scoreSemantics: "dense similarity", explanation: "indexed dense retrieval" };
    case "structural":
      return { scoreSemantics: "structural neighbor match", explanation: "indexed structural neighbor" };
  }
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value] as const)).values()];
}

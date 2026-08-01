import {
  evidenceExcerpt,
  type EvidenceAnchor,
  type EvidenceCheckpoint,
  type EvidenceRecord,
  type EvidenceSnapshot,
  type RefManifestEntry,
  type StructuralFact
} from "../domain/evidence.js";
import { validateEvidenceRecord } from "../domain/evidence.js";
import type { DerivationProgressPage, DerivationProgressSnapshot } from "../derive/progress.js";
import { derivationProgressDocumentPath } from "../derive/progress.js";
import type { ContextOrchestrationState } from "../derive/orchestration.js";
import { fingerprint, normalizeRepository, repositoryAclFingerprint, stableId } from "../domain/fingerprint.js";
import type {
  DerivationRun,
  KnowledgeDocumentRevision,
  KnowledgeEvidenceCitation,
  KnowledgeRevisionEvent
} from "../domain/knowledge.js";
import {
  requiresKnowledgeReview,
  sameImmutableKnowledgeCitation,
  sameImmutableKnowledgeRevision
} from "../domain/knowledge.js";
import type { GenerationProjection, IndexGeneration } from "../domain/projection.js";
import { contextProjectionConsumers } from "../domain/projection.js";
import type {
  ApiTokenRecord,
  ContextEngineStore,
  EraseEvidenceInput,
  MintApiTokenInput,
  ProjectionBacklog,
  QueryMetrics,
  QueryRunTelemetry,
  VerifiedApiToken
} from "../ports/context-engine-store.js";
import type { KnowledgeCommit } from "../ports/knowledge-store.js";

function scopeKey(tenantId: string, repository: string, ref: string): string {
  return `${tenantId}\u0000${repository}\u0000${ref}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Drops the hash on the way out, so no read path can return it by accident. */
function publicApiToken(token: ApiTokenRecord & { readonly secretHash: string }): ApiTokenRecord {
  const { secretHash: _secretHash, ...rest } = token;
  return { ...rest, scopes: [...rest.scopes] };
}

export class MemoryContextEngineStore implements ContextEngineStore {
  readonly #checkpoints = new Map<string, EvidenceCheckpoint>();
  readonly #snapshots = new Map<string, EvidenceSnapshot>();
  readonly #latestCheckpoints = new Map<string, string>();
  readonly #runs = new Map<string, DerivationRun>();
  readonly #successfulRuns = new Map<string, string>();
  readonly #revisions = new Map<string, KnowledgeDocumentRevision>();
  readonly #citations = new Map<string, KnowledgeEvidenceCitation[]>();
  readonly #events = new Map<string, KnowledgeRevisionEvent[]>();
  readonly #projections = new Map<string, GenerationProjection>();
  readonly #latestGenerations = new Map<string, string>();
  readonly #repositoryAccess = new Map<string, Set<string>>();
  readonly #repositoryAccessVersions = new Map<string, number>();
  readonly #projectionInputFrontiers = new Map<string, { sequence: number; eventId: string }>();
  readonly #erasures = new Set<string>();
  readonly #queryRuns: QueryRunTelemetry[] = [];
  readonly #apiTokens = new Map<string, ApiTokenRecord & { readonly secretHash: string }>();
  #closed = false;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  runInTenantScope<T>(_tenantId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Context engine store is closed");
  }

  async commitSnapshot(snapshot: EvidenceSnapshot): Promise<EvidenceCheckpoint> {
    this.#assertOpen();
    const existing = this.#checkpoints.get(snapshot.checkpoint.id);
    if (existing !== undefined) {
      if (existing.evidenceFingerprint !== snapshot.checkpoint.evidenceFingerprint) {
        throw new Error("Checkpoint identity collision");
      }
      return copy(existing);
    }
    for (const record of snapshot.records) validateEvidenceRecord(record);
    const recordIds = new Set(snapshot.records.map((record) => record.id));
    if (recordIds.size !== snapshot.records.length) throw new Error("Duplicate evidence record");
    this.#checkpoints.set(snapshot.checkpoint.id, copy(snapshot.checkpoint));
    this.#snapshots.set(snapshot.checkpoint.id, copy(snapshot));
    const key = scopeKey(snapshot.checkpoint.tenantId, snapshot.checkpoint.repository, snapshot.checkpoint.ref);
    const latestId = this.#latestCheckpoints.get(key);
    const latest = latestId === undefined ? undefined : this.#checkpoints.get(latestId);
    const becameLatest = latest === undefined || snapshot.checkpoint.refSequence > latest.refSequence;
    if (becameLatest) {
      this.#latestCheckpoints.set(key, snapshot.checkpoint.id);
      this.#advanceProjectionInput(
        snapshot.checkpoint.tenantId,
        snapshot.checkpoint.repository,
        `projection-input:evidence:${snapshot.checkpoint.id}`
      );
    }
    return copy(snapshot.checkpoint);
  }

  async getCheckpoint(checkpointId: string): Promise<EvidenceCheckpoint | undefined> {
    const value = this.#checkpoints.get(checkpointId);
    return value === undefined ? undefined : copy(value);
  }

  async latestCheckpoint(tenantId: string, repository: string, ref: string): Promise<EvidenceCheckpoint | undefined> {
    const id = this.#latestCheckpoints.get(scopeKey(tenantId, repository, ref));
    return id === undefined ? undefined : this.getCheckpoint(id);
  }

  async listEvidence(checkpointId: string): Promise<EvidenceRecord[]> {
    return copy((this.#snapshots.get(checkpointId)?.records ?? []).filter((record) => !this.#isErased(record.anchor)));
  }

  async resolveAnchor(
    checkpointId: string,
    anchor: Omit<EvidenceAnchor, "contentDigest">
  ): Promise<EvidenceRecord | undefined> {
    const candidates = this.#snapshots.get(checkpointId)?.records ?? [];
    const record = candidates.find(
      (candidate) =>
        !this.#isErased(candidate.anchor) &&
        candidate.anchor.tenantId === anchor.tenantId &&
        candidate.anchor.repository === anchor.repository &&
        candidate.anchor.sourceType === anchor.sourceType &&
        candidate.anchor.sourceId === anchor.sourceId &&
        (anchor.commitSha === undefined || candidate.anchor.commitSha === anchor.commitSha) &&
        (anchor.pathOrUrl === undefined || candidate.anchor.pathOrUrl === anchor.pathOrUrl)
    );
    if (record === undefined) return undefined;
    if (evidenceExcerpt(record, anchor) === undefined) return undefined;
    return copy(record);
  }

  async listManifest(checkpointId: string): Promise<RefManifestEntry[]> {
    return copy(
      (this.#snapshots.get(checkpointId)?.manifest ?? []).filter(
        (entry) => !this.#erasures.has(`${entry.tenantId}\u0000${entry.repository}\u0000blob\u0000${entry.blobSha}`)
      )
    );
  }

  async listStructuralFacts(checkpointId: string): Promise<StructuralFact[]> {
    return copy(
      (this.#snapshots.get(checkpointId)?.structuralFacts ?? []).filter((fact) =>
        fact.anchors.every((anchor) => !this.#isErased(anchor))
      )
    );
  }

  async findSuccessfulRun(cacheKey: string): Promise<DerivationRun | undefined> {
    const id = this.#successfulRuns.get(cacheKey);
    const value = id === undefined ? undefined : this.#runs.get(id);
    return value === undefined ? undefined : copy(value);
  }

  async commitKnowledge(input: KnowledgeCommit): Promise<DerivationRun> {
    const checkpoint = await this.getCheckpoint(input.run.checkpointId);
    if (!checkpoint) throw new Error(`Unknown evidence checkpoint ${input.run.checkpointId}`);
    const latestCheckpoint = await this.latestCheckpoint(checkpoint.tenantId, checkpoint.repository, checkpoint.ref);
    if (latestCheckpoint?.id !== checkpoint.id) {
      throw new Error(`Checkpoint ${checkpoint.id} is superseded for ${checkpoint.repository}@${checkpoint.ref}`);
    }
    const existing = this.#successfulRuns.get(input.run.cacheKey);
    if (existing !== undefined) return copy(this.#runs.get(existing)!);
    if (input.run.status !== "succeeded") throw new Error("commitKnowledge requires a successful run");
    const ids = new Set(input.revisions.map((revision) => revision.id));
    if (ids.size !== input.revisions.length) throw new Error("Duplicate revisions in commit");
    if (input.run.revisionIds.length !== ids.size || input.run.revisionIds.some((revisionId) => !ids.has(revisionId))) {
      throw new Error("Derivation run revision IDs do not match the committed revisions");
    }
    for (const citation of input.citations) {
      if (!ids.has(citation.revisionId)) throw new Error("Citation must belong to a committed revision");
    }
    for (const revision of input.revisions) {
      const existingRevision = this.#revisions.get(revision.id);
      if (existingRevision !== undefined && !sameImmutableKnowledgeRevision(existingRevision, revision)) {
        throw new Error("Immutable revision identity collision");
      }
      const revisionCitations = input.citations
        .filter((citation) => citation.revisionId === revision.id)
        .sort((left, right) => left.ordinal - right.ordinal);
      if (revisionCitations.length === 0) throw new Error("Knowledge revisions require source citations");
      if (revisionCitations.some((citation, index) => citation.ordinal !== index)) {
        throw new Error("Knowledge citation ordinals must be contiguous");
      }
      const existingCitations = this.#citations.get(revision.id);
      if (
        existingCitations !== undefined &&
        (existingCitations.length !== revisionCitations.length ||
          existingCitations.some(
            (citation, index) => !sameImmutableKnowledgeCitation(citation, revisionCitations[index]!)
          ))
      ) {
        throw new Error("Immutable knowledge citations cannot be changed");
      }
    }
    this.#runs.set(input.run.id, copy(input.run));
    this.#successfulRuns.set(input.run.cacheKey, input.run.id);
    for (const revision of input.revisions) {
      if (!this.#revisions.has(revision.id)) this.#revisions.set(revision.id, copy(revision));
    }
    for (const citation of input.citations) {
      const values = this.#citations.get(citation.revisionId) ?? [];
      if (!values.some((value) => value.id === citation.id)) values.push(copy(citation));
      values.sort((left, right) => left.ordinal - right.ordinal);
      this.#citations.set(citation.revisionId, values);
    }
    this.#advanceProjectionInput(
      input.run.tenantId,
      input.run.repository,
      `projection-input:knowledge-run:${input.run.id}`
    );
    return copy(input.run);
  }

  async recordFailedRun(run: DerivationRun): Promise<void> {
    if (run.status !== "failed") throw new Error("recordFailedRun requires a failed run");
    this.#runs.set(run.id, copy(run));
  }

  async getRun(runId: string): Promise<DerivationRun | undefined> {
    const value = this.#runs.get(runId);
    return value === undefined ? undefined : copy(value);
  }

  async getRevision(revisionId: string): Promise<KnowledgeDocumentRevision | undefined> {
    const value = this.#revisions.get(revisionId);
    return value === undefined || this.#isRevisionErased(revisionId) ? undefined : copy(value);
  }

  async getScopedRevision(
    tenantId: string,
    repositories: readonly string[],
    revisionId: string
  ): Promise<KnowledgeDocumentRevision | undefined> {
    const revision = await this.getRevision(revisionId);
    return revision?.tenantId === tenantId && repositories.includes(revision.repository) ? revision : undefined;
  }

  async listRevisions(tenantId: string, repository: string): Promise<KnowledgeDocumentRevision[]> {
    return [...this.#revisions.values()]
      .filter(
        (revision) =>
          revision.tenantId === tenantId && revision.repository === repository && !this.#isRevisionErased(revision.id)
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async listCitations(revisionId: string): Promise<KnowledgeEvidenceCitation[]> {
    return copy((this.#citations.get(revisionId) ?? []).filter((citation) => !this.#isErased(citation.anchor)));
  }

  async listCitationsForRevisions(
    revisionIds: readonly string[]
  ): Promise<ReadonlyMap<string, KnowledgeEvidenceCitation[]>> {
    return new Map(
      await Promise.all(
        revisionIds.map(async (revisionId) => [revisionId, await this.listCitations(revisionId)] as const)
      )
    );
  }

  async appendRevisionEvent(event: KnowledgeRevisionEvent): Promise<KnowledgeRevisionEvent> {
    if (!this.#revisions.has(event.revisionId)) throw new Error("Unknown knowledge revision");
    const values = this.#events.get(event.revisionId) ?? [];
    const expected = values.length + 1;
    if (event.sequence !== expected) throw new Error(`Expected event sequence ${expected}`);
    if (values.some((value) => value.id === event.id)) throw new Error("Duplicate revision event");
    values.push(copy(event));
    this.#events.set(event.revisionId, values);
    const revision = this.#revisions.get(event.revisionId)!;
    this.#advanceProjectionInput(
      revision.tenantId,
      revision.repository,
      `projection-input:knowledge-event:${event.id}`
    );
    if (["rejected", "superseded", "invalidated", "redacted", "expired"].includes(event.type)) {
      for (const [id, projection] of [...this.#projections]) {
        if (
          projection.generation.tenantId === revision.tenantId &&
          projection.generation.repository === revision.repository &&
          projection.generation.ref === revision.scope.ref
        ) {
          this.#projections.delete(id);
        }
      }
      this.#latestGenerations.delete(scopeKey(revision.tenantId, revision.repository, revision.scope.ref));
    }
    return copy(event);
  }

  async listRevisionEvents(revisionId: string): Promise<KnowledgeRevisionEvent[]> {
    return copy(this.#events.get(revisionId) ?? []);
  }

  async listCheckpointRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]> {
    const checkpoint = this.#checkpoints.get(checkpointId);
    if (
      checkpoint === undefined ||
      checkpoint.tenantId !== tenantId ||
      checkpoint.repository !== normalizeRepository(repository)
    ) {
      return [];
    }
    const records = this.#snapshots.get(checkpointId)?.records ?? [];
    return (await this.listRevisions(tenantId, repository)).filter((revision) => {
      if (revision.scope.ref !== checkpoint.ref || revision.scope.commitSha !== checkpoint.commitSha) return false;
      return (this.#citations.get(revision.id) ?? []).every((citation) =>
        records.some(
          (record) =>
            record.anchor.sourceType === citation.anchor.sourceType &&
            record.anchor.sourceId === citation.anchor.sourceId &&
            record.anchor.contentDigest === citation.anchor.contentDigest &&
            record.anchor.commitSha === citation.anchor.commitSha &&
            record.anchor.pathOrUrl === citation.anchor.pathOrUrl
        )
      );
    });
  }

  async listCurrentEligibleRevisions(
    tenantId: string,
    repository: string,
    checkpointId: string
  ): Promise<KnowledgeDocumentRevision[]> {
    const revisions = await this.listCheckpointRevisions(tenantId, repository, checkpointId);
    const eligible = revisions.filter((revision) => {
      const events = this.#events.get(revision.id) ?? [];
      if (
        events.some((event) => ["rejected", "invalidated", "redacted", "superseded", "expired"].includes(event.type))
      ) {
        return false;
      }
      if ((this.#citations.get(revision.id) ?? []).some((citation) => this.#isErased(citation.anchor))) {
        return false;
      }
      return !requiresKnowledgeReview(revision.kind) || events.some((event) => event.type === "reviewed");
    });
    const current = new Map<string, KnowledgeDocumentRevision>();
    for (const revision of eligible) {
      const prior = current.get(revision.logicalId);
      if (
        prior === undefined ||
        prior.createdAt < revision.createdAt ||
        (prior.createdAt === revision.createdAt && prior.id < revision.id)
      ) {
        current.set(revision.logicalId, revision);
      }
    }
    return [...current.values()].map(copy);
  }

  async publish(projection: GenerationProjection): Promise<IndexGeneration> {
    this.#assertOpen();
    const generation = projection.generation;
    const required = ["manifest", "lexical", "identity", "acl", "retention"] as const;
    if (generation.status !== "published" || generation.publishedAt === undefined) {
      throw new Error("Only a fully published generation may be stored");
    }
    for (const consumer of required) {
      if (generation.projectorStatuses[consumer] !== "ready") {
        throw new Error(`Required projector ${consumer} is not ready`);
      }
    }
    for (const consumer of contextProjectionConsumers) {
      if (generation.projectorVersions[consumer] === undefined) {
        throw new Error(`Missing projector version for ${consumer}`);
      }
    }
    if (
      generation.repositoryAccessFingerprint !==
      (await this.repositoryAccessFingerprint(generation.tenantId, generation.repository))
    ) {
      throw new Error(`Repository access changed while indexing ${generation.repository}; retry with a new generation`);
    }
    if (
      generation.projectionInputFingerprint !==
      (await this.projectionInputFingerprint(generation.tenantId, generation.repository))
    ) {
      throw new Error(
        `Canonical projection inputs changed while indexing ${generation.repository}; retry with a new generation`
      );
    }
    const latestCheckpoint = await this.latestCheckpoint(generation.tenantId, generation.repository, generation.ref);
    if (latestCheckpoint?.id !== generation.checkpointId) {
      throw new Error(
        `Checkpoint ${generation.checkpointId} is superseded for ${generation.repository}@${generation.ref}`
      );
    }
    const existing = this.#projections.get(generation.id);
    if (existing !== undefined) {
      if (existing.generation.fingerprint !== generation.fingerprint) {
        throw new Error("Generation identity collision");
      }
      return copy(existing.generation);
    }
    this.#projections.set(generation.id, copy(projection));
    this.#latestGenerations.set(scopeKey(generation.tenantId, generation.repository, generation.ref), generation.id);
    return copy(generation);
  }

  async getGeneration(generationId: string): Promise<GenerationProjection | undefined> {
    const value = this.#projections.get(generationId);
    return value === undefined ? undefined : copy(value);
  }

  async getScopedGeneration(
    tenantId: string,
    repositories: readonly string[],
    generationId: string
  ): Promise<GenerationProjection | undefined> {
    const projection = await this.getGeneration(generationId);
    return projection?.generation.tenantId === tenantId && repositories.includes(projection.generation.repository)
      ? projection
      : undefined;
  }

  async getAuthorizedGeneration(generationId: string, principalId: string): Promise<GenerationProjection | undefined> {
    const projection = await this.getGeneration(generationId);
    if (!projection) return undefined;
    const allowedAclFingerprints = new Set(
      await this.aclFingerprintsForPrincipal(
        projection.generation.tenantId,
        principalId,
        projection.generation.repository
      )
    );
    if (allowedAclFingerprints.size === 0) return undefined;
    const documents = projection.documents.filter((document) => {
      const required = Array.isArray(document.metadata.requiredAclFingerprints)
        ? document.metadata.requiredAclFingerprints.filter((value): value is string => typeof value === "string")
        : [document.effectiveAclFingerprint];
      return required.every((value) => allowedAclFingerprints.has(value));
    });
    const documentIds = new Set(documents.map((document) => document.id));
    const allowedAnchorIds = new Set(
      documents.flatMap((document) =>
        document.anchors.map((anchor) => `${anchor.sourceType}\u0000${anchor.sourceId}\u0000${anchor.contentDigest}`)
      )
    );
    return {
      ...projection,
      manifest: projection.manifest.filter((entry) =>
        documents.some((document) => document.metadata.path === entry.path)
      ),
      currentKnowledge: projection.currentKnowledge.filter((selection) =>
        documents.some((document) => document.sourceRevisionId === selection.revisionId)
      ),
      documents,
      fragments: projection.fragments.filter((fragment) => documentIds.has(fragment.documentId)),
      exactIndex: projection.exactIndex.filter((entry) => documentIds.has(entry.documentId)),
      hierarchyNodes: projection.hierarchyNodes.filter((node) => documentIds.has(node.documentId)),
      structuralRelations: projection.structuralRelations.filter((relation) =>
        relation.anchors.every((anchor) =>
          allowedAnchorIds.has(`${anchor.sourceType}\u0000${anchor.sourceId}\u0000${anchor.contentDigest}`)
        )
      )
    };
  }

  async latestPublished(tenantId: string, repository: string, ref: string): Promise<GenerationProjection | undefined> {
    const id = this.#latestGenerations.get(scopeKey(tenantId, repository, ref));
    return id === undefined ? undefined : this.getGeneration(id);
  }

  async listGenerations(tenantId: string, repository: string): Promise<IndexGeneration[]> {
    const currentIds = new Set(
      [...this.#latestGenerations.entries()]
        .filter(([key]) => key.startsWith(`${tenantId}\u0000${repository}\u0000`))
        .map(([, id]) => id)
    );
    return [...this.#projections.values()]
      .map((projection) => projection.generation)
      .filter((generation) => generation.tenantId === tenantId && generation.repository === repository)
      .sort(
        (left, right) =>
          Number(currentIds.has(right.id)) - Number(currentIds.has(left.id)) ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id)
      )
      .map(copy);
  }

  async replaceRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    this.#assertOpen();
    this.#setRepositoryAccess(tenantId, principalId, repositories);
  }

  async mergeRepositoryAccess(tenantId: string, principalId: string, repositories: string[]): Promise<void> {
    this.#assertOpen();
    const principalKey = `${tenantId}\u0000${principalId}`;
    this.#setRepositoryAccess(tenantId, principalId, [
      ...(this.#repositoryAccess.get(principalKey) ?? new Set<string>()),
      ...repositories
    ]);
  }

  #setRepositoryAccess(tenantId: string, principalId: string, repositories: Iterable<string>): void {
    const principalKey = `${tenantId}\u0000${principalId}`;
    const previous = this.#repositoryAccess.get(principalKey) ?? new Set<string>();
    const next = new Set([...repositories].map((repository) => repository.trim().toLowerCase()).filter(Boolean));
    for (const repository of new Set([...previous, ...next])) {
      if (previous.has(repository) === next.has(repository)) continue;
      const repositoryKey = `${tenantId}\u0000${repository}`;
      this.#repositoryAccessVersions.set(repositoryKey, (this.#repositoryAccessVersions.get(repositoryKey) ?? 0) + 1);
    }
    this.#repositoryAccess.set(principalKey, next);
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<string[]> {
    return [...(this.#repositoryAccess.get(`${tenantId}\u0000${principalId}`) ?? new Set())].sort();
  }

  async aclFingerprintsForPrincipal(tenantId: string, principalId: string, repository: string): Promise<string[]> {
    const repositories = this.#repositoryAccess.get(`${tenantId}\u0000${principalId}`) ?? new Set();
    return repositories.has(repository.toLowerCase()) ? [repositoryAclFingerprint(tenantId, repository)] : [];
  }

  async repositoryAccessFingerprint(tenantId: string, repository: string): Promise<string> {
    const entries: { principalId: string; aclFingerprint: string }[] = [];
    for (const [key, repositories] of this.#repositoryAccess) {
      const separator = key.indexOf("\u0000");
      if (key.slice(0, separator) !== tenantId || !repositories.has(repository.toLowerCase())) continue;
      entries.push({
        principalId: key.slice(separator + 1),
        aclFingerprint: repositoryAclFingerprint(tenantId, repository)
      });
    }
    return fingerprint({
      version: this.#repositoryAccessVersions.get(`${tenantId}\u0000${repository.toLowerCase()}`) ?? 0,
      entries: entries.sort((left, right) => left.principalId.localeCompare(right.principalId))
    });
  }

  async projectionInputFingerprint(tenantId: string, repository: string): Promise<string> {
    const frontier = this.#projectionInputFrontiers.get(`${tenantId}\u0000${repository.toLowerCase()}`);
    return fingerprint({
      tenantId,
      repository,
      sequence: frontier?.sequence ?? 0,
      eventId: frontier?.eventId ?? null
    });
  }

  async listRepositories(tenantId: string): Promise<string[]> {
    const repositories = new Set<string>();
    for (const checkpoint of this.#checkpoints.values()) {
      if (checkpoint.tenantId === tenantId) repositories.add(checkpoint.repository);
    }
    return [...repositories].sort();
  }

  async projectionBacklog(_tenantId: string, _repository?: string): Promise<ProjectionBacklog> {
    return Object.fromEntries(
      contextProjectionConsumers.map((consumer) => [consumer, { count: 0 }])
    ) as ProjectionBacklog;
  }

  async pendingProjectionCheckpoints(_tenantId: string, _limit: number): Promise<string[]> {
    return [];
  }

  async recordQueryRun(run: QueryRunTelemetry): Promise<void> {
    this.#assertOpen();
    if (!this.#queryRuns.some((candidate) => candidate.id === run.id)) this.#queryRuns.push(copy(run));
  }

  async queryMetrics(tenantId: string): Promise<QueryMetrics> {
    const runs = this.#queryRuns.filter((run) => run.tenantId === tenantId);
    const durations = runs.map((run) => run.durationMs).sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
    return {
      count: runs.length,
      p95Ms: durations[index] ?? 0,
      citationFailureCount: runs.reduce((sum, run) => sum + run.citationFailureCount, 0),
      conflictCount: runs.reduce((sum, run) => sum + run.conflictCount, 0)
    };
  }

  /**
   * Mirrors the Postgres policy rather than the table: a revoked or expired token
   * is invisible here too, so a test cannot pass against memory and fail against
   * a real database.
   */
  async verifyApiToken(secretHash: string, expectedTenantId?: string): Promise<VerifiedApiToken | undefined> {
    this.#assertOpen();
    const now = Date.now();
    for (const token of this.#apiTokens.values()) {
      if (token.secretHash !== secretHash) continue;
      if (expectedTenantId !== undefined && token.tenantId !== expectedTenantId) return undefined;
      if (token.revokedAt) return undefined;
      if (Date.parse(token.expiresAt) <= now) return undefined;
      return {
        tokenId: token.id,
        tenantId: token.tenantId,
        principalId: token.principalId,
        scopes: [...token.scopes],
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {})
      };
    }
    return undefined;
  }

  async stampApiTokenUse(tenantId: string, tokenId: string, usedAt: string): Promise<void> {
    const token = this.#apiTokens.get(tokenId);
    if (!token || token.tenantId !== tenantId) return;
    this.#apiTokens.set(tokenId, { ...token, lastUsedAt: usedAt });
  }

  async mintApiToken(token: MintApiTokenInput): Promise<ApiTokenRecord> {
    this.#assertOpen();
    if (this.#apiTokens.has(token.id)) throw new Error(`Duplicate API token id ${token.id}`);
    for (const existing of this.#apiTokens.values()) {
      if (existing.secretHash === token.secretHash) throw new Error("Duplicate API token secret");
    }
    const stored = {
      id: token.id,
      tenantId: token.tenantId,
      principalId: token.principalId,
      name: token.name,
      scopes: [...token.scopes],
      createdAt: token.createdAt,
      createdBy: token.createdBy,
      expiresAt: token.expiresAt,
      secretHash: token.secretHash
    };
    this.#apiTokens.set(token.id, stored);
    return publicApiToken(stored);
  }

  async listApiTokens(tenantId: string): Promise<ApiTokenRecord[]> {
    return [...this.#apiTokens.values()]
      .filter((token) => token.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map(publicApiToken);
  }

  async revokeApiToken(
    tenantId: string,
    tokenId: string,
    revokedBy: string,
    revokedAt: string
  ): Promise<ApiTokenRecord | undefined> {
    const token = this.#apiTokens.get(tokenId);
    if (!token || token.tenantId !== tenantId) return undefined;
    // A second revocation keeps the first revoker rather than overwriting it.
    if (token.revokedAt) return publicApiToken(token);
    const revoked = { ...token, revokedAt, revokedBy };
    this.#apiTokens.set(tokenId, revoked);
    return publicApiToken(revoked);
  }

  // Keyed by stage so a rerun of the same build starts from its own progress
  // rather than inheriting the last attempt's.
  readonly #derivationProgress = new Map<
    string,
    Map<
      string,
      DerivationProgressPage & {
        at: string;
        first: string;
        resumable?: DerivationProgressPage;
      }
    >
  >();
  readonly #derivationOrchestration = new Map<
    string,
    {
      state: ContextOrchestrationState;
      digest: string;
      checkpointSequence: number;
      at: string;
    }
  >();
  readonly #derivationPrivateCheckpoints = new Map<
    string,
    {
      artifact: import("../ports/artifact-store.js").ContextArtifactRef;
      plaintextDigest: string;
      bytes: number;
      checkpointSequence: number;
      at: string;
    }
  >();

  async recordDerivationProgress(input: {
    tenantId: string;
    buildId: string;
    stageId: string;
    checkpointId: string;
    pages: readonly DerivationProgressPage[];
    orchestration?: ContextOrchestrationState;
    at: string;
  }): Promise<void> {
    const key = `${input.tenantId}\u0000${input.stageId}`;
    const existing =
      this.#derivationProgress.get(key) ??
      new Map<
        string,
        DerivationProgressPage & {
          at: string;
          first: string;
          resumable?: DerivationProgressPage;
        }
      >();
    for (const page of input.pages) {
      const documentPath = derivationProgressDocumentPath(page.documentPath);
      const prior = existing.get(documentPath);
      const checkpointSequence =
        prior !== undefined && prior.contentDigest === page.contentDigest
          ? (prior.checkpointSequence ?? 1)
          : (prior?.checkpointSequence ?? 0) + 1;
      const current: DerivationProgressPage & {
        at: string;
        first: string;
        resumable?: DerivationProgressPage;
      } = {
        ...page,
        documentPath,
        at: input.at,
        first: prior?.first ?? input.at,
        checkpointSequence
      };
      if (page.validationStatus !== "invalid") {
        current.resumable = {
          documentPath,
          title: page.title,
          bodyMarkdown: page.bodyMarkdown,
          ...(page.contentDigest === undefined ? {} : { contentDigest: page.contentDigest }),
          validationStatus: page.validationStatus ?? "pending",
          diagnostics: page.diagnostics ?? [],
          checkpointSequence
        };
      } else if (prior?.resumable) {
        current.resumable = prior.resumable;
      }
      existing.set(documentPath, current);
    }
    this.#derivationProgress.set(key, existing);
    this.#progressBuilds.set(key, input.buildId);
    if (input.orchestration) {
      const digest = fingerprint(input.orchestration);
      const prior = this.#derivationOrchestration.get(key);
      this.#derivationOrchestration.set(key, {
        state: copy(input.orchestration),
        digest,
        checkpointSequence: prior?.digest === digest ? prior.checkpointSequence : (prior?.checkpointSequence ?? 0) + 1,
        at: input.at
      });
    }
  }

  readonly #progressBuilds = new Map<string, string>();

  async derivationProgress(tenantId: string, buildId: string): Promise<DerivationProgressSnapshot> {
    const pages = [...this.#derivationProgress.entries()]
      .filter(([key]) => key.startsWith(`${tenantId}\u0000`) && this.#progressBuilds.get(key) === buildId)
      .flatMap(([, byPath]) => [...byPath.values()])
      .sort(
        (left, right) => left.first.localeCompare(right.first) || left.documentPath.localeCompare(right.documentPath)
      );
    const orchestration = [...this.#derivationOrchestration.entries()].find(
      ([key]) => key.startsWith(`${tenantId}\u0000`) && this.#progressBuilds.get(key) === buildId
    )?.[1];
    const latest = pages.reduce<string | undefined>(
      (newest, page) => (newest === undefined || page.at > newest ? page.at : newest),
      orchestration?.at
    );
    return {
      buildId,
      pages: pages.map((page) => ({
        documentPath: page.documentPath,
        title: page.title,
        bytes: Buffer.byteLength(page.bodyMarkdown, "utf8"),
        ...(page.contentDigest === undefined ? {} : { contentDigest: page.contentDigest }),
        validationStatus: page.validationStatus ?? "pending",
        diagnostics: page.diagnostics ?? [],
        checkpointSequence: page.checkpointSequence ?? 1,
        firstSeenAt: page.first,
        updatedAt: page.at
      })),
      ...(orchestration
        ? {
            orchestration: {
              state: copy(orchestration.state),
              contentDigest: orchestration.digest,
              checkpointSequence: orchestration.checkpointSequence,
              updatedAt: orchestration.at
            }
          }
        : {}),
      ...(latest === undefined ? {} : { updatedAt: latest })
    };
  }

  async derivationProgressPage(
    tenantId: string,
    buildId: string,
    documentPath: string
  ): Promise<DerivationProgressPage | undefined> {
    for (const [key, byPath] of this.#derivationProgress.entries()) {
      if (!key.startsWith(`${tenantId}\u0000`) || this.#progressBuilds.get(key) !== buildId) continue;
      const page = byPath.get(documentPath);
      if (page) {
        return {
          documentPath: page.documentPath,
          title: page.title,
          bodyMarkdown: page.bodyMarkdown,
          ...(page.contentDigest === undefined ? {} : { contentDigest: page.contentDigest }),
          validationStatus: page.validationStatus ?? "pending",
          diagnostics: page.diagnostics ?? [],
          checkpointSequence: page.checkpointSequence ?? 1
        };
      }
    }
    return undefined;
  }

  async derivationProgressPages(tenantId: string, stageId: string): Promise<DerivationProgressPage[]> {
    const byPath = this.#derivationProgress.get(`${tenantId}\u0000${stageId}`);
    return [...(byPath?.values() ?? [])].flatMap((page) => (page.resumable ? [copy(page.resumable)] : []));
  }

  async derivationOrchestration(tenantId: string, stageId: string): Promise<ContextOrchestrationState | undefined> {
    const value = this.#derivationOrchestration.get(`${tenantId}\u0000${stageId}`);
    return value ? copy(value.state) : undefined;
  }

  async recordDerivationPrivateCheckpoint(input: {
    tenantId: string;
    buildId: string;
    stageId: string;
    checkpointId: string;
    artifact: import("../ports/artifact-store.js").ContextArtifactRef;
    plaintextDigest: string;
    bytes: number;
    at: string;
  }): Promise<void> {
    const key = `${input.tenantId}\u0000${input.stageId}`;
    const prior = this.#derivationPrivateCheckpoints.get(key);
    this.#derivationPrivateCheckpoints.set(key, {
      artifact: copy(input.artifact),
      plaintextDigest: input.plaintextDigest,
      bytes: input.bytes,
      checkpointSequence:
        prior?.plaintextDigest === input.plaintextDigest
          ? prior.checkpointSequence
          : (prior?.checkpointSequence ?? 0) + 1,
      at: input.at
    });
  }

  async derivationPrivateCheckpoint(
    tenantId: string,
    stageId: string
  ): Promise<import("../derive/progress.js").DerivationPrivateCheckpoint | undefined> {
    const value = this.#derivationPrivateCheckpoints.get(`${tenantId}\u0000${stageId}`);
    return value
      ? {
          artifact: copy(value.artifact),
          plaintextDigest: value.plaintextDigest,
          bytes: value.bytes,
          checkpointSequence: value.checkpointSequence,
          updatedAt: value.at
        }
      : undefined;
  }

  async clearDerivationProgress(tenantId: string, stageId: string): Promise<void> {
    this.#derivationProgress.delete(`${tenantId}\u0000${stageId}`);
    this.#derivationOrchestration.delete(`${tenantId}\u0000${stageId}`);
    this.#derivationPrivateCheckpoints.delete(`${tenantId}\u0000${stageId}`);
    this.#progressBuilds.delete(`${tenantId}\u0000${stageId}`);
  }

  async eraseEvidence(input: EraseEvidenceInput): Promise<{ erasedGenerationCount: number }> {
    this.#assertOpen();
    if (!input.sourceId.trim() || !input.reason.trim() || !input.actorId.trim()) {
      throw new Error("Evidence erasure requires sourceId, actorId, and reason");
    }
    const erasureKey = `${input.tenantId}\u0000${input.repository}\u0000${input.sourceType}\u0000${input.sourceId}`;
    const isNew = !this.#erasures.has(erasureKey);
    this.#erasures.add(erasureKey);
    if (isNew) {
      const erasureId = stableId("erasure", {
        tenantId: input.tenantId,
        repository: input.repository,
        sourceType: input.sourceType,
        sourceId: input.sourceId
      });
      this.#advanceProjectionInput(input.tenantId, input.repository, `projection-input:erasure:${erasureId}`);
    }
    let erasedGenerationCount = 0;
    for (const [id, projection] of [...this.#projections]) {
      if (projection.generation.tenantId === input.tenantId && projection.generation.repository === input.repository) {
        this.#projections.delete(id);
        erasedGenerationCount += 1;
      }
    }
    for (const [key, id] of [...this.#latestGenerations]) {
      if (!this.#projections.has(id)) this.#latestGenerations.delete(key);
    }
    return { erasedGenerationCount };
  }

  async migrateTenantAliases(fromTenantId: string, toTenantId: string): Promise<void> {
    this.#assertOpen();
    if (fromTenantId === toTenantId) return;
    const accessEntries = [...this.#repositoryAccess.entries()].filter(([key]) =>
      key.startsWith(`${fromTenantId}\u0000`)
    );
    for (const [key, repositories] of accessEntries) {
      const principalId = key.slice(fromTenantId.length + 1);
      const targetKey = `${toTenantId}\u0000${principalId}`;
      this.#repositoryAccess.set(
        targetKey,
        new Set([...(this.#repositoryAccess.get(targetKey) ?? []), ...repositories])
      );
      this.#repositoryAccess.delete(key);
    }
  }

  async health(): Promise<{ ok: boolean; adapter: string }> {
    return { ok: !this.#closed, adapter: "memory" };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #isErased(anchor: EvidenceAnchor): boolean {
    return this.#erasures.has(
      `${anchor.tenantId}\u0000${anchor.repository}\u0000${anchor.sourceType}\u0000${anchor.sourceId}`
    );
  }

  #isRevisionErased(revisionId: string): boolean {
    return (this.#citations.get(revisionId) ?? []).some((citation) => this.#isErased(citation.anchor));
  }

  #advanceProjectionInput(tenantId: string, repository: string, eventId: string): void {
    const key = `${tenantId}\u0000${repository.toLowerCase()}`;
    const current = this.#projectionInputFrontiers.get(key);
    this.#projectionInputFrontiers.set(key, {
      sequence: (current?.sequence ?? 0) + 1,
      eventId
    });
  }
}

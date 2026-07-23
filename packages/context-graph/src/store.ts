import {
  createContextGraph,
  stableId,
  summarizeContextGraph,
  type ContextGraphEdge,
  type ContextGraph,
  type ContextGraphSummary,
  type ContextGraphNode,
  type ContextGraphSourceEvidence
} from "./model.js";
import type {
  ContextGraphAssertionSummary,
  ContextGraphCommand,
  ContextGraphCommandResult,
  RepositoryContextOperations
} from "./operations.js";
import type { ContextGraphOperationalMetrics, ProjectionRebuildResult } from "./outbox.js";
import { canonicalJson } from "./knowledge.js";
import {
  codeownersPatternMatches,
  normalizeSourceObservation,
  sourceObservationExternalId,
  sourceObservationProvider,
  type GitHubSourceObservation,
  type GitHubWorkItemObservation,
  type RepositorySourceObservation
} from "./normalizers.js";
import {
  CONTEXT_GRAPH_REGISTRY_VERSION,
  predicateDefinition,
  validatePredicateEndpoints,
  validateQualifiers
} from "./registry.js";
import type { IssueTraceProjection, RetrievalRequest, RetrievalResult } from "./retrieval.js";
import { causalTraceItemsFromGraph } from "./causal.js";
import {
  CONTEXT_GRAPH_PARSER_VERSION,
  CONTEXT_GRAPH_PROJECTION_VERSION,
  assertionObservationId,
  computeCommitChanges,
  entityKey,
  knowledgeCheckpoint,
  normalizeAssertionBatchLenient,
  sourceObservationId,
  type BlobAnalysis,
  type ContextGraphAssertionBatch,
  type ContextGraphAssertionResult,
  type ContextGraphIngestPlan,
  type ContextGraphPipelineStore,
  type ContextGraphProjectionRequest,
  type ContextGraphSourceIngestResult,
  type ContextGraphWriteFence,
  type RepositorySnapshot,
  type StoredAssertion
} from "./pipeline.js";
import { DomainError } from "@jina/shared-kernel";

/**
 * Optional repository/ref scope for graph-summary listings. Stores apply it
 * before any result limit, so a scoped caller (e.g. deploy acceptance) sees
 * its repository's graphs even when the tenant holds more heads than one
 * unscoped page returns.
 */
export interface ContextGraphSummaryFilter {
  readonly repository?: string;
  readonly ref?: string;
}

export interface ContextGraphReadRevisionOptions extends ContextGraphSummaryFilter {
  readonly repositories?: readonly string[];
  readonly assertionRepository?: string;
  readonly assertionStatus?: StoredAssertion["status"];
  readonly includeAssertions?: boolean;
}

export interface ContextGraphStore extends ContextGraphPipelineStore, RepositoryContextOperations {
  save(graph: ContextGraph, writeFence?: ContextGraphWriteFence): Promise<void>;
  latest(
    tenantId: string,
    repositories?: readonly string[],
    filter?: ContextGraphSummaryFilter
  ): Promise<ContextGraph | undefined>;
  readRevision(tenantId: string, options?: ContextGraphReadRevisionOptions): Promise<string>;
  currentGraphHead(
    tenantId: string,
    repository: string,
    ref: string
  ): Promise<{ readonly graphId: string; readonly commitSha: string } | undefined>;
  get(graphId: string, tenantId: string): Promise<ContextGraph | undefined>;
  list(tenantId: string): Promise<readonly ContextGraph[]>;
  listAllSummaries(): Promise<readonly ContextGraphSummary[]>;
  listSummaries(tenantId: string, filter?: ContextGraphSummaryFilter): Promise<readonly ContextGraphSummary[]>;
  replaceRepositoryAccess(tenantId: string, principalId: string, repositories: readonly string[]): Promise<void>;
  migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export class MemoryContextGraphStore implements ContextGraphStore {
  private readonly graphs = new Map<string, ContextGraph>();
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly blobAnalyses = new Map<string, BlobAnalysis>();
  private readonly assertionBatches = new Map<
    string,
    { readonly batch: ContextGraphAssertionBatch; readonly assertions: readonly StoredAssertion[] }
  >();
  private readonly sourceAssertions = new Map<string, StoredAssertion>();
  private readonly humanAssertions = new Map<string, StoredAssertion>();
  private readonly repositoryAcl = new Map<string, Map<string, "reader" | "writer" | "admin">>();
  private readonly repositoryTombstones = new Set<string>();
  private readonly memoryAudit: ContextGraphCommandResult[] = [];
  private readonly assertionRelations: {
    readonly sourceAssertionId: string;
    readonly relation: "supports" | "contradicts";
    readonly targetAssertionId: string;
    readonly evidenceObservationId: string;
  }[] = [];
  private readonly sourceObservations: RepositorySourceObservation[] = [];

  async save(graph: ContextGraph): Promise<void> {
    this.assertRepositoryWritable(graph.tenantId, graph.repository);
    if (!this.graphs.has(graph.id)) this.graphs.set(graph.id, graph);
  }

  async latest(tenantId: string, repositories?: readonly string[], filter: ContextGraphSummaryFilter = {}) {
    return (await this.list(tenantId)).find(
      (graph) =>
        (!repositories || repositories.includes(graph.repository)) &&
        (!filter.repository || graph.repository === filter.repository) &&
        (!filter.ref || graph.ref === filter.ref)
    );
  }

  async readRevision(tenantId: string, options: ContextGraphReadRevisionOptions = {}): Promise<string> {
    const repositories = options.repositories ? new Set(options.repositories) : undefined;
    const graphs = (await this.list(tenantId)).filter(
      (graph) =>
        (!repositories || repositories.has(graph.repository)) &&
        (!options.repository || graph.repository === options.repository) &&
        (!options.ref || graph.ref === options.ref)
    );
    const assertions = options.includeAssertions
      ? this.allAssertions().filter(
          (assertion) =>
            assertion.tenantId === tenantId &&
            (!repositories || repositories.has(assertion.repository)) &&
            (!options.assertionRepository || assertion.repository === options.assertionRepository) &&
            (!options.assertionStatus || assertion.status === options.assertionStatus)
        )
      : [];
    return stableId(
      "context-graph-read",
      canonicalJson({
        graphs: graphs.map((graph) => graph.id),
        assertions: assertions.map((assertion) => [assertion.id, assertion.status, assertion.subject, assertion.object])
      })
    );
  }

  async currentGraphHead(
    tenantId: string,
    repository: string,
    ref: string
  ): Promise<{ readonly graphId: string; readonly commitSha: string } | undefined> {
    const head = (await this.list(tenantId)).find((graph) => graph.repository === repository && graph.ref === ref);
    return head ? { graphId: head.id, commitSha: head.commitSha } : undefined;
  }

  async get(graphId: string, tenantId: string): Promise<ContextGraph | undefined> {
    const graph = this.graphs.get(graphId);
    return graph?.tenantId === tenantId ? graph : undefined;
  }

  async list(tenantId: string): Promise<readonly ContextGraph[]> {
    return [...this.graphs.values()]
      .filter((graph) => graph.tenantId === tenantId)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  async listAllSummaries(): Promise<readonly ContextGraphSummary[]> {
    const heads = new Map<string, ContextGraph>();
    for (const graph of this.graphs.values()) {
      const key = canonicalJson([graph.tenantId, graph.repository, graph.ref]);
      const current = heads.get(key);
      if (!current || graph.generatedAt > current.generatedAt) heads.set(key, graph);
    }
    return [...heads.values()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)).map(summarizeContextGraph);
  }

  async listSummaries(tenantId: string, filter?: ContextGraphSummaryFilter): Promise<readonly ContextGraphSummary[]> {
    return (await this.list(tenantId))
      .filter(
        (graph) =>
          (filter?.repository === undefined || graph.repository === filter.repository) &&
          (filter?.ref === undefined || graph.ref === filter.ref)
      )
      .map(summarizeContextGraph);
  }

  async replaceRepositoryAccess(tenantId: string, principalId: string, repositories: readonly string[]): Promise<void> {
    this.repositoryAcl.set(
      `${tenantId}:${principalId}`,
      new Map(repositories.map((repository) => [repository, "reader"] as const))
    );
  }

  async knownCommits(tenantId: string, repository: string, commitShas: readonly string[]): Promise<readonly string[]> {
    return commitShas.filter((sha) => this.snapshots.has(snapshotKey(tenantId, repository, sha)));
  }

  async planIngestion(snapshot: RepositorySnapshot): Promise<ContextGraphIngestPlan> {
    this.assertRepositoryWritable(snapshot.tenantId, snapshot.repository);
    const parent = snapshot.parents[0]
      ? this.snapshots.get(snapshotKey(snapshot.tenantId, snapshot.repository, snapshot.parents[0]))
      : undefined;
    // Delta snapshots reconstruct the full tree exactly like the PostgreSQL
    // store so both backends record identical manifests.
    let files = snapshot.files;
    if (snapshot.mode === "delta") {
      if (!snapshot.parents[0]) throw new DomainError("delta snapshot requires a recorded first parent", "conflict");
      if (snapshot.files.length > 0) throw new DomainError("delta snapshot must not carry a full tree", "conflict");
      // The live ref head must always arrive as a full tree so retained blobs
      // with missing parser analyses are re-discovered every build.
      if (snapshot.updateRef !== false) {
        throw new DomainError("delta snapshot cannot move the live ref; head commits require a full tree", "conflict");
      }
      if (!parent) throw new DomainError("delta snapshot parent tree is not recorded", "conflict");
      const tree = new Map(parent.files.map((file) => [file.path, file]));
      for (const delta of snapshot.deltas ?? []) {
        if (delta.blobSha === null) tree.delete(delta.path);
        else tree.set(delta.path, { path: delta.path, blobSha: delta.blobSha, size: delta.size });
      }
      files = [...tree.values()];
    }
    const key = snapshotKey(snapshot.tenantId, snapshot.repository, snapshot.commitSha);
    const { mode: _mode, deltas: _deltas, ...snapshotWithoutDelta } = snapshot;
    if (!this.snapshots.has(key)) this.snapshots.set(key, structuredClone({ ...snapshotWithoutDelta, files }));
    const blobSource =
      snapshot.mode === "delta"
        ? files.filter((file) =>
            (snapshot.deltas ?? []).some((delta) => delta.path === file.path && delta.blobSha !== null)
          )
        : files;
    const firstPathByBlob = new Map<string, { readonly path: string; readonly size: number }>();
    for (const file of blobSource) {
      if (!firstPathByBlob.has(file.blobSha)) firstPathByBlob.set(file.blobSha, { path: file.path, size: file.size });
    }
    const missingBlobs = [...firstPathByBlob].flatMap(([blobSha, file]) =>
      this.blobAnalyses.has(blobKey(snapshot.tenantId, blobSha, CONTEXT_GRAPH_PARSER_VERSION))
        ? []
        : [{ blobSha, ...file }]
    );
    const changes = computeCommitChanges(files, parent?.files);
    const changedPaths = changes.filter((change) => change.change !== "delete").map((change) => change.path);
    const discoveredBlobCount = new Set(files.map((file) => file.blobSha)).size;
    return {
      observationId: sourceObservationId(snapshot),
      commitSha: snapshot.commitSha,
      fileCount: files.length,
      discoveredBlobCount,
      reusedBlobCount: discoveredBlobCount - missingBlobs.length,
      changedPaths,
      changes,
      missingBlobs
    };
  }

  async applyBlobAnalyses(
    scope: Pick<RepositorySnapshot, "tenantId" | "repository" | "commitSha">,
    analyses: readonly BlobAnalysis[]
  ): Promise<void> {
    this.assertRepositoryWritable(scope.tenantId, scope.repository);
    const snapshot = this.snapshots.get(snapshotKey(scope.tenantId, scope.repository, scope.commitSha));
    if (!snapshot) throw new Error("repository snapshot must be recorded before blob analysis");
    const known = new Set(snapshot.files.map((file) => file.blobSha));
    for (const analysis of analyses) {
      if (!known.has(analysis.blobSha)) throw new Error(`blob ${analysis.blobSha} is not in the recorded snapshot`);
      const key = blobKey(scope.tenantId, analysis.blobSha, analysis.parserVersion);
      if (!this.blobAnalyses.has(key)) this.blobAnalyses.set(key, structuredClone(analysis));
    }
  }

  async applyGitHubObservations(
    observations: readonly RepositorySourceObservation[]
  ): Promise<ContextGraphSourceIngestResult> {
    for (const observation of observations) this.assertRepositoryWritable(observation.tenantId, observation.repository);
    let newObservationCount = 0;
    let updatedObservationCount = 0;
    let confirmedObservationCount = 0;
    for (const observation of observations) {
      const observationId = sourceObservationIdForRepository(observation);
      const existingIndex = this.sourceObservations.findIndex(
        (candidate) => sourceObservationIdForRepository(candidate) === observationId
      );
      if (existingIndex >= 0) {
        confirmedObservationCount += 1;
        continue;
      }
      const hasPriorVersion = this.sourceObservations.some(
        (candidate) => sourceObservationVersionKey(candidate) === sourceObservationVersionKey(observation)
      );
      if (hasPriorVersion) updatedObservationCount += 1;
      else newObservationCount += 1;
      this.sourceObservations.push(structuredClone(observation));
    }
    this.rebuildSourceAssertions();
    return {
      observationCount: observations.length,
      observationIds: [...new Set(observations.map(sourceObservationIdForRepository))],
      assertionCount: observations.reduce(
        (count, observation) => count + normalizeSourceObservation(observation).assertions.length,
        0
      ),
      newObservationCount,
      updatedObservationCount,
      confirmedObservationCount
    };
  }

  async loadAssertionEvidence(
    tenantId: string,
    repository: string,
    observationIds: readonly string[]
  ): Promise<readonly ContextGraphSourceEvidence[]> {
    const requested = new Set(observationIds);
    const evidence = this.sourceObservations.flatMap((observation) => {
      const id = sourceObservationIdForRepository(observation);
      if (!requested.has(id) || observation.tenantId !== tenantId || observation.repository !== repository) return [];
      const payload = structuredClone(observation);
      return [
        {
          id,
          source: sourceObservationProvider(observation),
          type: "source_snapshot",
          repository,
          payloadSha: stableId("sha", JSON.stringify(payload)),
          payload
        }
      ];
    });
    if (evidence.length !== requested.size) throw new Error("assertion evidence observation was not found");
    return evidence.sort((left, right) => left.id.localeCompare(right.id));
  }

  async hasAssertionGeneration(
    tenantId: string,
    repository: string,
    commitSha: string,
    generatorVersion: string,
    registryVersion: string,
    evidenceFingerprint: string
  ): Promise<ContextGraphAssertionResult | undefined> {
    const stored = this.assertionBatches.get(
      assertionKey(tenantId, repository, commitSha, generatorVersion, registryVersion, evidenceFingerprint)
    );
    return stored ? assertionResult(stored.batch, stored.assertions, true) : undefined;
  }

  async saveAssertionBatch(batch: ContextGraphAssertionBatch): Promise<ContextGraphAssertionResult> {
    this.assertRepositoryWritable(batch.tenantId, batch.repository);
    const key = assertionKey(
      batch.tenantId,
      batch.repository,
      batch.commitSha,
      batch.generatorVersion,
      batch.registryVersion,
      batch.evidenceFingerprint
    );
    const existing = this.assertionBatches.get(key);
    if (existing) return assertionResult(existing.batch, existing.assertions, true);
    const normalized = normalizeAssertionBatchLenient(batch);
    const prior = new Map(
      this.allAssertions()
        .filter((assertion) => assertion.tenantId === batch.tenantId && assertion.repository === batch.repository)
        .filter((assertion) => assertion.status === "active" || assertion.status === "proposed")
        .map((assertion) => [storedAssertionNaturalKey(assertion), assertion])
    );
    const assertions = normalized.assertions.map((assertion) => {
      const existingAssertion = prior.get(storedAssertionNaturalKey(assertion));
      return existingAssertion ? { ...existingAssertion, lastConfirmedAt: batch.generatedAt } : assertion;
    });
    this.assertionBatches.set(key, { batch: structuredClone(batch), assertions });
    return assertionResult(batch, assertions, false, normalized.warnings);
  }

  async project(request: ContextGraphProjectionRequest): Promise<ContextGraph> {
    this.assertRepositoryWritable(request.tenantId, request.repository);
    const snapshot = this.snapshots.get(snapshotKey(request.tenantId, request.repository, request.commitSha));
    if (!snapshot) throw new Error("cannot project an contextGraph before repository ingestion");
    const assertions = dedupeApplicableAssertions(
      this.allAssertions()
        .filter((assertion) => assertion.tenantId === request.tenantId && assertion.repository === request.repository)
        .filter((assertion) => assertion.status === "active" || assertion.status === "proposed")
        .filter((assertion) => {
          if (assertion.commitSha === "source") return true;
          // Audited human commands carry no code evidence to go stale; the
          // Postgres projection includes them, so the memory store must too.
          // Only accepted ones: projected edges carry no status, so a proposed
          // command assertion would read as reviewed fact in causal traces.
          if (assertion.commitSha === "command")
            return assertion.status === "active" && assertion.evidence.length === 0 && Boolean(assertion.assertedBy);
          const source = this.snapshots.get(snapshotKey(assertion.tenantId, assertion.repository, assertion.commitSha));
          return source ? assertionEvidenceIsCurrent(assertion, source, snapshot) : false;
        })
    );
    const graph = createContextGraphProjection(snapshot, this.blobAnalyses, assertions, request);
    await this.save(graph);
    return graph;
  }

  async migrateTenantAliases(tenantId: string, aliases: readonly string[]): Promise<void> {
    for (const [id, graph] of this.graphs) {
      if (aliases.includes(graph.tenantId)) this.graphs.set(id, { ...graph, tenantId });
    }
  }

  async close(): Promise<void> {
    // The in-memory store owns no external resources.
  }

  async executeCommand(
    tenantId: string,
    actorId: string,
    command: ContextGraphCommand,
    now: string,
    actorIsTenantAdmin = false
  ): Promise<ContextGraphCommandResult> {
    if (!actorId.startsWith("svc:") && !actorIsTenantAdmin) {
      const repository = "repository" in command ? command.repository : undefined;
      const role = repository ? this.repositoryAcl.get(`${tenantId}:${actorId}`)?.get(repository) : undefined;
      const requiresAdmin = command.type === "grant_repository_access" || command.type === "tombstone_repository";
      if (!role || role === "reader" || (requiresAdmin && role !== "admin")) {
        throw new DomainError("contextGraph command access denied", "forbidden");
      }
    }
    const affectedIds: string[] = [];
    if (command.type === "review_assertion") {
      if (command.decision === "reject" && (!command.reason || !command.rejectionCode)) {
        throw new Error("assertion rejection requires a reason and rejection code");
      }
      let found = false;
      const human = this.humanAssertions.get(command.assertionId);
      if (human?.tenantId === tenantId) {
        const allowed =
          command.decision === "accept"
            ? human.status === "proposed"
            : command.decision === "reject"
              ? human.status === "proposed"
              : human.status === "active";
        if (!allowed) throw new DomainError(`cannot ${command.decision} assertion in ${human.status}`, "conflict");
        const status: StoredAssertion["status"] =
          command.decision === "accept" ? "active" : command.decision === "reject" ? "rejected" : "retracted";
        this.humanAssertions.set(human.id, { ...human, status, ...(status === "retracted" ? { validTo: now } : {}) });
        affectedIds.push(human.id);
        found = true;
      }
      for (const [key, stored] of this.assertionBatches) {
        const current = stored.assertions.find(
          (assertion) => assertion.tenantId === tenantId && assertion.id === command.assertionId
        );
        if (!current) continue;
        const allowed =
          command.decision === "accept"
            ? current.status === "proposed"
            : command.decision === "reject"
              ? current.status === "proposed"
              : current.status === "active";
        if (!allowed) throw new DomainError(`cannot ${command.decision} assertion in ${current.status}`, "conflict");
        const status: StoredAssertion["status"] =
          command.decision === "accept" ? "active" : command.decision === "reject" ? "rejected" : "retracted";
        const assertions = stored.assertions.map((assertion) =>
          assertion.id === current.id
            ? { ...assertion, status, ...(status === "retracted" ? { validTo: now } : {}) }
            : assertion
        );
        this.assertionBatches.set(key, { ...stored, assertions });
        affectedIds.push(current.id);
        found = true;
      }
      if (!found) throw new DomainError("assertion not found", "not_found");
    } else if (command.type === "relate_assertions") {
      const assertions = this.allAssertions();
      const source = assertions.find(
        (assertion) => assertion.tenantId === tenantId && assertion.id === command.sourceAssertionId
      );
      const target = assertions.find(
        (assertion) => assertion.tenantId === tenantId && assertion.id === command.targetAssertionId
      );
      if (!source || !target) throw new DomainError("assertion relation endpoint not found", "not_found");
      if (source.id === target.id || source.repository !== target.repository) {
        throw new DomainError("assertion relation endpoints are invalid", "conflict");
      }
      if (
        !this.sourceObservations.some(
          (observation) =>
            observation.repository === source.repository &&
            sourceObservationIdForRepository(observation) === command.evidenceObservationId
        )
      ) {
        throw new DomainError("assertion relation evidence observation was not found", "not_found");
      }
      if (
        !this.assertionRelations.some(
          (relation) =>
            relation.sourceAssertionId === source.id &&
            relation.relation === command.relation &&
            relation.targetAssertionId === target.id &&
            relation.evidenceObservationId === command.evidenceObservationId
        )
      ) {
        this.assertionRelations.push({
          sourceAssertionId: source.id,
          relation: command.relation,
          targetAssertionId: target.id,
          evidenceObservationId: command.evidenceObservationId
        });
      }
      affectedIds.push(source.id, target.id);
    } else if (command.type === "grant_repository_access") {
      this.assertRepositoryWritable(tenantId, command.repository);
      const key = `${tenantId}:${command.principalId}`;
      const repositories = this.repositoryAcl.get(key) ?? new Map<string, "reader" | "writer" | "admin">();
      repositories.set(command.repository, command.role);
      this.repositoryAcl.set(key, repositories);
      affectedIds.push(command.repository);
    } else if (command.type === "tombstone_repository") {
      this.repositoryTombstones.add(repositoryKey(tenantId, command.repository));
      for (const [key, snapshot] of this.snapshots)
        if (snapshot.tenantId === tenantId && snapshot.repository === command.repository) this.snapshots.delete(key);
      for (const [key, graph] of this.graphs)
        if (graph.tenantId === tenantId && graph.repository === command.repository) this.graphs.delete(key);
      for (const [key, stored] of this.assertionBatches)
        if (stored.batch.tenantId === tenantId && stored.batch.repository === command.repository)
          this.assertionBatches.delete(key);
      for (const [key, assertion] of this.humanAssertions) {
        if (assertion.tenantId === tenantId && assertion.repository === command.repository)
          this.humanAssertions.delete(key);
      }
      for (let index = this.sourceObservations.length - 1; index >= 0; index -= 1) {
        const observation = this.sourceObservations[index];
        if (observation?.tenantId === tenantId && observation.repository === command.repository)
          this.sourceObservations.splice(index, 1);
      }
      for (const repositories of this.repositoryAcl.values()) repositories.delete(command.repository);
      this.rebuildSourceAssertions();
      affectedIds.push(command.repository);
    } else if (command.type === "redact_observation") {
      const index = this.sourceObservations.findIndex(
        (observation) =>
          observation.tenantId === tenantId && sourceObservationIdForRepository(observation) === command.observationId
      );
      if (index < 0) throw new DomainError("observation not found or already redacted", "not_found");
      this.sourceObservations.splice(index, 1);
      this.rebuildSourceAssertions();
      for (const [key, stored] of this.assertionBatches) {
        this.assertionBatches.set(key, {
          ...stored,
          assertions: stored.assertions.map((assertion) =>
            assertion.tenantId === tenantId &&
            assertion.sourceObservationId === command.observationId &&
            (assertion.status === "active" || assertion.status === "proposed")
              ? { ...assertion, status: "retracted", validTo: now }
              : assertion
          )
        });
      }
      for (let index = this.assertionRelations.length - 1; index >= 0; index -= 1) {
        if (this.assertionRelations[index]?.evidenceObservationId === command.observationId)
          this.assertionRelations.splice(index, 1);
      }
      affectedIds.push(command.observationId);
    } else if (
      command.type === "erase_person" ||
      command.type === "merge_entities" ||
      command.type === "unmerge_entities"
    ) {
      throw new DomainError(`${command.type} requires the relational contextGraph store`, "conflict");
    } else if (command.type === "assign_relationship") {
      if (command.repository) this.assertRepositoryWritable(tenantId, command.repository);
      const definition = predicateDefinition(command.predicate);
      if (definition.review === "none") {
        throw new DomainError(
          "explicit-source predicates must enter through intake, not an internal assignment",
          "conflict"
        );
      }
      validatePredicateEndpoints(definition, command.subject.kind, command.object.kind);
      validateQualifiers(definition, command.qualifiers);
      const id = stableId(
        "assertion",
        `${tenantId}:${command.repository ?? ""}:${command.subject.key}:${definition.name}:${command.object.key}:${canonicalJson(command.qualifiers ?? {})}:${now}`
      );
      this.humanAssertions.set(id, {
        id,
        tenantId,
        repository: command.repository ?? "",
        commitSha: "command",
        subject: {
          kind: command.subject.kind,
          naturalKey: command.subject.key,
          label: command.subject.displayName ?? command.subject.key
        },
        predicate: definition.name,
        object: {
          kind: command.object.kind,
          naturalKey: command.object.key,
          label: command.object.displayName ?? command.object.key
        },
        confidence: 1,
        evidence: [],
        assertedBy: actorId,
        qualifiers: command.qualifiers ?? {},
        status: "proposed",
        lastConfirmedAt: now,
        generatorVersion: "human-command-v1",
        registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
        recordedAt: now
      });
      affectedIds.push(id);
    }
    const result = {
      auditId: stableId("audit", `${tenantId}:${actorId}:${command.type}:${now}:${JSON.stringify(command)}`),
      action: command.type,
      affectedIds,
      outboxEventIds: affectedIds.map((id) => stableId("outbox", `${tenantId}:${command.type}:${id}:${now}`))
    };
    this.memoryAudit.push(result);
    return result;
  }

  async rebuildDerivedProjections(
    tenantId: string,
    repository: string,
    ref: string,
    now: string
  ): Promise<ProjectionRebuildResult> {
    this.assertRepositoryWritable(tenantId, repository);
    const snapshot = [...this.snapshots.values()]
      .filter(
        (value) =>
          value.tenantId === tenantId &&
          value.repository === repository &&
          value.ref === ref &&
          value.updateRef !== false
      )
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    return {
      manifestFileCount: snapshot?.files.length ?? 0,
      searchDocumentCount: snapshot ? 1 : 0,
      reconciledAssertionCount: 0,
      rebuilt: true,
      processedEventCount: 0,
      projectedAt: now
    };
  }

  async drainDerivedProjectionEvents(): Promise<{
    readonly processedEventCount: number;
    readonly rebuiltRepositories: readonly string[];
  }> {
    return { processedEventCount: 0, rebuiltRepositories: [] };
  }

  async operationalMetrics(
    tenantId: string,
    _now?: string,
    scope?: {
      readonly repository?: string;
      readonly repositories?: readonly string[];
      readonly ref?: string;
    }
  ): Promise<ContextGraphOperationalMetrics> {
    const repositories = scope?.repositories
      ? new Set(scope.repositories)
      : scope?.repository
        ? new Set([scope.repository])
        : undefined;
    const scopedSnapshots = [...this.snapshots.values()].filter(
      (snapshot) =>
        snapshot.tenantId === tenantId &&
        (!repositories || repositories.has(snapshot.repository)) &&
        (!scope?.ref || snapshot.ref === scope.ref)
    );
    return {
      outboxDepth: {},
      outboxDepthByConsumer: {},
      oldestOutboxAgeSeconds: 0,
      reconciliationLagSeconds: 0,
      unparsedBlobCount: new Set(
        scopedSnapshots
          .flatMap((snapshot) => snapshot.files)
          .filter((file) => !this.blobAnalyses.has(blobKey(tenantId, file.blobSha, CONTEXT_GRAPH_PARSER_VERSION)))
          .map((file) => file.blobSha)
      ).size,
      parsedBlobCountLastHour: 0,
      manifestStalenessSeconds: 0,
      searchStalenessSeconds: 0,
      proposedAssertionCount: this.allAssertions().filter(
        (assertion) =>
          assertion.tenantId === tenantId &&
          (!repositories || repositories.has(assertion.repository)) &&
          assertion.status === "proposed"
      ).length,
      unexplainedAssertionCount: this.allAssertions().filter(
        (assertion) =>
          assertion.tenantId === tenantId &&
          (!repositories || repositories.has(assertion.repository)) &&
          !assertion.explanation
      ).length,
      pendingErasureEventCount: 0,
      retrievalTemplates: [],
      acceptanceRates: []
    };
  }

  async repositoriesForPrincipal(tenantId: string, principalId: string): Promise<readonly string[]> {
    if (principalId.startsWith("svc:")) {
      return [
        ...new Set([
          ...[...this.snapshots.values()]
            .filter((snapshot) => snapshot.tenantId === tenantId)
            .map((snapshot) => snapshot.repository),
          ...[...this.graphs.values()].filter((graph) => graph.tenantId === tenantId).map((graph) => graph.repository)
        ])
      ].sort();
    }
    return [...(this.repositoryAcl.get(`${tenantId}:${principalId}`)?.keys() ?? [])].sort();
  }

  async listAssertions(
    tenantId: string,
    repository: string,
    filter: {
      readonly status?: StoredAssertion["status"];
      readonly predicate?: string;
      readonly entityKind?: ContextGraphNode["kind"];
      readonly limit?: number;
    } = {}
  ): Promise<readonly ContextGraphAssertionSummary[]> {
    return this.allAssertions()
      .filter((assertion) => assertion.tenantId === tenantId && assertion.repository === repository)
      .filter((assertion) => !filter.status || assertion.status === filter.status)
      .filter((assertion) => !filter.predicate || assertion.predicate === filter.predicate)
      .filter(
        (assertion) =>
          !filter.entityKind ||
          assertion.subject.kind === filter.entityKind ||
          assertion.object.kind === filter.entityKind
      )
      .slice(0, Math.max(1, Math.min(filter.limit ?? 500, 500)))
      .map((assertion) => ({
        id: assertion.id,
        repository: assertion.repository,
        commitSha: assertion.commitSha,
        subjectKind: assertion.subject.kind,
        subjectNaturalKey: assertion.subject.naturalKey,
        subjectLabel: assertion.subject.label,
        predicate: assertion.predicate,
        objectKind: assertion.object.kind,
        objectNaturalKey: assertion.object.naturalKey,
        objectLabel: assertion.object.label,
        status: assertion.status,
        ...(assertion.confidence !== undefined ? { confidence: assertion.confidence } : {}),
        ...(assertion.explanation ? { explanation: assertion.explanation } : {}),
        evidence:
          assertion.evidence.length > 0
            ? assertion.evidence
            : assertion.sourceObservationId
              ? [`observation:${assertion.sourceObservationId}`]
              : [],
        qualifiers: assertion.qualifiers ?? {},
        generator:
          assertion.commitSha === "source"
            ? `source:${assertion.generatorVersion.replace(/-normalizer-v1$/, "")}`
            : assertion.commitSha === "command"
              ? `human:${assertion.assertedBy ?? "unknown"}`
              : `model:${assertion.generatorVersion}`,
        registryVersion: assertion.registryVersion,
        supportingAssertionIds: this.assertionRelations
          .filter((relation) => relation.relation === "supports" && relation.targetAssertionId === assertion.id)
          .map((relation) => relation.sourceAssertionId),
        contradictingAssertionIds: this.assertionRelations
          .filter((relation) => relation.relation === "contradicts" && relation.targetAssertionId === assertion.id)
          .map((relation) => relation.sourceAssertionId)
      }));
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    if (!request.allowedRepositories.includes(request.repository)) {
      throw new DomainError("repository access denied", "forbidden");
    }
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const snapshot = [...this.snapshots.values()]
      .filter(
        (value) =>
          value.tenantId === request.tenantId &&
          value.repository === request.repository &&
          value.updateRef !== false &&
          (!request.ref || value.ref === request.ref)
      )
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const currentGraph = snapshot
      ? [...this.graphs.values()].find(
          (graph) =>
            graph.tenantId === request.tenantId &&
            graph.repository === request.repository &&
            graph.ref === snapshot.ref &&
            graph.commitSha === snapshot.commitSha
        )
      : undefined;
    const currentAssertions =
      snapshot && currentGraph
        ? this.allAssertions().filter((assertion) => assertionIsCurrentForSnapshot(assertion, snapshot, this.snapshots))
        : [];
    const items =
      request.template === "causal_trace" || request.template === "counterfactual"
        ? currentGraph
          ? causalTraceItemsFromGraph(currentGraph, request)
          : []
        : request.template === "issue_trace"
          ? memoryIssueTraceItems(
              request,
              this.sourceObservations.filter(
                (observation): observation is GitHubSourceObservation =>
                  observation.kind === "pull_request" ||
                  observation.kind === "issue" ||
                  observation.kind === "codeowners"
              ),
              this.snapshots,
              currentAssertions,
              [...this.assertionBatches.values()].map((stored) => stored.batch)
            )
          : request.template === "feature_trace"
            ? memoryFeatureTraceItems(request, currentAssertions)
            : memoryRetrievalItems(request, snapshot, this.blobAnalyses, this.allAssertions());
    return {
      template: request.template,
      repository: request.repository,
      ref: request.ref ?? snapshot?.ref ?? "main",
      items: items.slice(0, limit),
      truncated: items.length > limit,
      totalBeforeLimit: items.length,
      limit
    };
  }

  private allAssertions(): StoredAssertion[] {
    const assertions = [
      ...this.sourceAssertions.values(),
      ...this.humanAssertions.values(),
      ...[...this.assertionBatches.values()].flatMap((stored) => stored.assertions)
    ];
    const byId = new Map<string, StoredAssertion>();
    for (const assertion of assertions) {
      const current = byId.get(assertion.id);
      if (!current || current.lastConfirmedAt < assertion.lastConfirmedAt) byId.set(assertion.id, assertion);
    }
    return [...byId.values()];
  }

  private rebuildSourceAssertions(): void {
    this.sourceAssertions.clear();
    for (const observation of latestMemorySourceObservations(this.sourceObservations)) {
      const normalized = normalizeSourceObservation(observation);
      const observationId = sourceObservationIdForRepository(observation);
      for (const intent of normalized.assertions) {
        const subjectId = stableId("entity", `${observation.tenantId}:${intent.subject.kind}:${intent.subject.key}`);
        const objectId = stableId("entity", `${observation.tenantId}:${intent.object.kind}:${intent.object.key}`);
        const qualifiers = intent.qualifiers ?? {};
        const assertionId = stableId(
          "assertion",
          `${observation.tenantId}:${observation.repository}:${subjectId}:${intent.predicate}:${objectId}:${stableId("q", canonicalJson(qualifiers))}:${observationId}`
        );
        this.sourceAssertions.set(assertionId, {
          id: assertionId,
          tenantId: observation.tenantId,
          repository: observation.repository,
          commitSha: "source",
          subject: { kind: intent.subject.kind, naturalKey: intent.subject.key, label: intent.subject.displayName },
          predicate: intent.predicate,
          object: { kind: intent.object.kind, naturalKey: intent.object.key, label: intent.object.displayName },
          status: "active",
          confidence: 1,
          explanation: intent.explanation,
          evidence: [],
          sourceObservationId: observationId,
          qualifiers,
          lastConfirmedAt: observation.recordedAt,
          generatorVersion: `${sourceObservationProvider(observation)}-normalizer-v1`,
          registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
          recordedAt: observation.recordedAt
        });
      }
    }
  }

  private assertRepositoryWritable(tenantId: string, repository: string): void {
    if (this.repositoryTombstones.has(repositoryKey(tenantId, repository))) {
      throw new DomainError("repository is tombstoned", "conflict");
    }
  }
}

function memoryIssueTraceItems(
  request: RetrievalRequest,
  observations: readonly GitHubSourceObservation[],
  snapshots: ReadonlyMap<string, RepositorySnapshot>,
  assertions: readonly StoredAssertion[],
  batches: readonly ContextGraphAssertionBatch[]
): RetrievalResult["items"] {
  const scoped = latestMemorySourceObservations(observations).filter(
    (observation): observation is GitHubWorkItemObservation =>
      observation.tenantId === request.tenantId &&
      observation.repository === request.repository &&
      (observation.kind === "pull_request" || observation.kind === "issue")
  );
  const active = assertions.filter(
    (assertion) =>
      assertion.tenantId === request.tenantId &&
      assertion.repository === request.repository &&
      assertion.status === "active"
  );
  const resolutionAssertions = active.filter(
    (assertion) =>
      assertion.predicate === "RESOLVES" &&
      assertion.subject.kind === "PullRequest" &&
      assertion.object.kind === "Issue"
  );
  const batchesByObservationId = new Map(batches.map((batch) => [assertionObservationId(batch), batch]));
  const candidates = new Map<
    string,
    {
      readonly naturalKey: string;
      readonly label: string;
      readonly description?: string;
      readonly observation?: GitHubWorkItemObservation;
    }
  >();
  for (const observation of scoped) {
    if (observation.kind !== "issue") continue;
    const naturalKey = `github:issue:${request.repository}#${observation.number}`;
    candidates.set(naturalKey, { naturalKey, label: observation.title, observation });
  }
  for (const assertion of [...resolutionAssertions, ...active.filter((item) => item.predicate === "INTRODUCED_BY")]) {
    const issue = assertion.predicate === "RESOLVES" ? assertion.object : assertion.subject;
    if (issue.kind !== "Issue" || candidates.has(issue.naturalKey)) continue;
    const batch = assertion.sourceObservationId ? batchesByObservationId.get(assertion.sourceObservationId) : undefined;
    const description = batch ? derivedIssueDescriptionFromBatch(batch, issue.naturalKey) : undefined;
    candidates.set(issue.naturalKey, {
      naturalKey: issue.naturalKey,
      label: issue.label,
      ...(description ? { description } : {})
    });
  }
  const issueText = request.issueText?.trim().toLowerCase();
  const commitPrefix = request.commitSha?.toLowerCase();
  const selectedCandidates = [...candidates.values()].filter((candidate) => {
    const entityId = stableId("entity", `${request.tenantId}:Issue:${candidate.naturalKey}`);
    const number = /^github:issue:.*#(\d+)$/.exec(candidate.naturalKey)?.[1];
    if (request.issueEntityId) return entityId === request.issueEntityId;
    if (request.issueNumber) return Number.parseInt(number ?? "", 10) === request.issueNumber;
    if (issueText) {
      return (
        candidate.label.toLowerCase().includes(issueText) ||
        candidate.description?.toLowerCase().includes(issueText) === true ||
        candidate.observation?.body?.toLowerCase().includes(issueText) === true
      );
    }
    if (request.pullRequestNumber) {
      return resolutionAssertions.some(
        (assertion) =>
          assertion.object.naturalKey === candidate.naturalKey &&
          numberFromEntityNaturalKey(assertion.subject.naturalKey) === request.pullRequestNumber
      );
    }
    if (commitPrefix) {
      const caused = active.some(
        (assertion) =>
          assertion.predicate === "INTRODUCED_BY" &&
          assertion.subject.naturalKey === candidate.naturalKey &&
          shaFromEntityNaturalKey(assertion.object.naturalKey)?.startsWith(commitPrefix)
      );
      const resolved = resolutionAssertions.some(
        (resolution) =>
          resolution.object.naturalKey === candidate.naturalKey &&
          active.some(
            (inclusion) =>
              (inclusion.predicate === "INCLUDES" || inclusion.predicate === "MERGED_AS") &&
              inclusion.subject.naturalKey === resolution.subject.naturalKey &&
              shaFromEntityNaturalKey(inclusion.object.naturalKey)?.startsWith(commitPrefix)
          )
      );
      return caused || resolved;
    }
    return false;
  });
  if (!selectedCandidates.length) return [];
  return selectedCandidates.map((selected) => {
    const issueNumberText = /^github:issue:.*#(\d+)$/.exec(selected.naturalKey)?.[1];
    const issueNumber = issueNumberText ? Number.parseInt(issueNumberText, 10) : undefined;
    const issueEntityId = stableId("entity", `${request.tenantId}:Issue:${selected.naturalKey}`);
    const citations: IssueTraceProjection["citations"][number][] = [
      { kind: "entity", id: issueEntityId, repository: request.repository }
    ];
    if (selected.observation)
      citations.push({
        kind: "observation",
        id: sourceGitHubObservationId(selected.observation),
        repository: request.repository
      });
    const resolutions = resolutionAssertions
      .filter((assertion) => assertion.object.naturalKey === selected.naturalKey)
      .flatMap((resolution) => {
        const pullRequestNumber = numberFromEntityNaturalKey(resolution.subject.naturalKey);
        if (!pullRequestNumber) return [];
        const pullRequest = scoped.find(
          (observation) => observation.kind === "pull_request" && observation.number === pullRequestNumber
        );
        citations.push({ kind: "assertion", id: resolution.id, repository: request.repository });
        if (resolution.sourceObservationId)
          citations.push({ kind: "observation", id: resolution.sourceObservationId, repository: request.repository });
        if (pullRequest)
          citations.push({
            kind: "observation",
            id: sourceGitHubObservationId(pullRequest),
            repository: request.repository
          });
        const inclusions = active.filter(
          (assertion) =>
            (assertion.predicate === "INCLUDES" || assertion.predicate === "MERGED_AS") &&
            assertion.subject.naturalKey === resolution.subject.naturalKey
        );
        const shas = new Map<string, "merge" | "included">();
        for (const inclusion of inclusions) {
          const sha = shaFromEntityNaturalKey(inclusion.object.naturalKey);
          if (!sha) continue;
          shas.set(sha, inclusion.predicate === "MERGED_AS" ? "merge" : (shas.get(sha) ?? "included"));
          citations.push({ kind: "assertion", id: inclusion.id, repository: request.repository });
        }
        const commits = [...shas].map((sha) => {
          const [commitSha, role] = sha;
          const snapshot = snapshots.get(snapshotKey(request.tenantId, request.repository, commitSha));
          const parent = snapshot?.parents[0]
            ? snapshots.get(snapshotKey(request.tenantId, request.repository, snapshot.parents[0]))
            : undefined;
          const changes = snapshot
            ? computeCommitChanges(snapshot.files, parent?.files).map((change) => ({
                commitSha,
                path: change.path,
                change: change.change,
                ...(change.oldPath ? { oldPath: change.oldPath } : {})
              }))
            : [];
          for (const change of changes)
            citations.push({
              kind: "commit_change",
              id: `${commitSha}:${change.path}`,
              repository: request.repository,
              commitSha,
              path: change.path
            });
          return {
            sha: commitSha,
            url: `https://github.com/${request.repository}/commit/${commitSha}`,
            role,
            ...(snapshot?.committedAt ? { committedAt: snapshot.committedAt } : {}),
            changes
          };
        });
        return [
          {
            pullRequestNumber,
            title: pullRequest?.title ?? resolution.subject.label,
            url: pullRequest?.url ?? `https://github.com/${request.repository}/pull/${pullRequestNumber}`,
            commits,
            assertionIds: [resolution.id, ...inclusions.map((assertion) => assertion.id)],
            observationIds: [
              ...new Set(
                [
                  resolution.sourceObservationId,
                  pullRequest ? sourceGitHubObservationId(pullRequest) : undefined
                ].filter((id): id is string => Boolean(id))
              )
            ]
          }
        ];
      });
    const introducedBy = active
      .filter(
        (assertion) => assertion.predicate === "INTRODUCED_BY" && assertion.subject.naturalKey === selected.naturalKey
      )
      .flatMap((assertion) => {
        const sha = shaFromEntityNaturalKey(assertion.object.naturalKey);
        if (!sha) return [];
        citations.push({
          kind: "assertion",
          id: assertion.id,
          repository: request.repository,
          commitSha: assertion.commitSha
        });
        const pullRequestAssertions = assertions.filter(
          (candidate) =>
            candidate.tenantId === request.tenantId &&
            candidate.repository === request.repository &&
            candidate.status === "active" &&
            candidate.predicate === "INCLUDES" &&
            candidate.object.naturalKey === assertion.object.naturalKey
        );
        const pullRequestsForCause = pullRequestAssertions.flatMap((candidate) => {
          const number = /#(\d+)$/.exec(candidate.subject.naturalKey)?.[1];
          if (!number) return [];
          citations.push({ kind: "assertion", id: candidate.id, repository: request.repository });
          const observed = scoped.find(
            (item) => item.kind === "pull_request" && item.number === Number.parseInt(number, 10)
          );
          return [
            {
              number: Number.parseInt(number, 10),
              title: observed?.title ?? candidate.subject.label,
              url: observed?.url ?? `https://github.com/${request.repository}/pull/${number}`
            }
          ];
        });
        const snapshot = snapshots.get(snapshotKey(request.tenantId, request.repository, sha));
        const parent = snapshot?.parents[0]
          ? snapshots.get(snapshotKey(request.tenantId, request.repository, snapshot.parents[0]))
          : undefined;
        const changes = snapshot
          ? computeCommitChanges(snapshot.files, parent?.files).map((change) => ({
              commitSha: sha,
              path: change.path,
              change: change.change,
              ...(change.oldPath ? { oldPath: change.oldPath } : {})
            }))
          : [];
        const reason =
          assertion.explanation ??
          (typeof assertion.qualifiers?.reason === "string" ? assertion.qualifiers.reason : undefined);
        return [
          {
            sha,
            url: `https://github.com/${request.repository}/commit/${sha}`,
            role: "introduced" as const,
            ...(snapshot?.committedAt ? { committedAt: snapshot.committedAt } : {}),
            changes,
            ...(reason ? { why: reason } : {}),
            evidence: assertion.evidence,
            evidenceCommitSha: assertion.commitSha,
            assertionIds: [assertion.id],
            pullRequests: pullRequestsForCause
          }
        ];
      });
    const payload: IssueTraceProjection = {
      issue: {
        entityId: issueEntityId,
        origin: issueNumber ? "github" : "derived",
        displayId: issueNumber ? `#${issueNumber}` : "virtual",
        ...(issueNumber ? { number: issueNumber } : {}),
        title: selected.observation?.title ?? selected.label,
        ...(selected.description ? { description: selected.description } : {}),
        ...(selected.observation?.url ? { url: selected.observation.url } : {}),
        ...(selected.observation?.state ? { state: selected.observation.state } : {})
      },
      resolutions,
      introducedBy,
      citations
    };
    const first = resolutions[0];
    const issueLabel = payload.issue.displayId ? `Issue ${payload.issue.displayId}` : payload.issue.title;
    return {
      kind: "issue_trace",
      title: first
        ? `${issueLabel} → PR #${first.pullRequestNumber}${first.commits[0] ? ` → ${first.commits[0].sha.slice(0, 12)}` : ""}`
        : `${issueLabel} has no verified commit relationship`,
      data: payload as unknown as Readonly<Record<string, unknown>>,
      citations,
      score: first ? 3 : 1
    };
  });
}

function numberFromEntityNaturalKey(naturalKey: string): number | undefined {
  const value = /#(\d+)$/.exec(naturalKey)?.[1];
  return value ? Number.parseInt(value, 10) : undefined;
}

function derivedIssueDescriptionFromBatch(
  batch: ContextGraphAssertionBatch,
  issueNaturalKey: string
): string | undefined {
  const resolution = batch.assertions.find(
    (assertion) => assertion.predicate === "RESOLVES" && assertion.object.naturalKey === issueNaturalKey
  );
  const pullRequestNumber = resolution ? numberFromEntityNaturalKey(resolution.subject.naturalKey) : undefined;
  if (!pullRequestNumber) return undefined;
  return batch.rawOutput.nodes.find((node) => node.kind === "Issue" && node.id === `derived:pr:${pullRequestNumber}`)
    ?.description;
}

function shaFromEntityNaturalKey(naturalKey: string): string | undefined {
  return /:sha:([a-f0-9]{40})$/i.exec(naturalKey)?.[1]?.toLowerCase();
}

function memoryFeatureTraceItems(
  request: RetrievalRequest,
  assertions: readonly StoredAssertion[]
): RetrievalResult["items"] {
  const query = request.featureText?.trim().toLowerCase() ?? "";
  if (!query) return [];
  return assertions
    .filter((assertion) => {
      if (
        assertion.tenantId !== request.tenantId ||
        assertion.repository !== request.repository ||
        assertion.status !== "active" ||
        !["IMPLEMENTS", "DOCUMENTED_BY", "LIKELY_AFFECTS", "REFERENCES"].includes(assertion.predicate)
      )
        return false;
      const feature =
        assertion.subject.kind === "Feature"
          ? assertion.subject
          : assertion.object.kind === "Feature"
            ? assertion.object
            : undefined;
      return Boolean(
        feature && (feature.label.toLowerCase().includes(query) || feature.naturalKey.toLowerCase().includes(query))
      );
    })
    .map((assertion) => featureRelationshipItem(assertion));
}

function featureRelationshipItem(assertion: StoredAssertion): RetrievalResult["items"][number] {
  const featureIsSubject = assertion.subject.kind === "Feature";
  const feature = featureIsSubject ? assertion.subject : assertion.object;
  const related = featureIsSubject ? assertion.object : assertion.subject;
  const title =
    assertion.predicate === "IMPLEMENTS"
      ? `${related.label} implements ${feature.label}`
      : assertion.predicate === "DOCUMENTED_BY"
        ? `${feature.label} is documented by ${related.label}`
        : assertion.predicate === "LIKELY_AFFECTS"
          ? `${related.label} may affect ${feature.label}`
          : `${related.label} references ${feature.label}`;
  const citations: RetrievalResult["items"][number]["citations"][number][] = [
    {
      kind: "assertion",
      id: assertion.id,
      repository: assertion.repository,
      ...(/^[a-f0-9]{40}$/i.test(assertion.commitSha) ? { commitSha: assertion.commitSha } : {})
    }
  ];
  if (assertion.sourceObservationId)
    citations.push({
      kind: "observation",
      id: assertion.sourceObservationId,
      repository: assertion.repository
    });
  if (/^[a-f0-9]{40}$/i.test(assertion.commitSha)) {
    for (const value of assertion.evidence) {
      const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(value);
      if (!match?.[1] || !match[2]) continue;
      citations.push({
        kind: "code",
        id: `${assertion.commitSha}:${value}`,
        repository: assertion.repository,
        commitSha: assertion.commitSha,
        path: match[1],
        startLine: Number.parseInt(match[2], 10),
        endLine: Number.parseInt(match[3] ?? match[2], 10)
      });
    }
  }
  return {
    kind: "feature_relationship",
    title,
    data: {
      feature: { kind: feature.kind, naturalKey: feature.naturalKey, label: feature.label },
      related: { kind: related.kind, naturalKey: related.naturalKey, label: related.label },
      predicate: assertion.predicate
    },
    citations,
    score: assertion.confidence
  };
}

function latestMemorySourceObservations(
  observations: readonly RepositorySourceObservation[]
): RepositorySourceObservation[] {
  const latest = new Map<string, RepositorySourceObservation>();
  for (const observation of observations) {
    const key = sourceObservationVersionKey(observation);
    const current = latest.get(key);
    const version =
      "occurredAt" in observation ? (observation.occurredAt ?? observation.recordedAt) : observation.recordedAt;
    const currentVersion = current
      ? "occurredAt" in current
        ? (current.occurredAt ?? current.recordedAt)
        : current.recordedAt
      : undefined;
    if (
      !current ||
      !currentVersion ||
      version > currentVersion ||
      (version === currentVersion && observation.recordedAt > current.recordedAt)
    ) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()];
}

function sourceObservationVersionKey(observation: RepositorySourceObservation): string {
  if ("number" in observation) {
    return `${observation.tenantId}:${observation.repository}:${observation.kind}:${observation.number}`;
  }
  if (observation.kind === "codeowners") return `${observation.tenantId}:${observation.repository}:codeowners`;
  if (observation.kind === "package_manifest")
    return `${observation.tenantId}:${observation.repository}:${observation.kind}:${observation.path}`;
  if (observation.kind === "move_candidate")
    return `${observation.tenantId}:${observation.repository}:${observation.kind}:${observation.commitSha}`;
  if (
    observation.kind === "service_definition" ||
    observation.kind === "deployment" ||
    observation.kind === "incident"
  ) {
    return `${observation.tenantId}:${observation.repository}:${observation.kind}:${observation.source}:${observation.externalId}`;
  }
  throw new Error(`unsupported source observation: ${String((observation as { kind?: unknown }).kind)}`);
}

function sourceObservationIdForRepository(observation: RepositorySourceObservation): string {
  return stableId(
    "observation",
    `${observation.tenantId}:${sourceObservationProvider(observation)}:${sourceObservationExternalId(observation)}`
  );
}

function sourceGitHubObservationId(observation: GitHubWorkItemObservation): string {
  return sourceObservationIdForRepository(observation);
}

function memoryRetrievalItems(
  request: RetrievalRequest,
  snapshot: RepositorySnapshot | undefined,
  analyses: ReadonlyMap<string, BlobAnalysis>,
  assertions: readonly StoredAssertion[]
): RetrievalResult["items"] {
  if (request.template === "structure") {
    if (!snapshot) return [];
    return snapshot.files
      .filter((file) => !request.path || file.path === request.path)
      .flatMap((file) => {
        const analysis = analyses.get(blobKey(snapshot.tenantId, file.blobSha, CONTEXT_GRAPH_PARSER_VERSION));
        const definitions = (analysis?.symbols ?? [])
          .filter(
            (symbol) =>
              !request.symbol ||
              symbol.name.toLowerCase() === request.symbol.toLowerCase() ||
              symbol.moniker.toLowerCase().includes(request.symbol.toLowerCase())
          )
          .map((symbol) => ({
            kind: "symbol_definition",
            title: `${symbol.name} is ${symbol.kind} in ${file.path}`,
            data: { moniker: symbol.moniker, name: symbol.name, symbolKind: symbol.kind, path: file.path },
            score: 2,
            citations: [
              {
                kind: "code" as const,
                id: `${file.blobSha}:${symbol.startLine}:${symbol.moniker}`,
                repository: request.repository,
                commitSha: snapshot.commitSha,
                path: file.path,
                startLine: symbol.startLine,
                endLine: symbol.endLine
              }
            ]
          }));
        const relationships = (analysis?.edges ?? [])
          .filter(
            (edge) =>
              !request.symbol || edge.fromMoniker.includes(request.symbol) || edge.toMoniker.includes(request.symbol)
          )
          .map((edge) => ({
            kind: edge.kind,
            title: `${edge.fromMoniker} ${edge.kind} ${edge.toMoniker}`,
            data: { fromMoniker: edge.fromMoniker, toMoniker: edge.toMoniker, path: file.path },
            score: 1,
            citations: [
              {
                kind: "code" as const,
                id: `${file.blobSha}:${edge.startLine}`,
                repository: request.repository,
                commitSha: snapshot.commitSha,
                path: file.path,
                startLine: edge.startLine,
                endLine: edge.endLine
              }
            ]
          }));
        return [...definitions, ...relationships];
      });
  }
  if (request.template === "change") {
    if (!snapshot) return [];
    return computeCommitChanges(snapshot.files, []).map((change) => ({
      kind: "commit_change",
      title: `${change.change} ${change.path}`,
      data: { ...change },
      score: 1,
      citations: [
        {
          kind: "commit_change" as const,
          id: `${snapshot.commitSha}:${change.path}`,
          repository: request.repository,
          commitSha: snapshot.commitSha,
          path: change.path
        }
      ]
    }));
  }
  if (request.template === "ownership") {
    const target = request.path ?? request.symbol;
    return assertions
      .filter(
        (assertion) =>
          assertion.tenantId === request.tenantId &&
          assertion.repository === request.repository &&
          assertion.predicate === "OWNED_BY" &&
          assertion.status === "active" &&
          (!target ||
            assertion.subject.naturalKey.includes(target) ||
            (typeof assertion.qualifiers?.pattern === "string" &&
              codeownersPatternMatches(assertion.qualifiers.pattern, target)))
      )
      .map((assertion) => ({
        kind: "ownership",
        title: `${assertion.subject.label} owned by ${assertion.object.label}`,
        data: { subject: assertion.subject, object: assertion.object, qualifiers: assertion.qualifiers ?? {} },
        score: 1,
        citations: [
          {
            kind: "assertion" as const,
            id: assertion.id,
            repository: request.repository,
            commitSha: assertion.commitSha
          }
        ]
      }));
  }
  return assertions
    .filter(
      (assertion) =>
        assertion.tenantId === request.tenantId &&
        assertion.repository === request.repository &&
        assertion.status === "active"
    )
    .map((assertion) => ({
      kind: "intent",
      title: `${assertion.subject.label} ${assertion.predicate} ${assertion.object.label}`,
      data: { predicate: assertion.predicate },
      score: assertion.confidence,
      citations: [
        { kind: "assertion" as const, id: assertion.id, repository: request.repository, commitSha: assertion.commitSha }
      ]
    }));
}

export function createContextGraphProjection(
  snapshot: RepositorySnapshot,
  analyses: ReadonlyMap<string, BlobAnalysis>,
  assertions: readonly StoredAssertion[],
  request: ContextGraphProjectionRequest
): ContextGraph {
  const files = [...snapshot.files]
    .sort((a, b) => filePriority(a.path) - filePriority(b.path) || a.path.localeCompare(b.path))
    .slice(0, 80);
  if (files.length === 0) throw new Error("cannot project an empty repository snapshot");
  const fallbackEvidence = `${files[0]!.path}:1`;
  const nodes = new Map<string, ContextGraphNode>();
  const edges: Omit<ContextGraphEdge, "id">[] = [];
  const symbolByScopedName = new Map<string, string>();
  const symbolsByName = new Map<string, string[]>();
  nodes.set("repo", {
    id: "repo",
    kind: "Repository",
    label: snapshot.repository,
    description: `Repository at ${snapshot.commitSha.slice(0, 12)}`,
    evidence: [fallbackEvidence]
  });
  for (const file of files) {
    const fileId = `file:${file.path}`;
    nodes.set(fileId, {
      id: fileId,
      kind: isDocument(file.path) ? "Document" : "File",
      label: file.path.split("/").at(-1) ?? file.path,
      description: file.path,
      path: file.path,
      evidence: [`${file.path}:1`]
    });
    edges.push({ source: "repo", target: fileId, predicate: "CONTAINS", plane: "code", evidence: [`${file.path}:1`] });
    const analysis = analyses.get(blobKey(snapshot.tenantId, file.blobSha, CONTEXT_GRAPH_PARSER_VERSION));
    for (const symbol of analysis?.symbols.slice(0, 8) ?? []) {
      if (nodes.size >= 200) break;
      const symbolId = `symbol:${file.path}:${symbol.moniker}`;
      nodes.set(symbolId, {
        id: symbolId,
        kind: "Symbol",
        label: symbol.name,
        description: `${symbol.kind} in ${file.path}`,
        path: file.path,
        evidence: [`${file.path}:${symbol.startLine}-${symbol.endLine}`]
      });
      symbolByScopedName.set(`${file.path}:${symbol.name}`, symbolId);
      symbolsByName.set(symbol.name, [...(symbolsByName.get(symbol.name) ?? []), symbolId]);
      edges.push({
        source: fileId,
        target: symbolId,
        predicate: "DECLARES",
        plane: "code",
        evidence: [`${file.path}:${symbol.startLine}`]
      });
    }
  }
  const projectedPaths = new Set(files.map((file) => file.path));
  const packageBySpecifier = new Map<string, string>();
  for (const assertion of assertions) {
    if (assertion.object.kind !== "Package") continue;
    const packageId = projectionEntityId(assertion.object);
    ensureAssertionNode(nodes, packageId, assertion.object, projectionEvidence(assertion));
    const naturalName = assertion.object.naturalKey.split(":").slice(2).join(":").toLowerCase();
    packageBySpecifier.set(naturalName, packageId);
    packageBySpecifier.set(assertion.object.label.toLowerCase(), packageId);
  }
  for (const file of files) {
    const analysis = analyses.get(blobKey(snapshot.tenantId, file.blobSha, CONTEXT_GRAPH_PARSER_VERSION));
    for (const item of analysis?.imports ?? []) {
      const targetPath = resolveImportPath(file.path, item.specifier, projectedPaths);
      if (targetPath) {
        edges.push({
          source: `file:${file.path}`,
          target: `file:${targetPath}`,
          predicate: "IMPORTS",
          plane: "code",
          evidence: [`${file.path}:${item.line}`]
        });
      } else {
        const packageId = packageBySpecifier.get(packageSpecifier(item.specifier));
        if (packageId)
          edges.push({
            source: `file:${file.path}`,
            target: packageId,
            predicate: "IMPORTS",
            plane: "code",
            evidence: [`${file.path}:${item.line}`]
          });
      }
    }
    for (const item of analysis?.edges ?? []) {
      if (item.kind === "imports") continue;
      const fromName = item.fromMoniker.split(/[.#]/).filter(Boolean).at(-1) ?? item.fromMoniker;
      const targetName = item.toMoniker.split(/[.(#]/).filter(Boolean).at(-1) ?? item.toMoniker;
      const sourceId = item.fromMoniker.includes("<module>")
        ? `file:${file.path}`
        : (symbolByScopedName.get(`${file.path}:${fromName}`) ??
          symbolsByName.get(fromName)?.[0] ??
          `file:${file.path}`);
      let targetId = symbolByScopedName.get(`${file.path}:${targetName}`) ?? symbolsByName.get(targetName)?.[0];
      if (!targetId && nodes.size < 200) {
        targetId = `external:${stableId("moniker", item.toMoniker)}`;
        nodes.set(targetId, {
          id: targetId,
          kind: "Symbol",
          label: item.toMoniker,
          description: "Unresolved external or cross-file moniker",
          evidence: [`${file.path}:${item.startLine}-${item.endLine}`]
        });
      }
      if (!targetId) continue;
      edges.push({
        source: sourceId,
        target: targetId,
        predicate: item.kind.toUpperCase(),
        plane: "code",
        evidence: [`${file.path}:${item.startLine}-${item.endLine}`]
      });
    }
  }
  for (const assertion of assertions) {
    const evidence = projectionEvidence(assertion);
    const source = projectionEntityId(assertion.subject);
    const target = projectionEntityId(assertion.object);
    ensureAssertionNode(nodes, source, assertion.subject, evidence);
    ensureAssertionNode(nodes, target, assertion.object, evidence);
    const qualifiers = {
      ...(assertion.qualifiers ?? {}),
      assertionStatus: assertion.status
    };
    edges.push({
      source,
      target,
      predicate: assertion.predicate,
      plane: "knowledge",
      confidence: assertion.confidence,
      qualifiers,
      ...(assertion.explanation
        ? { why: assertion.explanation }
        : assertion.predicate === "INTRODUCED_BY" && typeof assertion.qualifiers?.reason === "string"
          ? { why: assertion.qualifiers.reason }
          : {}),
      evidence
    });
  }
  return createContextGraph({
    request: {
      tenantId: request.tenantId,
      repository: request.repository,
      ref: request.ref,
      commitSha: request.commitSha,
      taskId: request.taskId
    },
    commitSha: request.commitSha,
    generatedAt: request.generatedAt,
    executor: "projection",
    model: CONTEXT_GRAPH_PROJECTION_VERSION,
    contentAddressed: true,
    generated: {
      summary: `Projected ${files.length} files, ${[...nodes.values()].filter((node) => node.kind === "Symbol").length} symbols, and ${assertions.length} semantic assertions (${assertions.filter((assertion) => assertion.status === "active").length} accepted, ${assertions.filter((assertion) => assertion.status === "proposed").length} proposed) from canonical ContextGraph data.`,
      nodes: [...nodes.values()],
      edges
    }
  });
}

function packageSpecifier(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("@")) return normalized.split("/").slice(0, 2).join("/");
  return normalized.split("/")[0] ?? normalized;
}

function projectionEvidence(assertion: StoredAssertion): readonly string[] {
  const provenance = [
    `assertion:${assertion.id}`,
    ...(assertion.sourceObservationId ? [`observation:${assertion.sourceObservationId}`] : [])
  ];
  if (assertion.evidence.length > 0) return [...assertion.evidence, ...provenance];
  return provenance;
}

function ensureAssertionNode(
  nodes: Map<string, ContextGraphNode>,
  id: string,
  entity: StoredAssertion["subject"],
  evidence: readonly string[]
): void {
  if (nodes.has(id)) return;
  const path = entity.kind === "File" || entity.kind === "Document" ? entityPath(entity.naturalKey) : undefined;
  nodes.set(id, {
    id,
    kind: entity.kind,
    label: entity.label,
    description: entity.naturalKey,
    ...(path ? { path } : {}),
    evidence
  });
}

function projectionEntityId(entity: StoredAssertion["subject"]): string {
  if (entity.kind === "Repository") return "repo";
  if (entity.kind === "File" || entity.kind === "Document") return `file:${entityPath(entity.naturalKey)}`;
  return `entity:${stableId("node", entityKey(entity))}`;
}

function entityPath(naturalKey: string): string {
  const marker = ":path:";
  const index = naturalKey.indexOf(marker);
  return index >= 0 ? naturalKey.slice(index + marker.length) : naturalKey;
}

function assertionResult(
  batch: ContextGraphAssertionBatch,
  assertions: readonly StoredAssertion[],
  cached: boolean,
  warnings: readonly string[] = []
): ContextGraphAssertionResult {
  return {
    observationId: assertionObservationId(batch),
    assertionCount: assertions.length,
    activeCount: assertions.filter((assertion) => assertion.status === "active").length,
    proposedCount: assertions.filter((assertion) => assertion.status === "proposed").length,
    knowledgeCheckpoint: knowledgeCheckpoint(
      batch.tenantId,
      batch.repository,
      batch.commitSha,
      batch.generatorVersion,
      batch.registryVersion,
      batch.evidenceFingerprint
    ),
    cached,
    warnings
  };
}

function snapshotKey(tenantId: string, repository: string, commitSha: string): string {
  return `${tenantId}:${repository}:${commitSha}`;
}
function repositoryKey(tenantId: string, repository: string): string {
  return `${tenantId}:${repository}`;
}
function blobKey(tenantId: string, blobSha: string, parserVersion: string): string {
  return `${tenantId}:${blobSha}:${parserVersion}`;
}
function assertionKey(
  tenantId: string,
  repository: string,
  commitSha: string,
  generatorVersion: string,
  registryVersion: string,
  evidenceFingerprint: string
): string {
  return `${tenantId}:${repository}:${commitSha}:${generatorVersion}:${registryVersion}:${evidenceFingerprint}`;
}
function storedAssertionNaturalKey(assertion: StoredAssertion): string {
  return `${assertion.repository}:${entityKey(assertion.subject)}:${assertion.predicate}:${entityKey(assertion.object)}:${canonicalJson(assertion.qualifiers ?? {})}`;
}
function dedupeApplicableAssertions(assertions: readonly StoredAssertion[]): readonly StoredAssertion[] {
  const selected = new Map<string, StoredAssertion>();
  for (const assertion of assertions) {
    const key = `${entityKey(assertion.subject)}:${assertion.predicate}:${entityKey(assertion.object)}:${canonicalJson(assertion.qualifiers ?? {})}`;
    const current = selected.get(key);
    if (!current || current.recordedAt < assertion.recordedAt) selected.set(key, assertion);
  }
  return [...selected.values()];
}
function assertionEvidenceIsCurrent(
  assertion: StoredAssertion,
  source: RepositorySnapshot,
  current: RepositorySnapshot
): boolean {
  const sourceFiles = new Map(source.files.map((file) => [file.path, file.blobSha]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file.blobSha]));
  return assertion.evidence.every((citation) => {
    const path = citation.replace(/:\d+(?:-\d+)?$/, "");
    return sourceFiles.get(path) !== undefined && sourceFiles.get(path) === currentFiles.get(path);
  });
}
function assertionIsCurrentForSnapshot(
  assertion: StoredAssertion,
  current: RepositorySnapshot,
  snapshots: ReadonlyMap<string, RepositorySnapshot>
): boolean {
  if (
    assertion.tenantId !== current.tenantId ||
    assertion.repository !== current.repository ||
    assertion.status !== "active"
  )
    return false;
  if (assertion.commitSha === "source")
    return assertion.evidence.length === 0 && Boolean(assertion.sourceObservationId);
  if (assertion.commitSha === "command") return assertion.evidence.length === 0 && Boolean(assertion.assertedBy);
  const source = snapshots.get(snapshotKey(assertion.tenantId, assertion.repository, assertion.commitSha));
  return Boolean(source && assertion.evidence.length > 0 && assertionEvidenceIsCurrent(assertion, source, current));
}
function filePriority(path: string): number {
  if (/^README(?:\.|$)/i.test(path)) return 0;
  if (/^(docs?|src|app|packages)\//i.test(path)) return 1;
  if (isDocument(path)) return 2;
  return 3;
}
function isDocument(path: string): boolean {
  return /(?:^|\/)(?:README[^/]*|[^/]+\.(?:md|mdx|rst|txt))$/i.test(path);
}
function resolveImportPath(importer: string, specifier: string, paths: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  const stem = base.join("/");
  const candidates = [
    stem,
    ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs"].map((extension) => `${stem}.${extension}`),
    ...["ts", "tsx", "js", "jsx", "py"].map((extension) => `${stem}/index.${extension}`)
  ];
  return candidates.find((candidate) => paths.has(candidate));
}
